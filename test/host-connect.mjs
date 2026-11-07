import { createManualChecks } from './manual-check.mjs'
/**
 * Connect the REAL Host plugin client to the Cloudflare Workers server.
 *
 * Uses the shipped classes from `packages/plugin/src` directly — the same code the
 * plugin runs — rather than re-implementing a client. That is the point: a protocol
 * or shape mismatch has to surface here, not in production.
 *
 * Layers exercised:
 *   1. `IdentityStore.loadOrCreate` — the plugin's own X25519 identity.
 *   2. `HostServerApi.authorizeWithAccount` — account login + device registration.
 *   3. `HostServerApi.authenticate` — the control-path credential load.
 *   4. `HostServerApi.listDevices` / `turnCredentials` — the read paths a host uses.
 *   5. The control WebSocket, sending the exact hello `server-connection.ts` sends.
 *
 * Run with tsx so the TypeScript sources import directly:
 *   npx tsx host-connect.mjs <server-url> <email> <password>
 */
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const [baseUrl, email, password] = process.argv.slice(2)
if (!baseUrl || !email || !password) {
  console.error('usage: npx tsx host-connect.mjs <server-url> <email> <password>')
  process.exit(2)
}

const REPO = process.env.DSH_REPO
if (!REPO) { console.error('DSH_REPO must point at a ds-harness-remote checkout'); process.exit(2) }
const toUrl = p => `file://${p.replaceAll('\\', '/')}`

