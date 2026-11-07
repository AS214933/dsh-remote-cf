import { createManualChecks } from './manual-check.mjs'
/**
 * Does the issued TURN credential actually work against Cloudflare's TURN service?
 *
 * The WebRTC test signs credentials and completes a call, but on one machine ICE
 * always picks a host candidate, so TURN is never exercised. That leaves the most
 * operational question unanswered: if a peer really is behind a symmetric NAT, will
 * the relay we hand out function?
 *
 * This forces the question by constructing a peer connection with the host candidate
 * type disabled, so the only way to connect is through the TURN server. If the
 * credential were malformed, expired, or pointed at the wrong realm, this fails.
 *
 *   npx tsx turn-relay.mjs <server-url> <email> <password>
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const [baseUrl, email, password] = process.argv.slice(2)
if (!baseUrl || !email || !password) {
  console.error('usage: npx tsx turn-relay.mjs <server-url> <email> <password>')
  process.exit(2)
}
const REPO = process.env.DSH_REPO
if (!REPO) { console.error('DSH_REPO must point at a ds-harness-remote checkout'); process.exit(2) }
const toUrl = p => `file://${p.replace(/\\/g, '/')}`

const { steps, ok, fail, check } = createManualChecks()

const { HostServerApi } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/server-api.ts')))
const { IdentityStore } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/identity-store.ts')))
const { ServerCredentialStore } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/server-credentials.ts')))
const require = createRequire(joinPath(REPO, 'package.json'))
const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate } = require('@roamhq/wrtc')

async function join(role, dir) {
  const store = new IdentityStore({ directory: dir })
  const identity = await store.loadOrCreate(`turn-${role}-${process.pid}`)
  const api = new HostServerApi(baseUrl, new ServerCredentialStore(dir), fetch, role)
  await api.authorizeWithAccount(identity, email, password)
  const credentials = await api.authenticate(identity)
  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws/v1/connect`)
  const frames = []
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('ws error')), { once: true })
  })
  socket.addEventListener('message', event => {
    try { frames.push(JSON.parse(String(event.data))) } catch { /* ignore */ }
  })
  socket.send(JSON.stringify({
    v: 1, id: randomUUID(), type: 'hello', timestamp: Date.now(),
    payload: {
      role, deviceId: identity.deviceId, accessToken: credentials.accessToken,
      protocols: [1], capabilities: ['transport.p2p', 'transport.turn', 'transport.relay'],
      clientVersion: '0.4.15',
    },
  }))
  const ack = await take(frames, 'hello.ack', 10_000)
  if (ack === null) throw new Error(`${role}: no hello.ack`)
  return { role, identity, api, socket, frames, send: (type, payload) => socket.send(JSON.stringify({ v: 1, id: randomUUID(), type, timestamp: Date.now(), payload })) }
}

async function take(frames, type, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const i = frames.findIndex(f => f.type === type)
    if (i >= 0) return frames.splice(i, 1)[0]
    if (Date.now() > deadline) return null
    await new Promise(r => setTimeout(r, 100))
  }
}

