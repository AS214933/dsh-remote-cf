import { createManualChecks } from './manual-check.mjs'
/**
 * End-to-end: an RPC call from client to host through the server, inside the tunnel.
 *
 * This is the shape of every real interaction. The UI's control endpoints
 * (`directory.list`, `workspaces.list`, `codex.call`, …) are `rpc.request` messages
 * carried **inside the Noise tunnel**, not gateway frames — the server forwards them
 * as opaque ciphertext and must never parse them.
 *
 * This verifies that matching RPC payloads cross the encrypted relay in both
 * directions. It checks for literal marker/method leakage in the received frame;
 * it does not inspect server logs or prove the absence of all decryption paths.
 *
 *   npx tsx rpc-tunnel.mjs <server-url> <email> <password>
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { randomUUID } from 'node:crypto'

const [baseUrl, email, password] = process.argv.slice(2)
if (!baseUrl || !email || !password) {
  console.error('usage: npx tsx rpc-tunnel.mjs <server-url> <email> <password>')
  process.exit(2)
}
const REPO = process.env.DSH_REPO
if (!REPO) { console.error('DSH_REPO must point at a ds-harness-remote checkout'); process.exit(2) }
const toUrl = p => `file://${p.replace(/\\/g, '/')}`

const { steps, ok, fail, check } = createManualChecks()

const { HostServerApi } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/server-api.ts')))
const { IdentityStore } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/identity-store.ts')))
const { ServerCredentialStore } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/server-credentials.ts')))
const { NoiseIkSession, createNoisePrologue, toBase64Url, fromBase64Url } =
  await import(toUrl(joinPath(REPO, 'packages/crypto/src/index.ts')))

async function join(role, dir) {
  const store = new IdentityStore({ directory: dir })
  const identity = await store.loadOrCreate(`rpc-${role}-${process.pid}`)
  const api = new HostServerApi(baseUrl, new ServerCredentialStore(dir), fetch, role)

  // The plugin's own two-step sign-in: account login, then the Host claims the
  // account. Doing it here means the test exercises the same registration the UI does.
  await api.authorizeWithAccount(identity, email, password)
  if (role === 'host') {
    const credentials = await api.authenticate(identity)
    await api.authorizeOwnedRole(identity, credentials.accessToken, credentials.account)
  }
  const credentials = await api.authenticate(identity)

  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws/v1/connect`)
  const frames = []
  socket.addEventListener('message', event => {
    try { frames.push(JSON.parse(String(event.data))) } catch { /* ignore */ }
  })
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
  const ack = await take(frames, 'hello.ack', 10_000)
  if (ack === null) throw new Error(`${role}: no hello.ack`)
  return {
    role, identity, frames,
    send: (type, payload) => socket.send(JSON.stringify({ v: 1, id: randomUUID(), type, timestamp: Date.now(), payload })),
  }
}

async function take(frames, type, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const index = frames.findIndex(f => f.type === type)
    if (index >= 0) return frames.splice(index, 1)[0]
    if (Date.now() > deadline) return null
    await new Promise(r => setTimeout(r, 100))
  }
}

