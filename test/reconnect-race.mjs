import { createManualChecks } from './manual-check.mjs'
/**
 * Reproduce the CONNECTION_REPLACED loop.
 *
 * Two clients share a device identity only if they reuse the same id; the desktop plugin
 * and the Android app generate their own, so the realistic cause is a single client
 * reconnecting before the server has reaped the previous socket. This drives that
 * sequence explicitly: connect, drop the TCP connection without a close frame, then
 * immediately reconnect and see whether the server treats the second as a replacement.
 *
 *   node test/reconnect-race.mjs <server-url> <email> <password>
 */
import { randomUUID } from 'node:crypto'

const [baseUrl, email, password] = process.argv.slice(2)
if (!baseUrl || !email || !password) {
  console.error('usage: node test/reconnect-race.mjs <server-url> <email> <password>')
  process.exit(2)
}

const { steps, ok, fail, check } = createManualChecks()

function ulid() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let out = ''
  for (let i = 0; i < 26; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}
function identityKey() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let out = ''
  for (let i = 0; i < 42; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out + 'AEIMQUYcgkosw048'[Math.floor(Math.random() * 16)]
}

async function login() {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(`login ${response.status}`)
  return body.token
}

async function register(session, role, name) {
  const deviceId = ulid()
  const response = await fetch(`${baseUrl}/api/v1/devices/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
    body: JSON.stringify({
      v: 1,
      device: {
        deviceId, name, role, platform: 'linux',
        identityKey: identityKey(), clientVersion: '0.6.3',
        ...(role === 'host' ? { harnessVersion: '0.2.1-rc.5' } : {}),
      },
    }),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(`register ${response.status} ${JSON.stringify(body)}`)
  return { deviceId, accessToken: body.accessToken }
}

/** Open a control socket and complete hello. Resolves with the socket and its frames. */
async function connect(device, role) {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws/v1/connect`)
  const frames = []
  let closed = null
  socket.addEventListener('message', event => {
    try { frames.push(JSON.parse(String(event.data))) } catch { /* ignore */ }
  })
  socket.addEventListener('close', event => { closed = event.code })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', () => reject(new Error('ws error')), { once: true })
  })
  socket.send(JSON.stringify({
    v: 1, id: randomUUID(), type: 'hello', timestamp: Date.now(),
    payload: {
      role, deviceId: device.deviceId, accessToken: device.accessToken,
      protocols: [1], capabilities: ['transport.relay'],
      clientVersion: '0.6.3', ...(role === 'host' ? { harnessVersion: '0.2.1-rc.5' } : {}),
    },
  }))
  const deadline = Date.now() + 10_000
  while (!frames.some(f => f.type === 'hello.ack') && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 50))
  }
  return { socket, frames, get closed() { return closed } }
}