async function main() {
  const dir = mkdtempSync(joinPath(tmpdir(), 'dsh-turn-'))
  console.log(`server : ${baseUrl}\n`)

  const host = await join('host', joinPath(dir, 'host'))
  const client = await join('client', joinPath(dir, 'client'))
  ok('both peers online')

  client.send('connect.request', { hostDeviceId: host.identity.deviceId, preferredTransports: ['turn', 'p2p', 'relay'] })
  const incoming = await take(host.frames, 'connect.incoming', 10_000)
  if (incoming === null) { fail('connect.incoming'); return report() }
  host.send('connect.accepted', { connectionId: incoming.payload.connectionId })
  const accepted = await take(client.frames, 'connect.accepted', 10_000)
  if (accepted === null) { fail('connect.accepted'); return report() }
  const connectionId = accepted.payload.connectionId
  ok('link established', `transports=${JSON.stringify(incoming.payload.preferredTransports)}`)

  console.log('\n=== fetch TURN credentials from the server ===')
  const iceServers = await client.api.turnCredentials(connectionId)
  if (!Array.isArray(iceServers) || iceServers.length === 0) {
    fail('no TURN credentials issued', 'configure TURN_KEY_ID and TURN_KEY_API_TOKEN')
    return report()
  }
  ok('credentials issued', `${iceServers.length} server(s)`)
  for (const server of iceServers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
    ok('  server entry', `${urls.join(', ').slice(0, 90)}`)
    if (urls.some(url => typeof url === 'string' && /^turns?:/.test(url))) {
      check('  has TURN username', typeof server.username === 'string' && server.username.length > 0)
      check('  has TURN credential', typeof server.credential === 'string' && server.credential.length > 0)
    }
  }

  console.log('\n=== force TURN: host candidates disabled, so only relay can work ===')
  // `iceTransportPolicy: 'relay'` makes the agent gather only relayed candidates.
  // Any connection that forms therefore uses the TURN server, which is exactly the
  // situation a peer behind a symmetric NAT is in.
  const pcClient = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' })
  const pcHost = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' })
  ok('two peer connections with iceTransportPolicy=relay')

  // Subscribe before SDP negotiation: the datachannel event can precede client open.
  const hostChannelReady = new Promise(resolve => {
    pcHost.addEventListener('datachannel', event => resolve(event.channel), { once: true })
    setTimeout(() => resolve(null), 45_000)
  })
  const channel = pcClient.createDataChannel('turn-test', { ordered: true })
  const opened = new Promise(resolve => {
    channel.addEventListener('open', () => resolve(true))
    setTimeout(() => resolve(false), 45_000)
  })

  pcClient.addEventListener('icecandidate', event => {
    if (event.candidate === null) return
    client.send('signal.ice', {
      connectionId, targetDeviceId: host.identity.deviceId,
      candidate: {
        candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex, usernameFragment: event.candidate.usernameFragment,
      },
    })
  })
  pcHost.addEventListener('icecandidate', event => {
    if (event.candidate === null) return
    host.send('signal.ice', {
      connectionId, targetDeviceId: client.identity.deviceId,
      candidate: {
        candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex, usernameFragment: event.candidate.usernameFragment,
      },
    })
  })

  const offer = await pcClient.createOffer()
  await pcClient.setLocalDescription(offer)
  client.send('signal.offer', { connectionId, targetDeviceId: host.identity.deviceId, sdp: pcClient.localDescription.sdp })
  const offerFrame = await take(host.frames, 'signal.offer', 15_000)
  if (offerFrame === null) { fail('host received the offer'); return report() }
  await pcHost.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerFrame.payload.sdp }))
  const answer = await pcHost.createAnswer()
  await pcHost.setLocalDescription(answer)
  host.send('signal.answer', { connectionId, targetDeviceId: client.identity.deviceId, sdp: pcHost.localDescription.sdp })
  const answerFrame = await take(client.frames, 'signal.answer', 15_000)
  if (answerFrame === null) { fail('client received the answer'); return report() }
  await pcClient.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answerFrame.payload.sdp }))
  ok('SDP exchanged')

  // Relay candidates arrive asynchronously; keep feeding them in.
  const drain = async (peer, frames) => {
    for (let i = 0; i < 60; i += 1) {
      const index = frames.findIndex(f => f.type === 'signal.ice')
      if (index >= 0) {
        const [frame] = frames.splice(index, 1)
        try { await peer.addIceCandidate(new RTCIceCandidate(frame.payload.candidate)) } catch { /* stale */ }
        continue
      }
      await new Promise(r => setTimeout(r, 100))
    }
  }
  void drain(pcClient, client.frames)
  void drain(pcHost, host.frames)

  const isOpen = await opened
  if (!isOpen) {
    const stats = await pcClient.getStats?.()
    const candidates = [...(stats?.values?.() ?? [])].filter(r => r.type === 'local-candidate').map(r => r.candidateType)
    fail('data channel did not open over TURN', `candidates=${JSON.stringify([...new Set(candidates)])} state=${pcClient.connectionState}`)
    try { pcClient.close(); pcHost.close() } catch { /* ignore */ }
    return report()
  }
  ok('data channel open over TURN', `state=${pcClient.connectionState}`)

  const payload = `via turn ${randomUUID()}`
  // Attach the listener before the channel can fire; the `datachannel` event hands
  // over an already-usable channel, so a late attach would miss the message.
  const hostChannel = await hostChannelReady
  if (hostChannel === null) { fail('host never saw a data channel'); return report() }

  const arrived = new Promise(resolve => {
    hostChannel.addEventListener('message', event => resolve(String(event.data)))
    setTimeout(() => resolve(null), 15_000)
  })
  channel.send(payload)
  const got = await arrived
  check('payload relayed through TURN', got === payload,
    got === null ? 'timeout' : 'received data must match exactly')

  const stats = await pcClient.getStats?.()
  const localTypes = [...(stats?.values?.() ?? [])].filter(r => r.type === 'local-candidate').map(r => r.candidateType)
  check('only relayed candidates were gathered', localTypes.length > 0 && localTypes.every(type => type === 'relay'),
    JSON.stringify([...new Set(localTypes)]))

  try { pcClient.close(); pcHost.close(); client.socket.close(); host.socket.close() } catch { /* ignore */ }
  return report()
}

function report() {
  const failed = steps.filter(s => !s).length
  console.log(`\n${steps.length - failed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => { console.error('crashed:', error); process.exit(1) })
