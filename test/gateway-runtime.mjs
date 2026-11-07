/** Real workerd smoke: repeatedly evict the DO while retaining its live sockets.
 * No production credentials or production requests. Run: node test/gateway-runtime.mjs
 */
import assert from 'node:assert/strict'
import { randomUUID, randomBytes } from 'node:crypto'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'

// Optional historical control: GATEWAY_SOURCE_REF=5eb8da7 must fail after eviction.
const baseline = process.env.GATEWAY_SOURCE_REF
const plugins = baseline ? [{ name: 'historical-gateway', setup(build) {
  build.onLoad({ filter: /[/\\]src[/\\]gateway\.ts$/ }, () => ({
    contents: execFileSync('git', ['show', `${baseline}:src/gateway.ts`], { encoding: 'utf8' }),
    loader: 'ts', resolveDir: `${process.cwd()}/src`,
  }))
} }] : []
const built = await build({ entryPoints: ['src/worker.ts'], bundle: true, write: false, plugins,
  format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], conditions: ['workerd', 'worker', 'browser'] })
const runtime = new Miniflare(convertV4MiniflareOptions({ name: 'lifecycle-test', modules: true,
  script: built.outputFiles[0].text, compatibilityDate: '2026-04-07',
  compatibilityFlags: ['nodejs_compat'], durableObjects: { GATEWAY: { className: 'Gateway', useSQLite: true } },
  bindings: { DSH_SERVER_ACCOUNT: 'owner@example.com', DSH_SERVER_PASSWORD: 'local-test-password-only',
    DSH_SERVER_PUBLIC_URL: 'https://relay.example', SESSION_SECRET: 'test-session-secret-long-enough' } }))
const sockets = []
const evict = () => runtime.unsafeEvictDurableObject('lifecycle-test', 'Gateway', { name: 'gateway', webSockets: 'hibernate' })
const frame = (type, payload) => JSON.stringify({ v: 1, id: randomUUID(), type, timestamp: Date.now(), payload })
const request = async (path, method = 'GET', body, token) => {
  const response = await runtime.dispatchFetch(`https://relay.example${path}`, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) })
  const data = await response.json()
  assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(data)}`)
  return data
}
function wire(socket) {
  const messages = [], waiters = []
  socket.accept()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.type === 'ping') { socket.send(frame('pong', { nonce: message.payload.nonce })); return }
    messages.push(message)
    for (const notify of [...waiters]) notify()
  })
  const next = type => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out waiting for ${type}; got ${messages.map(m => m.type)}`)) }, 6000)
    const cleanup = () => { clearTimeout(timer); const i = waiters.indexOf(check); if (i >= 0) waiters.splice(i, 1) }
    const check = () => {
      const error = messages.find(message => message.type === 'error')
      const index = messages.findIndex(message => message.type === type)
      if (index >= 0) { const [message] = messages.splice(index, 1); cleanup(); resolve(message) }
      else if (error) { cleanup(); reject(new Error(`server error ${JSON.stringify(error.payload)}`)) }
    }
    waiters.push(check); check()
  })
  return { socket, next, send: (type, payload) => socket.send(frame(type, payload)) }
}
try {
  const login = await request('/api/v1/auth/login', 'POST', { email: 'owner@example.com', password: 'local-test-password-only' })
  async function connect(role) {
    const deviceId = randomUUID()
    const credentials = await request('/api/v1/devices/register', 'POST', { v: 1, device: {
      deviceId, role, name: `runtime-${role}`, platform: 'linux', clientVersion: '0.6.3',
      identityKey: randomBytes(32).toString('base64url'),
    } }, login.token)
    const upgraded = await runtime.dispatchFetch('https://relay.example/ws/v1/connect', { headers: { Upgrade: 'websocket' } })
    assert.equal(upgraded.status, 101)
    const connection = wire(upgraded.webSocket)
    sockets.push(connection.socket)
    connection.send('hello', { role, deviceId, accessToken: credentials.accessToken, protocols: [1], capabilities: ['transport.relay'] })
    await connection.next('hello.ack')
    return { ...connection, deviceId }
  }
  const host = await connect('host'), client = await connect('client')
  await evict()
  client.send('connect.request', { hostDeviceId: host.deviceId, preferredTransports: ['relay'] })
  const incoming = await host.next('connect.incoming')
  const connectionId = incoming.payload.connectionId
  console.log('PASS: first event after hibernation routes to the existing host')
  await evict()
  host.send('connect.accepted', { connectionId })
  await client.next('connect.accepted')
  console.log('PASS: pending link survives hibernation')
  await evict()
  client.send('transport.selected', { connectionId, targetDeviceId: host.deviceId, transport: 'relay' })
  await host.next('transport.selected')
  client.send('secure.handshake', { connectionId, targetDeviceId: host.deviceId, step: 1, data: 'AAAA' })
  await host.next('secure.handshake')
  await evict()
  host.send('secure.handshake', { connectionId, targetDeviceId: client.deviceId, step: 2, data: 'AAAA' })
  await client.next('secure.handshake')
  console.log('PASS: accepted and handshake stages survive separate hibernations')
  for (let counter = 0; counter < 5; counter++) {
    await evict()
    client.send('relay', { connectionId, targetDeviceId: host.deviceId, counter, ciphertext: 'AAAA' })
    assert.equal((await host.next('relay')).payload.counter, counter)
  }
  console.log('PASS: five real hibernation/wake cycles preserve a ready Relay tunnel')
  await evict()
  client.send('relay', { connectionId, targetDeviceId: host.deviceId, counter: 4, ciphertext: 'AAAA' })
  assert.equal((await client.next('error')).payload.code, 'INVALID_MESSAGE')
  assert.equal((await host.next('error')).payload.code, 'INVALID_MESSAGE')
  console.log('PASS: replay counter remains enforced after hibernation')
  client.send('connect.request', { hostDeviceId: host.deviceId, preferredTransports: ['relay'] })
  const closingLink = (await host.next('connect.incoming')).payload.connectionId
  host.send('connect.accepted', { connectionId: closingLink })
  await client.next('connect.accepted')
  await evict()
  host.socket.close(1000, 'test-close-wake')
  assert.equal((await client.next('error')).payload.connectionId, closingLink)
  console.log('PASS: a close event wakes the object and notifies the surviving peer')
} finally {
  for (const socket of sockets) { try { socket.close() } catch {} }
  await runtime.dispose()
}