const { steps, ok, fail, check } = createManualChecks()

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-host-'))
  mkdirSync(dir, { recursive: true })
  console.log(`server  : ${baseUrl}`)
  console.log(`account : ${email}`)
  console.log(`state   : ${dir}\n`)

  console.log('=== 1. load the shipped client ===')
  let HostServerApi, IdentityStore, ServerCredentialStore
  try {
    ;({ HostServerApi } = await import(toUrl(join(REPO, 'packages/plugin/src/server-api.ts'))))
    ;({ IdentityStore } = await import(toUrl(join(REPO, 'packages/plugin/src/identity-store.ts'))))
    ;({ ServerCredentialStore } = await import(toUrl(join(REPO, 'packages/plugin/src/server-credentials.ts'))))
    ok('loaded packages/plugin/src/{server-api,identity-store,server-credentials}')
  } catch (error) {
    fail('load plugin sources', error instanceof Error ? error.message : String(error))
    return report()
  }

  console.log('\n=== 2. host identity (plugin IdentityStore, real X25519) ===')
  let identity
  try {
    const store = new IdentityStore({ directory: dir })
    identity = await store.loadOrCreate(`cf-test-${process.pid}`)
    ok('identity created', `deviceId=${identity.deviceId}`)
    check('public key present', typeof identity.publicKey === 'string' && identity.publicKey.length > 0)
    check('local private key present', typeof identity.privateKey === 'string' && identity.privateKey.length > 0)
  } catch (error) {
    fail('IdentityStore.loadOrCreate', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    return report()
  }

  console.log('\n=== 3. account login + device registration (shipped HostServerApi) ===')
  const api = new HostServerApi(baseUrl, new ServerCredentialStore(dir), fetch, 'host')
  try {
    const authorization = await api.authorizeWithAccount(identity, email, password)
    ok('authorizeWithAccount', `method=${authorization.method}`)
    ok('registration accepted by the Worker', `account=${authorization.account ?? '(none)'}`)
  } catch (error) {
    fail('authorizeWithAccount', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    return report()
  }

  console.log('\n=== 4. control credential load (authenticate) ===')
  let credentials
  try {
    credentials = await api.authenticate(identity)
    check('authenticate returned an access token', typeof credentials.accessToken === 'string' && credentials.accessToken.length > 0)
    check('refresh token present', typeof credentials.refreshToken === 'string' && credentials.refreshToken.length > 0)
  } catch (error) {
    fail('authenticate', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    return report()
  }

  console.log('\n=== 5. read paths a host uses ===')
  try {
    const devices = await api.listDevices()
    ok('listDevices', `${devices.length} device(s)`)
  } catch (error) {
    // An arbitrary exception is not proof of a clean protocol response.
    const message = error instanceof Error ? error.message : String(error)
    fail('listDevices', message.slice(0, 70))
  }

  console.log('\n=== 6. control WebSocket: the exact hello server-connection.ts sends ===')
  const wsResult = await controlSession(baseUrl, identity, credentials)
  if (!wsResult.upgraded) {
    fail('websocket upgrade', wsResult.detail)
    return report()
  }
  ok('websocket upgrade')
  if (wsResult.ack === null) {
    fail('hello.ack', wsResult.detail)
    return report()
  }
  const ack = wsResult.ack
  ok('hello.ack received')
  check('protocol version', ack.protocol === 1, String(ack.protocol))
  check('heartbeat interval', Number.isFinite(ack.heartbeatIntervalMs) && ack.heartbeatIntervalMs > 0, `${ack.heartbeatIntervalMs}ms`)
  check('relay frame cap', Number.isFinite(ack.maxRelayFrameBytes) && ack.maxRelayFrameBytes > 0, `${ack.maxRelayFrameBytes}B`)
  check('negotiated capabilities', Array.isArray(ack.capabilities) && ack.capabilities.includes('transport.relay'))
  check('webrtc availability field', typeof ack.webrtcEnabled === 'boolean')

  console.log('\n=== 7. heartbeat: answer one server ping ===')
  const beat = await answerOnePing(wsResult.socket)
  check('server sent a ping within the window', beat.pinged, beat.detail)

  return report()
}

/**
 * Open the control socket and send the hello frame.
 *
 * Mirrors `server-connection.ts`: the same field set, the same capability list, the
 * same access token source. The surrounding object graph needs a Harness runtime, so
 * only the framing is reproduced — but the bytes match.
 */
async function controlSession(base, identity, credentials) {
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/v1/connect`)
  let ack = null
  let closeCode = null
  socket.addEventListener('message', event => {
    let frame = null
    try { frame = JSON.parse(String(event.data)) } catch { return }
    if (frame?.type === 'hello.ack') ack = frame.payload
  })
  socket.addEventListener('close', event => { closeCode = event.code })

  const upgraded = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 10_000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(true) }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); resolve(false) }, { once: true })
  })
  if (!upgraded) return { upgraded: false, detail: `close=${closeCode}` }

  socket.send(JSON.stringify({
    v: 1,
    id: randomUUID(),
    type: 'hello',
    timestamp: Date.now(),
    payload: {
      role: 'host',
      deviceId: identity.deviceId,
      accessToken: credentials.accessToken,
      protocols: [1],
      capabilities: ['transport.relay'],
      clientVersion: '0.4.15',
    },
  }))

  const deadline = Date.now() + 10_000
  while (ack === null && Date.now() < deadline && socket.readyState === 1) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return { upgraded: true, ack, detail: ack === null ? `no ack, close=${closeCode}` : '', socket }
}

/** Answer the first ping and report whether one arrived. */
async function answerOnePing(socket) {
  if (!socket || socket.readyState !== 1) return { pinged: false, detail: 'socket not open' }
  let pinged = false
  socket.addEventListener('message', event => {
    let frame = null
    try { frame = JSON.parse(String(event.data)) } catch { return }
    if (frame?.type !== 'ping') return
    pinged = true
    socket.send(JSON.stringify({
      v: 1, id: randomUUID(), type: 'pong', timestamp: Date.now(),
      payload: { nonce: frame.payload.nonce },
    }))
  })
  // The advertised interval is 25 s; allow one beat plus slack.
  const deadline = Date.now() + 32_000
  while (!pinged && Date.now() < deadline && socket.readyState === 1) {
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  const state = socket.readyState
  try { socket.close() } catch { /* already closed */ }
  return { pinged, detail: pinged ? 'answered, socket still open' : `readyState=${state}` }
}

function report() {
  const failed = steps.filter(s => !s).length
  console.log(`\n${steps.length - failed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => { console.error('crashed:', error); process.exit(1) })