async function main() {
  const dir = mkdtempSync(joinPath(tmpdir(), 'dsh-rpc-'))
  console.log(`server : ${baseUrl}\n`)

  const host = await join('host', joinPath(dir, 'host'))
  const client = await join('client', joinPath(dir, 'client'))
  ok('host and client online')

  client.send('connect.request', { hostDeviceId: host.identity.deviceId, preferredTransports: ['relay'] })
  const incoming = await take(host.frames, 'connect.incoming', 10_000)
  if (incoming === null) { fail('connect.incoming'); return report() }
  host.send('connect.accepted', { connectionId: incoming.payload.connectionId })
  const accepted = await take(client.frames, 'connect.accepted', 10_000)
  if (accepted === null) { fail('connect.accepted'); return report() }
  const connectionId = accepted.payload.connectionId

  console.log('\n=== noise tunnel ===')
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
  const step2 = await take(host.frames, 'secure.handshake', 10_000)
  if (step2 === null) { fail('handshake step 1'); return report() }
  responder.readHandshake(fromBase64Url(step2.payload.data))
  host.send('secure.handshake', {
    connectionId, targetDeviceId: client.identity.deviceId, step: 2,
    data: toBase64Url(responder.writeHandshake()),
  })
  const step3 = await take(client.frames, 'secure.handshake', 10_000)
  if (step3 === null) { fail('handshake step 2'); return report() }
  initiator.readHandshake(fromBase64Url(step3.payload.data))
  ok('tunnel established')

  console.log('\n=== rpc.request through the tunnel ===')
  // The exact shape the plugin's RpcRouter receives: a `rpc.request` message with a
  // method and params, wrapped as an inner message by the tunnel layer.
  const requestId = randomUUID()
  const rpcRequest = {
    v: 1,
    id: requestId,
    type: 'rpc.request',
    timestamp: Date.now(),
    payload: { method: 'directory.list', params: { path: '~', marker: 'PLAINTEXT-MARKER-SHOULD-NEVER-APPEAR-IN-LOGS' } },
  }
  const sealed = initiator.encrypt(new TextEncoder().encode(JSON.stringify(rpcRequest)))
  let counter = 1
  client.send('relay', {
    connectionId, targetDeviceId: host.identity.deviceId, counter: counter++,
    ciphertext: toBase64Url(sealed),
  })
  const delivered = await take(host.frames, 'relay', 10_000)
  if (delivered === null) { fail('rpc.request relayed'); return report() }
  ok('rpc.request reached the host', `${delivered.payload.ciphertext.length} chars ciphertext`)

  // The server must not have been able to read it: the ciphertext is base64url and
  // contains no recognisable plaintext.
  const rawCiphertext = delivered.payload.ciphertext
  const leaked = rawCiphertext.includes('PLAINTEXT') || rawCiphertext.includes('directory.list')
  check('relayed ciphertext contains no literal marker or method', !leaked,
    'literal-marker check only; not proof about every server log or decryption capability')

  const opened = new TextDecoder().decode(responder.decrypt(fromBase64Url(rawCiphertext)))
  const received = JSON.parse(opened)
  check('host decrypted the RPC request', received.type === 'rpc.request' && received.id === requestId
    && received.payload?.method === 'directory.list')
  check('params survived intact', received.payload?.params?.marker === 'PLAINTEXT-MARKER-SHOULD-NEVER-APPEAR-IN-LOGS')

  console.log('\n=== rpc.response back through the tunnel ===')
  const rpcResponse = {
    v: 1,
    id: received.id,
    type: 'rpc.response',
    timestamp: Date.now(),
    payload: { requestId, result: { entries: [{ name: 'src', kind: 'directory' }] } },
  }
  host.send('relay', {
    connectionId, targetDeviceId: client.identity.deviceId, counter: counter++,
    ciphertext: toBase64Url(responder.encrypt(new TextEncoder().encode(JSON.stringify(rpcResponse)))),
  })
  const back = await take(client.frames, 'relay', 10_000)
  if (back === null) { fail('rpc.response relayed'); return report() }
  const answered = JSON.parse(new TextDecoder().decode(initiator.decrypt(fromBase64Url(back.payload.ciphertext))))
  check('client decrypted the matching RPC response', answered.type === 'rpc.response' && answered.id === requestId
    && answered.payload?.requestId === requestId)
  check('result arrived intact', JSON.stringify(answered.payload?.result) === JSON.stringify(rpcResponse.payload.result))

  console.log('\nThis script sent RPC objects only inside encrypted relay payloads.')
  console.log('Server log inspection and inability-to-decrypt are separate review claims, not a test assertion here.')

  try { client.frames.length = 0; host.frames.length = 0 } catch { /* ignore */ }
  return report()
}

function report() {
  const failed = steps.filter(s => !s).length
  console.log(`\n${steps.length - failed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => { console.error('crashed:', error); process.exit(1) })
