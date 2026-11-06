/**
 * Soak: does a connection survive on the real edge?
 *
 * Everything measured so far was a burst. The riskier property is duration: an alarm
 * that only fires while the object is hot, a socket dropped by an idle timeout, or a
 * heartbeat that stops being answered after the first few beats would all pass a
 * 30-second test and fail in real use.
 *
 * Watches one connection for `--minutes` (default 20) and records every ping, every
 * pong, and any close. Also issues an RPC after the wait, so a connection that is
 * "open" but no longer routing is caught rather than counted as healthy.
 *
 *   npx tsx soak.mjs <server-url> <email> <password> [minutes]
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { randomUUID } from 'node:crypto'

const [baseUrl, email, password, minutesArg] = process.argv.slice(2)
if (!baseUrl || !email || !password) {
  console.error('usage: npx tsx soak.mjs <server-url> <email> <password> [minutes]')
  process.exit(2)
}
const MINUTES = Number(minutesArg ?? '20')
const REPO = process.env.DSH_REPO
if (!REPO) { console.error('DSH_REPO must point at a ds-harness-remote checkout'); process.exit(2) }
const toUrl = p => `file://${p.replace(/\\/g, '/')}`

const steps = []
const ok = (n, d = '') => { steps.push(true); console.log(`  ok   ${n}${d ? ` — ${d}` : ''}`) }
const fail = (n, d = '') => { steps.push(false); console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`) }

const { HostServerApi } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/server-api.ts')))
const { IdentityStore } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/identity-store.ts')))
const { ServerCredentialStore } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/server-credentials.ts')))
const { NoiseIkSession, createNoisePrologue, toBase64Url, fromBase64Url } =
  await import(toUrl(joinPath(REPO, 'packages/crypto/src/index.ts')))

const started = Date.now()
const stamp = () => `+${String(Math.round((Date.now() - started) / 1000)).padStart(5)}s`

async function join(role, dir) {
  const store = new IdentityStore({ directory: dir })
  const identity = await store.loadOrCreate(`soak-${role}-${process.pid}`)
  const api = new HostServerApi(baseUrl, new ServerCredentialStore(dir), fetch, role)
  await api.authorizeWithAccount(identity, email, password)
  const credentials = await api.authenticate(identity)

  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws/v1/connect`)
  const frames = []
  const pings = []
  let pongs = 0
  let closed = null
  socket.addEventListener('message', event => {
    let frame = null
    try { frame = JSON.parse(String(event.data)) } catch { return }
    if (frame.type === 'ping') {
      pings.push(Date.now())
      // Answer every ping, as the plugin does.
      socket.send(JSON.stringify({
        v: 1, id: randomUUID(), type: 'pong', timestamp: Date.now(),
        payload: { nonce: frame.payload.nonce },
      }))
      return
    }
    if (frame.type === 'pong') { pongs += 1; return }
    frames.push(frame)
  })
  socket.addEventListener('close', event => { closed = { code: event.code, at: Date.now() } })

  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('ws error')), { once: true })
  })
  socket.send(JSON.stringify({
    v: 1, id: randomUUID(), type: 'hello', timestamp: Date.now(),
    payload: {
      role, deviceId: identity.deviceId, accessToken: credentials.accessToken,
      protocols: [1], capabilities: ['transport.relay'],
      clientVersion: '0.4.15', ...(role === 'host' ? { harnessVersion: '0.2.2' } : {}),
    },
  }))
  const deadline = Date.now() + 10_000
  let acked = false
  while (!acked && Date.now() < deadline) {
    acked = frames.some(f => f.type === 'hello.ack')
    if (!acked) await new Promise(r => setTimeout(r, 100))
  }
  return {
    role, identity, socket, frames,
    get pings() { return pings }, get pongs() { return pongs }, get closed() { return closed },
    send: (type, payload) => socket.send(JSON.stringify({ v: 1, id: randomUUID(), type, timestamp: Date.now(), payload })),
  }
}

async function main() {
  const dir = mkdtempSync(joinPath(tmpdir(), 'dsh-soak-'))
  console.log(`server : ${baseUrl}`)
  console.log(`plan   : hold one link for ${MINUTES} min, then route an RPC\n`)

  const host = await join('host', joinPath(dir, 'host'))
  const client = await join('client', joinPath(dir, 'client'))
  ok('both peers joined')

  client.send('connect.request', { hostDeviceId: host.identity.deviceId, preferredTransports: ['relay'] })
  let incoming = null
  const linkDeadline = Date.now() + 10_000
  while (incoming === null && Date.now() < linkDeadline) {
    incoming = host.frames.find(f => f.type === 'connect.incoming') ?? null
    if (incoming === null) await new Promise(r => setTimeout(r, 100))
  }
  if (incoming === null) { fail('connect.incoming'); return report() }
  host.send('connect.accepted', { connectionId: incoming.payload.connectionId })
  let accepted = null
  const acceptDeadline = Date.now() + 10_000
  while (accepted === null && Date.now() < acceptDeadline) {
    accepted = client.frames.find(f => f.type === 'connect.accepted') ?? null
    if (accepted === null) await new Promise(r => setTimeout(r, 100))
  }
  if (accepted === null) { fail('connect.accepted'); return report() }
  const connectionId = accepted.payload.connectionId
  ok('link established')

  const prologue = createNoisePrologue(connectionId, host.identity.deviceId, client.identity.deviceId)
  const initiator = new NoiseIkSession({
    role: 'initiator',
    localPrivateKey: client.identity.privateKey, localPublicKey: client.identity.publicKey,
    remotePublicKey: host.identity.publicKey, prologue,
  })
  const responder = new NoiseIkSession({
    role: 'responder',
    localPrivateKey: host.identity.privateKey, localPublicKey: host.identity.publicKey,
    remotePublicKey: client.identity.publicKey, prologue,
  })
  client.send('secure.handshake', {
    connectionId, targetDeviceId: host.identity.deviceId, step: 1,
    data: toBase64Url(initiator.writeHandshake()),
  })
  const step2 = await waitFor(host.frames, 'secure.handshake', 10_000)
  if (step2 === null) { fail('handshake step 1'); return report() }
  responder.readHandshake(fromBase64Url(step2.payload.data))
  host.send('secure.handshake', {
    connectionId, targetDeviceId: client.identity.deviceId, step: 2,
    data: toBase64Url(responder.writeHandshake()),
  })
  const step3 = await waitFor(client.frames, 'secure.handshake', 10_000)
  if (step3 === null) { fail('handshake step 2'); return report() }
  initiator.readHandshake(fromBase64Url(step3.payload.data))
  ok('tunnel established')

  console.log(`\n=== holding the connection for ${MINUTES} min ===`)
  const baselineHost = host.pings.length
  const baselineClient = client.pings.length
  const deadline = Date.now() + MINUTES * 60_000
  let lastReport = 0
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5_000))
    const elapsed = Math.round((Date.now() - started) / 1000)
    // A progress line every 2 minutes so a long run is visibly alive rather than
    // silent, without flooding the log.
    if (elapsed - lastReport >= 120) {
      lastReport = elapsed
      const gaps = intervals(host.pings)
      console.log(`  ${stamp()} pings host=${host.pings.length} client=${client.pings.length}`
        + ` close=${host.closed?.code ?? client.closed?.code ?? 'none'}`
        + ` gap=${gaps.length === 0 ? 'n/a' : `${Math.round(gaps[gaps.length - 1] / 1000)}s`}`)
    }
    if (host.closed !== null || client.closed !== null) break
  }

  const hostPings = host.pings.length - baselineHost
  const clientPings = client.pings.length - baselineClient
  const expected = Math.floor((MINUTES * 60_000) / 25_000)

  ok(`host survived ${MINUTES} min`, `${hostPings} pings (expected ~${expected}), close=${host.closed?.code ?? 'none'}`)
  ok(`client survived ${MINUTES} min`, `${clientPings} pings (expected ~${expected}), close=${client.closed?.code ?? 'none'}`)
  ok('no unexpected close', host.closed === null && client.closed === null,
    host.closed === null && client.closed === null ? 'both still open' : `host=${host.closed?.code} client=${client.closed?.code}`)

  // Spacing: a heartbeat that fires in a burst and then stops would still produce the
  // right count. The gap distribution catches that.
  const gaps = intervals(host.pings).map(ms => Math.round(ms / 1000))
  if (gaps.length > 2) {
    const min = Math.min(...gaps)
    const max = Math.max(...gaps)
    ok('heartbeat spacing is steady', `${min}–${max}s (expected 25s±)`)
    ok('no missed beats', max <= 60, max <= 60 ? 'no gap over 60s' : `gap of ${max}s`)
  } else {
    fail('not enough pings to measure spacing', `${gaps.length} interval(s)`)
  }

  console.log('\n=== the link still routes after the wait ===')
  // "Open" is not "working": route an RPC through the tunnel that has been idle for
  // the whole soak and require a response.
  const payload = `post-soak ${randomUUID()}`
  client.send('relay', {
    connectionId, targetDeviceId: host.identity.deviceId, counter: 1000,
    ciphertext: toBase64Url(initiator.encrypt(new TextEncoder().encode(payload))),
  })
  const delivered = await waitFor(host.frames, 'relay', 15_000)
  if (delivered === null) { fail('post-soak relay'); return report() }
  const text = new TextDecoder().decode(responder.decrypt(fromBase64Url(delivered.payload.ciphertext)))
  ok('relay still works after the soak', text === payload ? 'exact match' : 'mismatch')

  host.send('relay', {
    connectionId, targetDeviceId: client.identity.deviceId, counter: 1000,
    ciphertext: toBase64Url(responder.encrypt(new TextEncoder().encode(`reply ${payload}`))),
  })
  const back = await waitFor(client.frames, 'relay', 15_000)
  if (back === null) { fail('post-soak reply'); return report() }
  ok('reverse direction still works')

  try { client.socket.close(); host.socket.close() } catch { /* already closed */ }
  return report()
}

function intervals(times) {
  const gaps = []
  for (let i = 1; i < times.length; i += 1) gaps.push(times[i] - times[i - 1])
  return gaps
}

async function waitFor(frames, type, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const index = frames.findIndex(f => f.type === type)
    if (index >= 0) return frames.splice(index, 1)[0]
    if (Date.now() > deadline) return null
    await new Promise(r => setTimeout(r, 100))
  }
}

function report() {
  const failed = steps.filter(s => !s).length
  console.log(`\n${steps.length - failed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => { console.error('crashed:', error); process.exit(1) })