async function main() {
  console.log(`server : ${baseUrl}\n`)
  const session = await login()
  ok('logged in')

  const host = await register(session, 'host', 'race-host')
  const client = await register(session, 'client', 'race-client')
  ok('host and client registered')

  console.log('\n=== 1. both connect ===')
  const hostSocket = await connect(host, 'host')
  const clientSocket = await connect(client, 'client')
  check('host hello', hostSocket.frames.some(f => f.type === 'hello.ack'))
  check('client hello', clientSocket.frames.some(f => f.type === 'hello.ack'))

  console.log('\n=== 2. link them ===')
  clientSocket.socket.send(JSON.stringify({
    v: 1, id: randomUUID(), type: 'connect.request', timestamp: Date.now(),
    payload: { hostDeviceId: host.deviceId, preferredTransports: ['relay'] },
  }))
  const incoming = await waitFor(hostSocket.frames, 'connect.incoming', 10_000)
  if (incoming === null) { fail('connect.incoming'); return report() }
  hostSocket.socket.send(JSON.stringify({
    v: 1, id: randomUUID(), type: 'connect.accepted', timestamp: Date.now(),
    payload: { connectionId: incoming.payload.connectionId },
  }))
  const accepted = await waitFor(clientSocket.frames, 'connect.accepted', 10_000)
  check('link acceptance reaches the client', accepted?.payload?.connectionId === incoming.payload.connectionId)

  console.log('\n=== 3. client drops and reconnects immediately ===')
  // A client that reconnects before the server has processed the close looks like two
  // live connections for one device id, which is what triggers CONNECTION_REPLACED.
  clientSocket.socket.close()
  const second = await connect(client, 'client')
  await new Promise(r => setTimeout(r, 1500))
  check('reconnected', second.frames.some(f => f.type === 'hello.ack'))
  const replaced = second.frames.find(f => f.type === 'error' && f.payload?.code === 'CONNECTION_REPLACED')
  check('no CONNECTION_REPLACED on the new socket', replaced === undefined,
    replaced === undefined ? 'clean' : 'GOT CONNECTION_REPLACED')

  console.log('\n=== 4. can the reconnected client open a link again? ===')
  second.socket.send(JSON.stringify({
    v: 1, id: randomUUID(), type: 'connect.request', timestamp: Date.now(),
    payload: { hostDeviceId: host.deviceId, preferredTransports: ['relay'] },
  }))
  const incoming2 = await waitFor(hostSocket.frames, 'connect.incoming', 10_000)
  check('second connect.request reaches the host', incoming2 !== null,
    incoming2 === null ? 'host never saw it' : incoming2.payload.connectionId.slice(0, 8))

  console.log('\n=== 5. a second client joining must not evict the first ===')
  // The host is 0.6.3, which is a modern host: it must hold two links at once.
  const clientB = await register(session, 'client', 'race-client-b')
  const clientBSocket = await connect(clientB, 'client')
  if (incoming2 !== null) {
    hostSocket.socket.send(JSON.stringify({
      v: 1, id: randomUUID(), type: 'connect.accepted', timestamp: Date.now(),
      payload: { connectionId: incoming2.payload.connectionId },
    }))
  }
  clientBSocket.socket.send(JSON.stringify({
    v: 1, id: randomUUID(), type: 'connect.request', timestamp: Date.now(),
    payload: { hostDeviceId: host.deviceId, preferredTransports: ['relay'] },
  }))
  const incoming3 = await waitFor(hostSocket.frames, 'connect.incoming', 10_000)
  check('third connect.request reaches the host', incoming3 !== null,
    incoming3 === null ? 'host never saw it' : 'modern host received another request')
  hostSocket.socket.send(JSON.stringify({
    v: 1, id: randomUUID(), type: 'connect.accepted', timestamp: Date.now(),
    payload: { connectionId: incoming3.payload.connectionId },
  }))
  const acceptedB = await waitFor(clientBSocket.frames, 'connect.accepted', 10_000)
  check('second client receives acceptance', acceptedB?.payload?.connectionId === incoming3.payload.connectionId)
  const evicted = second.frames.find(f => f.type === 'error' && f.payload?.code === 'CONNECTION_REPLACED')
  check('the first client was not evicted', evicted === undefined && second.closed === null && second.socket.readyState === WebSocket.OPEN,
    evicted === undefined ? `close=${second.closed ?? 'none'}` : 'FIRST CLIENT EVICTED')

  try {
    second.socket.close(); clientBSocket.socket.close(); hostSocket.socket.close()
  } catch { /* already closed */ }
  return report()
}

async function waitFor(frames, type, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const index = frames.findIndex(f => f.type === type)
    if (index >= 0) return frames.splice(index, 1)[0]
    if (Date.now() > deadline) return null
    await new Promise(r => setTimeout(r, 50))
  }
}

function report() {
  const failed = steps.filter(s => !s).length
  console.log(`\n${steps.length - failed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => { console.error('crashed:', error); process.exit(1) })
