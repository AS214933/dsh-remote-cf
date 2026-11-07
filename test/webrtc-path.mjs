import { createManualChecks } from './manual-check.mjs'
/**
 * WebRTC data channel through the server's signaling path.
 *
 * The relay tests prove the fallback transports work. This proves the negotiated
 * path: two peers exchange SDP through the server, bring up a real data channel, and
 * send application data over it while the server only relays signaling.
 *
 * Uses `@roamhq/wrtc` — a real native WebRTC stack, the same one the plugin uses on
 * Node — rather than a mock, so ICE, DTLS and SCTP are all genuine.
 *
 * Two scenarios:
 *   1. host candidates only (loopback / same host) — the p2p path
 *   2. a TURN-configured run, if TURN credentials are available
 *
 *   npx tsx webrtc-path.mjs <server-url> <email> <password>
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const [baseUrl, email, password] = process.argv.slice(2)
if (!baseUrl || !email || !password) {
  console.error('usage: npx tsx webrtc-path.mjs <server-url> <email> <password>')
  process.exit(2)
}

const REPO = process.env.DSH_REPO
if (!REPO) {
  console.error('DSH_REPO must point at a ds-harness-remote checkout')
  process.exit(2)
}
const toUrl = p => `file://${p.replace(/\\/g, '/')}`

const { steps, ok, fail, check } = createManualChecks()
const skip = (n, d = '') => { console.log(`  skip ${n}${d ? ` — ${d}` : ''}`) }

const { HostServerApi } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/server-api.ts')))
const { IdentityStore } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/identity-store.ts')))
const { ServerCredentialStore } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/server-credentials.ts')))

// A real native WebRTC implementation, not a stub.
let wrtc
try {
  const require = createRequire(joinPath(REPO, 'package.json'))
  wrtc = require('@roamhq/wrtc')
} catch (error) {
  console.error('could not load @roamhq/wrtc:', error instanceof Error ? error.message : error)
  process.exit(2)
}
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = wrtc

async function join(role, dir) {
  const store = new IdentityStore({ directory: dir })
  const identity = await store.loadOrCreate(`rtc-${role}-${process.pid}`)
  const api = new HostServerApi(baseUrl, new ServerCredentialStore(dir), fetch, role)
  await api.authorizeWithAccount(identity, email, password)
  const credentials = await api.authenticate(identity)

  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws/v1/connect`)
  const frames = []
  const waiters = []
  socket.addEventListener('message', event => {
    let frame = null
    try { frame = JSON.parse(String(event.data)) } catch { return }
    frames.push(frame)
    for (const wake of waiters.splice(0)) wake()
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('ws error')), { once: true })
  })
  socket.send(JSON.stringify({
    v: 1, id: randomUUID(), type: 'hello', timestamp: Date.now(),
    payload: {
      role, deviceId: identity.deviceId, accessToken: credentials.accessToken,
      protocols: [1], capabilities: ['transport.p2p', 'transport.turn', 'transport.relay'],
      clientVersion: '0.4.15',
    },
  }))
  const ack = await take(frames, waiters, 'hello.ack', 10_000)
  if (ack === null) throw new Error(`${role}: no hello.ack`)
  return {
    role, identity, api, socket, frames, waiters,
    send: (type, payload) => socket.send(JSON.stringify({ v: 1, id: randomUUID(), type, timestamp: Date.now(), payload })),
  }
}

async function take(frames, waiters, type, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const index = frames.findIndex(f => f.type === type)
    if (index >= 0) return frames.splice(index, 1)[0]
    if (Date.now() > deadline) return null
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 100)
      waiters.push(() => { clearTimeout(timer); resolve() })
    })
  }
}

async function main() {
  const dir = mkdtempSync(joinPath(tmpdir(), 'dsh-rtc-'))
  console.log(`server : ${baseUrl}`)
  console.log(`state  : ${dir}\n`)

  console.log('=== 1. peers join with webrtc capabilities ===')
  const host = await join('host', joinPath(dir, 'host'))
  const client = await join('client', joinPath(dir, 'client'))
  ok('host online', host.identity.deviceId)
  ok('client online', client.identity.deviceId)

  console.log('\n=== 2. connect with p2p preferred ===')
  client.send('connect.request', {
    hostDeviceId: host.identity.deviceId,
    preferredTransports: ['p2p', 'relay'],
  })
  const incoming = await take(host.frames, host.waiters, 'connect.incoming', 10_000)
  if (incoming === null) { fail('connect.incoming'); return report() }
  ok('host received connect.incoming', `transports=${JSON.stringify(incoming.payload.preferredTransports)}`)
  const negotiated = incoming.payload.preferredTransports
  check('p2p was negotiated', Array.isArray(negotiated) && negotiated.includes('p2p'))

  host.send('connect.accepted', { connectionId: incoming.payload.connectionId })
  const accepted = await take(client.frames, client.waiters, 'connect.accepted', 10_000)
  if (accepted === null) { fail('connect.accepted'); return report() }
  const connectionId = accepted.payload.connectionId
  ok('client received connect.accepted')

  console.log('\n=== 3. real RTCPeerConnection + data channel ===')
  const iceServers = []
  // Ask the server for TURN credentials the way a client does; an empty list means
  // Relay-only, which is a valid deployment.
  try {
    const turn = await client.api.turnCredentials(connectionId)
    if (Array.isArray(turn) && turn.length > 0) { iceServers.push(...turn); ok('server issued TURN credentials', `${turn.length} server(s)`) }
    else skip('server issued no TURN credentials', 'Relay/P2P only deployment')
  } catch (error) {
    skip('turnCredentials', error instanceof Error ? error.message.slice(0, 60) : '')
  }

  const pcClient = new RTCPeerConnection({ iceServers })
  const pcHost = new RTCPeerConnection({ iceServers })
  ok('two RTCPeerConnections created', iceServers.length > 0 ? 'with TURN' : 'host candidates only')

  const channel = pcClient.createDataChannel('dsh-test', { ordered: true })
  const channelOpen = new Promise(resolve => {
    channel.addEventListener('open', () => resolve(true))
    setTimeout(() => resolve(false), 30_000)
  })

  const hostChannel = new Promise(resolve => {
    pcHost.addEventListener('datachannel', event => resolve(event.channel))
    setTimeout(() => resolve(null), 30_000)
  })

  // Trickle ICE both ways, relayed by the server.
  pcClient.addEventListener('icecandidate', event => {
    if (event.candidate === null) return
    client.send('signal.ice', {
      connectionId, targetDeviceId: host.identity.deviceId,
      candidate: {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        usernameFragment: event.candidate.usernameFragment,
      },
    })
  })
  pcHost.addEventListener('icecandidate', event => {
    if (event.candidate === null) return
    host.send('signal.ice', {
      connectionId, targetDeviceId: client.identity.deviceId,
      candidate: {
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        usernameFragment: event.candidate.usernameFragment,
      },
    })
  })

  // The offer goes client -> host, the answer host -> client.
  const offer = await pcClient.createOffer()
  await pcClient.setLocalDescription(offer)
  client.send('signal.offer', {
    connectionId, targetDeviceId: host.identity.deviceId, sdp: pcClient.localDescription.sdp,
  })
  const offerFrame = await take(host.frames, host.waiters, 'signal.offer', 15_000)
  if (offerFrame === null) { fail('host received the offer'); return report() }
  ok('host received the SDP offer', `${offerFrame.payload.sdp.length} chars`)

  await pcHost.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerFrame.payload.sdp }))
  const answer = await pcHost.createAnswer()
  await pcHost.setLocalDescription(answer)
  host.send('signal.answer', {
    connectionId, targetDeviceId: client.identity.deviceId, sdp: pcHost.localDescription.sdp,
  })
  const answerFrame = await take(client.frames, client.waiters, 'signal.answer', 15_000)
  if (answerFrame === null) { fail('client received the answer'); return report() }
  ok('client received the SDP answer', `${answerFrame.payload.sdp.length} chars`)
  await pcClient.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answerFrame.payload.sdp }))

  // Drain relayed ICE candidates into both peers.
  const pump = async (peer, frames, waiters) => {
    for (let i = 0; i < 40; i += 1) {
      const frame = frames.findIndex(f => f.type === 'signal.ice')
      if (frame < 0) { await new Promise(r => setTimeout(r, 100)); continue }
      const [taken] = frames.splice(frame, 1)
      try { await peer.addIceCandidate(new RTCIceCandidate(taken.payload.candidate)) } catch { /* stale */ }
    }
  }
  void pump(pcClient, client.frames, client.waiters)
  void pump(pcHost, host.frames, host.waiters)

  const opened = await channelOpen
  if (!opened) {
    const state = { client: pcClient.connectionState, host: pcHost.connectionState, ice: pcClient.iceConnectionState }
    fail('data channel opened', JSON.stringify(state))
    try { pcClient.close(); pcHost.close() } catch { /* ignore */ }
    return report()
  }
  ok('data channel open', `state=${pcClient.connectionState}`)

  console.log('\n=== 4. application data over the data channel ===')
  const payload = `over webrtc ${randomUUID()}`
  const received = new Promise(resolve => {
    hostChannel.then(ch => ch?.addEventListener('message', event => resolve(String(event.data))))
    setTimeout(() => resolve(null), 15_000)
  })
  channel.send(payload)
  const got = await received
  check('host received the payload over WebRTC', got === payload,
    got === null ? 'timeout' : 'received data must match exactly')

  console.log('\n=== 5. report the selected path ===')
  const pair = pcClient.getStats === undefined ? null : await pcClient.getStats?.()
  let selected = 'unknown'
  if (pair !== null) {
    for (const report of pair.values()) {
      if (report.type === 'candidate-pair' && (report.selected || report.state === 'succeeded')) {
        selected = report.state ?? 'succeeded'
      }
    }
  }
  const localCandidate = [...(pair?.values?.() ?? [])].find(r => r.type === 'local-candidate')
  check('ICE completed', pcClient.iceConnectionState === 'connected' || pcClient.iceConnectionState === 'completed',
    `state=${pcClient.iceConnectionState}, pair=${selected}, candidateType=${localCandidate?.candidateType ?? 'n/a'}`)

  // Tell the server which transport won, as the clients do.
  client.send('transport.selected', {
    connectionId, targetDeviceId: host.identity.deviceId,
    transport: 'p2p',
  })
  const selectedFrame = await take(host.frames, host.waiters, 'transport.selected', 8_000)
  check('transport.selected relayed unchanged', selectedFrame?.payload?.transport === 'p2p',
    selectedFrame === null ? 'host did not see it' : String(selectedFrame.payload.transport))

  try { pcClient.close(); pcHost.close(); client.socket.close(); host.socket.close() } catch { /* ignore */ }
  return report()
}

function report() {
  const failed = steps.filter(s => !s).length
  console.log(`\n${steps.length - failed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => { console.error('crashed:', error); process.exit(1) })
