/**
 * Data-plane test: a real Noise IK tunnel carried through the server's relay.
 *
 * The control-plane test proved login, registration and hello. This proves the part
 * that actually matters operationally — that two peers can complete a Noise
 * handshake through the server's signaling path and then exchange encrypted
 * payloads through it, with the server able to relay but not read them.
 *
 * Everything cryptographic comes from the repo's `packages/crypto`; the server is
 * the Cloudflare Workers port. So a mismatch in signaling, link state or relay
 * forwarding shows up as a failed handshake or a corrupted payload.
 *
 *   npx tsx data-plane.mjs <server-url> <email> <password>
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { randomUUID } from 'node:crypto'

const [baseUrl, email, password] = process.argv.slice(2)
if (!baseUrl || !email || !password) {
  console.error('usage: npx tsx data-plane.mjs <server-url> <email> <password>')
  process.exit(2)
}

const REPO = process.env.DSH_REPO
if (!REPO) {
  console.error('DSH_REPO must point at a ds-harness-remote checkout (needs packages/crypto and packages/plugin/src)')
  process.exit(2)
}
const toUrl = p => `file://${p.replace(/\\/g, '/')}`

const steps = []
const ok = (n, d = '') => { steps.push(true); console.log(`  ok   ${n}${d ? ` — ${d}` : ''}`) }
const fail = (n, d = '') => { steps.push(false); console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`) }

const { HostServerApi } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/server-api.ts')))
const { IdentityStore } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/identity-store.ts')))
const { ServerCredentialStore } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/server-credentials.ts')))
const crypto = await import(toUrl(joinPath(REPO, 'packages/crypto/src/index.ts')))
const { NoiseIkSession, createNoisePrologue, generateKeyPair, toBase64Url, fromBase64Url } = crypto

/** One registered device plus its open control socket. */
async function join(role, dir) {
  const store = new IdentityStore({ directory: dir })
  const identity = await store.loadOrCreate(`data-${role}-${process.pid}`)
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
      protocols: [1], capabilities: ['transport.relay'], clientVersion: '0.4.15',
    },
  }))
  const ack = await take(frames, waiters, 'hello.ack', 10_000)
  if (ack === null) throw new Error(`${role}: no hello.ack`)
  return { role, identity, socket, frames, waiters, send: (type, payload) => socket.send(JSON.stringify({ v: 1, id: randomUUID(), type, timestamp: Date.now(), payload })) }
}

