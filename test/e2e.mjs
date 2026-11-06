/**
 * End-to-end test against a live `wrangler dev` instance.
 *
 * This exercises the real Worker + Durable Object, not mocks: the point is to
 * verify that the SQLite store, the WebSocket gateway and the alarm heartbeat
 * behave as designed under the actual runtime.
 *
 * Requires a mock Logto, because the real credential path needs an IdP. The dev
 * environment is pointed at a local stub that implements just the two endpoints
 * the auth module uses.
 *
 *   node test/e2e.mjs
 */
const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:8787'
// Must match .dev.vars.
const ACCOUNT = process.env.E2E_ACCOUNT ?? 'owner@example.com'
const PASSWORD = process.env.E2E_PASSWORD ?? 'local-dev-only'

let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) { passed += 1; console.log(`  ok   ${name}`) }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function post(path, body, headers = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  let data = null
  try { data = await response.json() } catch { /* empty body */ }
  return { status: response.status, data, headers: response.headers }
}

async function get(path, headers = {}) {
  const response = await fetch(`${BASE}${path}`, { headers })
  let data = null
  try { data = await response.json() } catch { /* empty body */ }
  return { status: response.status, data }
}

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

async function main() {
  console.log(`e2e against ${BASE}\n`)

  console.log('=== health ===')
  const health = await get('/healthz')
  check('healthz answers 200', health.status === 200, `got ${health.status}`)

  console.log('\n=== auth rejects unknown/unauthenticated ===')
  const noAuth = await get('/api/v1/account/devices')
  check('account devices requires a session', noAuth.status === 401, `got ${noAuth.status}`)

  const badLogin = await post('/api/v1/auth/login', { email: ACCOUNT, password: 'wrong-password-here' })
  check('bad login is 401', badLogin.status === 401, `got ${badLogin.status}`)

  console.log('\n=== login (single account) ===')
  const login = await post('/api/v1/auth/login', { email: ACCOUNT, password: PASSWORD })
  check('login succeeds', login.status === 200, `got ${login.status} ${JSON.stringify(login.data)}`)
  check('login returns the client contract', login.data !== null
    && typeof login.data.token === 'string'
    && typeof login.data.account === 'string'
    && typeof login.data.expiresAt === 'number'
    && typeof login.data.isAdmin === 'boolean')
  check('login sets an HttpOnly cookie', (login.headers.get('set-cookie') ?? '').includes('HttpOnly'))

  const sessionToken = login.data?.token
  const sessionHeaders = { Authorization: `Bearer ${sessionToken}` }

  console.log('\n=== device registration ===')
  const hostId = ulid()
  const clientId = ulid()
  const host = await post('/api/v1/devices/register', {
    v: 1,
    device: {
      deviceId: hostId, name: 'test-host', role: 'host', platform: 'linux',
      identityKey: identityKey(), clientVersion: '0.4.15', harnessVersion: '0.2.2',
    },
  }, sessionHeaders)
  check('host registers', host.status === 200, `got ${host.status} ${JSON.stringify(host.data)}`)
  check('host gets an access token', typeof host.data?.accessToken === 'string')

  const client = await post('/api/v1/devices/register', {
    v: 1,
    device: {
      deviceId: clientId, name: 'test-client', role: 'client', platform: 'web',
      identityKey: identityKey(), clientVersion: '0.4.15',
    },
  }, sessionHeaders)
  check('client registers', client.status === 200, `got ${client.status}`)

  console.log('\n=== device auth ===')
  const me = await get('/api/v1/me', { Authorization: `Bearer ${host.data.accessToken}` })
  check('device bearer works on /me', me.status === 200, `got ${me.status}`)
  check('/me returns the device id', me.data?.deviceId === hostId)

  const hostList = await get('/api/v1/devices', { Authorization: `Bearer ${client.data.accessToken}` })
  check('client lists hosts', hostList.status === 200, `got ${hostList.status}`)
  check('host list contains the registered host', Array.isArray(hostList.data?.items)
    && hostList.data.items.some(item => item.deviceId === hostId))

  console.log('\n=== same-role device read is refused ===')
  const sameRole = await get(`/api/v1/devices/${clientId}`, { Authorization: `Bearer ${client.data.accessToken}` })
  check('client reading a client is 403', sameRole.status === 403, `got ${sameRole.status}`)

  console.log('\n=== unknown device is 404 ===')
  const unknown = await get(`/api/v1/devices/${ulid()}`, { Authorization: `Bearer ${client.data.accessToken}` })
  check('unknown device is 404', unknown.status === 404, `got ${unknown.status}`)

  console.log('\n=== token refresh ===')
  const refreshed = await post('/api/v1/auth/refresh', {
    deviceId: hostId, refreshToken: host.data.refreshToken,
  })
  check('refresh returns a new pair', refreshed.status === 200, `got ${refreshed.status}`)
  check('refresh rotated the access token', refreshed.data?.accessToken !== host.data.accessToken)

  const replay = await post('/api/v1/auth/refresh', {
    deviceId: hostId, refreshToken: host.data.refreshToken,
  })
  check('replaying the old refresh token is refused', replay.status === 401, `got ${replay.status}`)

  console.log('\n=== websocket handshake ===')
  // A fresh token: the replay above revoked the device, so register again.
  const wsDeviceId = ulid()
  const host2 = await post('/api/v1/devices/register', {
    v: 1,
    device: {
      deviceId: wsDeviceId, name: 'ws-host', role: 'host', platform: 'linux',
      identityKey: identityKey(), clientVersion: '0.4.15',
    },
  }, sessionHeaders)
  check('re-register after revoke works', host2.status === 200, `got ${host2.status}`)

  // The hello must name the same device the token was issued for; the server
  // cross-checks that, so a mismatch here would (correctly) be refused.
  const wsResult = await wsHandshake(host2.data.accessToken, wsDeviceId)
  check('websocket upgrade succeeds', wsResult.upgraded, wsResult.detail)
  check('hello.ack is received', wsResult.acked, wsResult.detail)
  check('hello.ack advertises the heartbeat', wsResult.heartbeatAdvertised, wsResult.detail)

  console.log('\n=== websocket rejects a bad token ===')
  const bad = await wsHandshake('not-a-token', ulid())
  check('bad token closes the socket', !bad.acked, bad.detail)

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

/**
 * Minimal WebSocket client using the WHATWG API available in Node 22+.
 * Returns whether the upgrade succeeded and whether hello.ack arrived.
 */
async function wsHandshake(accessToken, deviceId) {
  const url = `${BASE.replace(/^http/, 'ws')}/ws/v1/connect`
  const socket = new WebSocket(url)
  const seen = []
  let closed = null
  socket.addEventListener('message', event => seen.push(String(event.data)))
  socket.addEventListener('close', event => { closed = event.code })
  socket.addEventListener('error', () => { /* surfaced through close */ })

  const opened = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 5000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(true) }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); resolve(false) }, { once: true })
    socket.addEventListener('close', () => { clearTimeout(timer); resolve(false) }, { once: true })
  })
  if (!opened) return { upgraded: false, acked: false, heartbeatAdvertised: false, detail: `close=${closed}` }

  socket.send(JSON.stringify({
    v: 1, id: 'h1', type: 'hello', timestamp: Date.now(),
    payload: {
      role: 'host', deviceId, accessToken,
      protocols: [1], capabilities: ['transport.relay'], clientVersion: '0.4.15',
    },
  }))

  await new Promise(resolve => setTimeout(resolve, 1500))
  const ack = seen.map(raw => { try { return JSON.parse(raw) } catch { return null } })
    .find(frame => frame?.type === 'hello.ack')
  try { socket.close() } catch { /* already closed */ }

  return {
    upgraded: true,
    acked: ack !== undefined,
    heartbeatAdvertised: typeof ack?.payload?.heartbeatIntervalMs === 'number',
    detail: closed === null ? 'no close' : `close=${closed}`,
  }
}

main().catch(error => { console.error('e2e crashed:', error); process.exit(1) })
