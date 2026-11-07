/** Real workerd multi-tenant acceptance: synthetic OIDC, SQLite, WebSockets and hibernation. No external network. */
import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { build } from 'esbuild'
const origin = 'https://relay.example', endpoint = 'https://auth.example.com', issuer = `${endpoint}/oidc`
const app = 'tenant-runtime-app', secret = 'synthetic-client-secret'
const { privateKey, publicKey } = await generateKeyPair('ES384')
const jwk = { ...await exportJWK(publicKey), alg: 'ES384', kid: 'tenant-runtime-key', use: 'sig' }
const flows = new Map(), sockets = []
let turnMints = 0
const built = await build({ entryPoints: ['src/worker.ts'], bundle: true, write: false,
  format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], conditions: ['workerd', 'worker', 'browser'] })
const runtime = new Miniflare(convertV4MiniflareOptions({ name: 'tenant-runtime-test', modules: true,
  script: built.outputFiles[0].text, compatibilityDate: '2026-04-07', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { GATEWAY: { className: 'Gateway', useSQLite: true } },
  bindings: { DSH_SERVER_ACCOUNT: 'legacy@example.com', DSH_SERVER_PASSWORD: 'synthetic-password', DSH_SERVER_PASSWORD_LOGIN: 'disabled',
    DSH_SERVER_PUBLIC_URL: origin, SESSION_SECRET: 'tenant-runtime-session-secret-long-enough',
    LOGTO_ENDPOINT: endpoint, LOGTO_CLIENT_ID: app, LOGTO_CLIENT_SECRET: secret, DSH_SERVER_OIDC_ADMISSION: 'application',
    DSH_SERVER_MAX_TENANTS: '10', TURN_KEY_ID: 'synthetic-turn-key', TURN_KEY_API_TOKEN: 'synthetic-turn-token' },
  outboundService: async request => {
    const url = new URL(request.url)
    if (url.hostname === 'rtc.live.cloudflare.com') {
      turnMints++
      return Response.json({ iceServers: [{ urls: 'turn:synthetic.example', username: `mint-${turnMints}`, credential: `synthetic-${turnMints}` }] })
    }
    assert.equal(url.origin, endpoint, 'no external network allowed')
    if (url.pathname.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer,
      authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
      userinfo_endpoint: `${issuer}/me`, end_session_endpoint: `${issuer}/end`, revocation_endpoint: `${issuer}/revoke` })
    if (url.pathname === '/oidc/jwks') return Response.json({ keys: [jwk] })
    if (url.pathname === '/oidc/token') {
      assert.equal(request.headers.get('Authorization'), `Basic ${Buffer.from(`${app}:${secret}`).toString('base64')}`)
      const body = new URLSearchParams(await request.text()), flow = flows.get(body.get('code'))
      assert.ok(flow, 'authorization code belongs to synthetic tenant flow')
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), flow.challenge)
      const token = await new SignJWT({ email: flow.email, email_verified: true, nonce: flow.nonce })
        .setProtectedHeader({ alg: 'ES384', kid: jwk.kid }).setIssuer(issuer).setSubject(flow.subject)
        .setAudience(app).setIssuedAt().setExpirationTime('5m').sign(privateKey)
      return Response.json({ access_token: 'synthetic-access', id_token: token, expires_in: 300 })
    }
    return new Response('not found', { status: 404 })
  },
}))
const request = (path, token, method = 'GET', body) => runtime.dispatchFetch(`${origin}${path}`, { redirect: 'manual', method,
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
async function json(path, token, method = 'GET', body, status = 200) {
  const response = await request(path, token, method, body), data = await response.json()
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`)
  return data
}
async function login(subject, email) {
  const start = await request('/api/v1/auth/oauth/logto/start?return_to=dshremote%3A%2F%2Foauth')
  assert.equal(start.status, 303)
  const target = new URL(start.headers.get('Location')), code = `code-${subject}-${flows.size}`
  flows.set(code, { subject, email, nonce: target.searchParams.get('nonce'), challenge: target.searchParams.get('code_challenge') })
  const callback = await runtime.dispatchFetch(`${origin}/api/v1/auth/oauth/logto/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(target.searchParams.get('state'))}`, {
    redirect: 'manual', headers: { Cookie: start.headers.get('Set-Cookie').split(';')[0] },
  })
  assert.equal(callback.status, 303, await callback.clone().text())
  const token = new URL(callback.headers.get('Location')).searchParams.get('token')
  assert.ok(token)
  const me = await json('/api/v1/auth/me', token)
  assert.equal(me.identity.subject, subject); assert.equal(me.identity.issuer, issuer)
  return { token, tenantId: me.tenantId, subject, email }
}
const frame = (type, payload) => JSON.stringify({ v: 1, id: randomUUID(), type, timestamp: Date.now(), payload })
function wire(socket) {
  const messages = [], listeners = []
  socket.accept()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.type === 'ping') { if (socket.readyState === WebSocket.OPEN) { try { socket.send(frame('pong', { nonce: message.payload.nonce })) } catch {} } return }
    messages.push(message); for (const listener of [...listeners]) listener()
  })
  function next(type) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`waiting for ${type}; queued ${messages.map(m => m.type)}`)) }, 6000)
      const cleanup = () => { clearTimeout(timer); const index = listeners.indexOf(check); if (index >= 0) listeners.splice(index, 1) }
      const check = () => {
        const index = messages.findIndex(message => message.type === type)
        if (index >= 0) { const [message] = messages.splice(index, 1); cleanup(); resolve(message) }
      }
      listeners.push(check); check()
    })
  }
  return { socket, messages, next, send: (type, payload) => socket.send(frame(type, payload)) }
}
async function register(principal, deviceId, role, name, identityKey = randomBytes(32).toString('base64url')) {
  const credentials = await json('/api/v1/devices/register', principal.token, 'POST', { v: 1, tenantId: 'forged-tenant', device: {
    deviceId, role, name, platform: 'test', clientVersion: '0.6.3', identityKey,
  } })
  return { ...credentials, deviceId, role, identityKey, name }
}
async function connect(device) {
  const upgrade = await runtime.dispatchFetch(`${origin}/ws/v1/connect`, { headers: { Upgrade: 'websocket' } })
  assert.equal(upgrade.status, 101)
  const peer = wire(upgrade.webSocket); sockets.push(peer.socket)
  peer.send('hello', { deviceId: device.deviceId, role: device.role, accessToken: device.accessToken,
    protocols: [1], capabilities: ['transport.relay', 'transport.p2p', 'transport.turn'], clientVersion: '0.6.3' })
  await peer.next('hello.ack')
  return { ...device, ...peer }
}
const evict = () => runtime.unsafeEvictDurableObject('tenant-runtime-test', 'Gateway', { name: 'gateway', webSockets: 'hibernate' })
async function createLink(host, client) {
  client.send('connect.request', { hostDeviceId: host.deviceId, preferredTransports: ['p2p', 'turn', 'relay'] })
  const id = (await host.next('connect.incoming')).payload.connectionId
  host.send('connect.accepted', { connectionId: id }); await client.next('connect.accepted')
  return id
}
try {
  const a = await login('subject-a', 'a@example.com'), b = await login('subject-b', 'b@example.com')
  assert.notEqual(a.tenantId, b.tenantId)
  const sharedHost = '00000000-0000-4000-8000-000000000001', sharedClient = '00000000-0000-4000-8000-000000000002'
  const bOnly = '00000000-0000-4000-8000-000000000003'
  const aHost = await register(a, sharedHost, 'host', 'a-host'), aClient = await register(a, sharedClient, 'client', 'a-client')
  const bHost = await register(b, sharedHost, 'host', 'b-host'), bClient = await register(b, sharedClient, 'client', 'b-client')
  await register(b, bOnly, 'host', 'b-only-host')
  assert.notEqual(aHost.identityKey, bHost.identityKey)
  const aList = await json(`/api/v1/account/devices?tenantId=${b.tenantId}`, a.token)
  const bList = await json('/api/v1/account/devices', b.token)
  assert.deepEqual(aList.items.map(d => d.name).sort(), ['a-client', 'a-host'])
  assert.deepEqual(bList.items.map(d => d.name).sort(), ['b-client', 'b-host', 'b-only-host'])
  assert.notEqual(aList.items[0].membershipId, bList.items[0].membershipId)
  assert.ok(aList.items.every(d => d.membershipId === aList.items[0].membershipId))
  const descriptorA = await json(`/api/v1/devices/${sharedHost}?tenantId=${b.tenantId}`, aClient.accessToken)
  const descriptorB = await json(`/api/v1/devices/${sharedHost}`, bClient.accessToken)
  assert.equal(descriptorA.identityKey, aHost.identityKey); assert.equal(descriptorA.name, 'a-host')
  assert.equal(descriptorB.identityKey, bHost.identityKey); assert.equal(descriptorB.name, 'b-host')
  await json(`/api/v1/devices/${bOnly}`, aClient.accessToken, 'GET', undefined, 404)
  await json(`/api/v1/account/devices/${bOnly}`, a.token, 'DELETE', undefined, 404)
  assert.equal((await json(`/api/v1/devices/${bOnly}`, bClient.accessToken)).name, 'b-only-host')
  const ah = await connect(aHost), ac = await connect(aClient), bh = await connect(bHost), bc = await connect(bClient)
  ac.send('connect.request', { hostDeviceId: bOnly, preferredTransports: ['relay'] })
  assert.equal((await ac.next('error')).payload.code, 'HOST_OFFLINE')
  const aLink = await createLink(ah, ac), bLink = await createLink(bh, bc)
  assert.notEqual(aLink, bLink)
  await json(`/api/v1/turn/credentials?connection_id=${bLink}`, ac.accessToken, 'GET', undefined, 404)
  assert.ok((await json(`/api/v1/turn/credentials?connection_id=${aLink}`, ac.accessToken)).iceServers.length)
  assert.ok((await json(`/api/v1/turn/credentials?connection_id=${bLink}`, bc.accessToken)).iceServers.length)
  await evict()
  // Use HTTP here, not a retained direct RPC stub: a live Miniflare RPC reference
  // would intentionally pin the object and make the next hibernation eviction fail.
  const scopedA = await json(`/api/v1/devices/${sharedHost}`, ac.accessToken)
  const scopedB = await json(`/api/v1/devices/${sharedHost}`, bc.accessToken)
  assert.equal(scopedA.name, 'a-host'); assert.equal(scopedB.name, 'b-host')
  assert.equal(scopedA.online, true); assert.equal(scopedB.online, true)
  ac.send('signal.offer', { connectionId: aLink, targetDeviceId: sharedHost, sdp: 'a-only-sdp' })
  assert.equal((await ah.next('signal.offer')).payload.sdp, 'a-only-sdp')
  bc.send('signal.offer', { connectionId: bLink, targetDeviceId: sharedHost, sdp: 'b-only-sdp' })
  assert.equal((await bh.next('signal.offer')).payload.sdp, 'b-only-sdp')
  assert.ok(!ah.messages.some(m => m.payload?.sdp === 'b-only-sdp'))
  assert.ok(!bh.messages.some(m => m.payload?.sdp === 'a-only-sdp'))
  for (const [host, client, id] of [[ah, ac, aLink], [bh, bc, bLink]]) {
    client.send('secure.handshake', { connectionId: id, targetDeviceId: sharedHost, step: 1, data: 'AAAA' }); await host.next('secure.handshake')
    host.send('secure.handshake', { connectionId: id, targetDeviceId: sharedClient, step: 2, data: 'AAAA' }); await client.next('secure.handshake')
  }
  await evict()
  ac.send('relay', { connectionId: aLink, targetDeviceId: sharedHost, counter: 1, ciphertext: 'AAAA' })
  assert.equal((await ah.next('relay')).payload.connectionId, aLink)
  bc.send('relay', { connectionId: bLink, targetDeviceId: sharedHost, counter: 1, ciphertext: 'BBBB' })
  assert.equal((await bh.next('relay')).payload.connectionId, bLink)
  assert.ok(!ah.messages.some(m => m.type === 'relay' && m.payload.connectionId === bLink))
  assert.ok(!bh.messages.some(m => m.type === 'relay' && m.payload.connectionId === aLink))
  const beforeForeign = bh.messages.filter(message => message.type === 'relay').length
  ac.send('relay', { connectionId: bLink, targetDeviceId: sharedHost, counter: 2, ciphertext: 'AAAA' })
  assert.equal((await ac.next('error')).payload.code, 'CONNECTION_NOT_FOUND')
  assert.equal(bh.messages.filter(message => message.type === 'relay').length, beforeForeign, 'foreign link frame cannot reach or destroy B link')
  bc.send('relay', { connectionId: bLink, targetDeviceId: sharedHost, counter: 2, ciphertext: 'BBBB' })
  assert.equal((await bh.next('relay')).payload.counter, 2)
  await json(`/api/v1/devices/${sharedHost}/name?tenantId=${b.tenantId}`, a.token, 'POST', { tenantId: b.tenantId, name: 'a-renamed' })
  assert.equal((await json(`/api/v1/devices/${sharedHost}`, bClient.accessToken)).name, 'b-host')
  await json(`/api/v1/account/devices/${sharedHost}`, a.token, 'DELETE')
  assert.equal((await json(`/api/v1/devices/${sharedHost}`, bClient.accessToken)).name, 'b-host')
  assert.equal((await json('/api/v1/me', bClient.accessToken)).deviceId, sharedClient)
  console.log('PASS: real workerd two OIDC tenants, same device IDs/different keys, scoped registry/membership/list/peer/rename/revoke/TURN, isolated WS links/signaling/Relay across hibernation')
} finally {
  for (const socket of sockets) { try { socket.close(1000, 'test complete') } catch {} }
  await runtime.dispose()
}