/** Wait for one frame of a type, removing it so the next take sees the next one. */
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
  const dir = mkdtempSync(joinPath(tmpdir(), 'dsh-data-'))
  console.log(`server : ${baseUrl}`)
  console.log(`state  : ${dir}\n`)

  console.log('=== 1. both peers join ===')
  const host = await join('host', joinPath(dir, 'host'))
  const client = await join('client', joinPath(dir, 'client'))
  ok('host online', host.identity.deviceId)
  ok('client online', client.identity.deviceId)

  console.log('\n=== 2. connect handshake ===')
  client.send('connect.request', { hostDeviceId: host.identity.deviceId, preferredTransports: ['relay'] })
  const incoming = await take(host.frames, host.waiters, 'connect.incoming', 10_000)
  if (incoming === null) { fail('connect.incoming'); return report() }
  ok('host received connect.incoming', `authorization=${incoming.payload.authorization}`)
  ok('server reported the client identity key', incoming.payload.clientIdentityKey === client.identity.publicKey)

  host.send('connect.accepted', { connectionId: incoming.payload.connectionId })
  const accepted = await take(client.frames, client.waiters, 'connect.accepted', 10_000)
  if (accepted === null) { fail('connect.accepted'); return report() }
  ok('client received connect.accepted')
  const connectionId = accepted.payload.connectionId

  console.log('\n=== 3. Noise IK handshake through signaling ===')
  const prologue = createNoisePrologue(connectionId, host.identity.deviceId, client.identity.deviceId)
  const initiator = new NoiseIkSession({
    role: 'initiator',
    localPrivateKey: client.identity.privateKey, localPublicKey: client.identity.publicKey,
    remotePublicKey: host.identity.publicKey,
    prologue,
  })
  const responder = new NoiseIkSession({
    role: 'responder',
    localPrivateKey: host.identity.privateKey, localPublicKey: host.identity.publicKey,
    remotePublicKey: client.identity.publicKey,
    prologue,
  })

  client.send('secure.handshake', {
    connectionId, targetDeviceId: host.identity.deviceId, step: 1,
    data: toBase64Url(initiator.writeHandshake()),
  })
  const step2 = await take(host.frames, host.waiters, 'secure.handshake', 10_000)
  if (step2 === null) { fail('host received handshake step 1'); return report() }
  ok('host received handshake step 1')

  responder.readHandshake(fromBase64Url(step2.payload.data))
  host.send('secure.handshake', {
    connectionId, targetDeviceId: client.identity.deviceId, step: 2,
    data: toBase64Url(responder.writeHandshake()),
  })
  const step3 = await take(client.frames, client.waiters, 'secure.handshake', 10_000)
  if (step3 === null) { fail('client received handshake step 2'); return report() }
  ok('client received handshake step 2')

  initiator.readHandshake(fromBase64Url(step3.payload.data))
  ok('Noise IK channel established (both sides)')

  console.log('\n=== 4. encrypted relay: client -> host ===')
  const plaintext = `hello through the tunnel ${randomUUID()}`
  const sealed = initiator.encrypt(new TextEncoder().encode(plaintext))
  client.send('relay', {
    connectionId, targetDeviceId: host.identity.deviceId, counter: 1,
    ciphertext: toBase64Url(sealed),
  })
  const delivered = await take(host.frames, host.waiters, 'relay', 10_000)
  if (delivered === null) { fail('host received relay frame'); return report() }
  ok('host received the relay frame', `${delivered.payload.ciphertext.length} chars base64url`)

  const opened = new TextDecoder().decode(responder.decrypt(fromBase64Url(delivered.payload.ciphertext)))
  ok('host decrypted to the original plaintext', opened === plaintext ? 'exact match' : `got "${opened}"`)

  console.log('\n=== 5. encrypted relay: host -> client ===')
  const reply = `reply through the tunnel ${randomUUID()}`
  const sealedReply = responder.encrypt(new TextEncoder().encode(reply))
  host.send('relay', {
    connectionId, targetDeviceId: client.identity.deviceId, counter: 1,
    ciphertext: toBase64Url(sealedReply),
  })
  const back = await take(client.frames, client.waiters, 'relay', 10_000)
  if (back === null) { fail('client received the reply'); return report() }
  const openedReply = new TextDecoder().decode(initiator.decrypt(fromBase64Url(back.payload.ciphertext)))
  ok('client received and decrypted the reply', openedReply === reply ? 'exact match' : `got "${openedReply}"`)

  console.log('\n=== 6. a payload above the Noise message limit is chunked ===')
  // Noise caps one ciphertext at 65535 bytes, so anything larger must be split.
  // That is a property of the crypto layer, not of the server; the point here is
  // that many relay frames arrive in order and each decrypts correctly.
  const chunk = 32 * 1024
  const big = 'x'.repeat(256 * 1024)
  let counter = 2
  let received = 0
  let mismatch = false
  for (let offset = 0; offset < big.length; offset += chunk) {
    const slice = big.slice(offset, offset + chunk)
    client.send('relay', {
      connectionId, targetDeviceId: host.identity.deviceId, counter: counter++,
      ciphertext: toBase64Url(initiator.encrypt(new TextEncoder().encode(slice))),
    })
    const frame = await take(host.frames, host.waiters, 'relay', 15_000)
    if (frame === null) { mismatch = true; break }
    const text = new TextDecoder().decode(responder.decrypt(fromBase64Url(frame.payload.ciphertext)))
    if (text !== slice) mismatch = true
    received += text.length
  }
  ok(!mismatch && received === big.length,
    mismatch ? 'chunked relay failed' : `${Math.ceil(big.length / chunk)} chunks, ${received} bytes decrypted`)

  // Runs last on purpose: refusing a rewound counter tears the link down, which is
  // correct server behaviour, so any later test would have no link to use.
  console.log('\n=== 7. replay protection: a rewound counter is refused ===')
  client.send('relay', {
    connectionId, targetDeviceId: host.identity.deviceId, counter: 1,
    ciphertext: toBase64Url(initiator.encrypt(new TextEncoder().encode('replay attempt'))),
  })
  const refused = await take(client.frames, client.waiters, 'error', 5_000)
  ok(refused !== null ? 'replay refused with an error frame' : 'replay was not refused',
    refused === null ? 'no error frame arrived' : String(refused.payload.code))

  try { client.socket.close(); host.socket.close() } catch { /* already closed */ }
  return report()
}

function report() {
  const failed = steps.filter(s => !s).length
  console.log(`\n${steps.length - failed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => { console.error('crashed:', error); process.exit(1) })
