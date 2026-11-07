import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  handleCallback, landingPage, pollSession, providersResponse, startRedirect, startSession,
} from '../src/oauth-routes.ts'
import { resetLogtoCache } from '../src/logto.ts'
import { signState, stateCookieName, verifyState } from '../src/oauth.ts'
import { Store } from '../src/store.ts'

// Vite 5 predates node:sqlite; load the native module without its import resolver.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
const ORIGIN = 'https://relay.example'
const ENDPOINT = 'https://auth.example.com'
const ISSUER = `${ENDPOINT}/oidc`
const SECRET = 'local-test-session-secret'
const databases = []
const env = {
  DSH_SERVER_ACCOUNT: 'owner@example.com', DSH_SERVER_PUBLIC_URL: ORIGIN,
  SESSION_SECRET: SECRET, LOGTO_ENDPOINT: ENDPOINT,
  LOGTO_CLIENT_ID: 'test-client', LOGTO_CLIENT_SECRET: 'local-test-only',
}

function storage(db = new DatabaseSync(':memory:')) {
  databases.push(db)
  const sql = { exec(query, ...bindings) {
    const rows = db.prepare(query).all(...bindings)
    return { toArray: () => rows }
  } }
  return { sql, transactionSync(fn) {
    db.exec('BEGIN')
    try { const result = fn(); db.exec('COMMIT'); return result }
    catch (error) { db.exec('ROLLBACK'); throw error }
  } }
}

function fixture() {
  const database = storage()
  const store = new Store(database)
  const issueSession = vi.fn(async () => ({ token: 'local-session-token', expiresAt: Date.now() + 60_000 }))
  const call = vi.fn(async (method, args) => store[method](...args))
  const deps = {
    call, issueSession, rate: vi.fn(), clientKey: () => 'test-client',
    readJson: async request => request.json(),
    errorResponse: (code, status, headers) => Response.json({ error: { code } }, { status, headers }),
  }
  return { store, database, deps }
}

function request(path, headers = {}, method = 'GET') {
  return new Request(`${ORIGIN}${path}`, { method, headers })
}
function privateResponse(response) {
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
}
function b64(bytes) { return Buffer.from(bytes).toString('base64url') }
let keyPromise
async function signingKey() {
  keyPromise ??= crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
  return keyPromise
}
async function idToken(nonce, overrides = {}) {
  const key = await signingKey()
  const now = Math.floor(Date.now() / 1000)
  const header = b64(JSON.stringify({ alg: 'RS256', kid: 'local-key', typ: 'JWT' }))
  const payload = b64(JSON.stringify({ iss: ISSUER, aud: env.LOGTO_CLIENT_ID, sub: 'local-user',
    iat: now - 10, exp: now + 300, email: 'Owner@Example.com', email_verified: true,
    nonce, ...overrides }))
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey,
    new TextEncoder().encode(`${header}.${payload}`))
  return `${header}.${payload}.${b64(signature)}`
}
function provider(options = {}) {
  resetLogtoCache()
  const exchanges = []
  let nonce = ''
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json({
      issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/me`, jwks_uri: `${ISSUER}/jwks`,
      end_session_endpoint: `${ISSUER}/session/end`, response_types_supported: ['code'],
      subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
    })
    if (url === `${ISSUER}/jwks`) {
      const key = await signingKey()
      return Response.json({ keys: [{ ...await crypto.subtle.exportKey('jwk', key.publicKey),
        kid: 'local-key', alg: 'RS256', use: 'sig' }] })
    }
    if (url === `${ISSUER}/token`) {
      exchanges.push(new URLSearchParams(init.body))
      if (options.failExchange) return new Response('test failure', { status: 502 })
      return Response.json({ access_token: 'provider-test-token', token_type: 'Bearer', expires_in: 300,
        id_token: await idToken(options.wrongNonce ? 'wrong-nonce' : nonce, options.claims) })
    }
    throw new Error('Unexpected local provider endpoint')
  }))
  return { exchanges, setNonce: value => { nonce = value } }
}
async function startQr(f) {
  const start = await startSession(request('/api/v1/auth/oauth/qr/start', {}, 'POST'), env, f.deps)
  privateResponse(start)
  const { qrId } = await start.json()
  const landing = await landingPage(request(`/api/v1/auth/q/${qrId}`), env, f.deps, qrId)
  expect(landing.status).toBe(303)
  privateResponse(landing)
  return { qrId, ...await browserFlow(landing) }
}
async function browserFlow(response) {
  const target = new URL(response.headers.get('Location'))
  const token = target.searchParams.get('state')
  const state = await verifyState(SECRET, token, 'logto')
  expect(state.nonce).toBe(target.searchParams.get('nonce'))
  expect(state.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/)
  return { state, token, target, cookie: response.headers.get('Set-Cookie').split(';')[0] }
}
function callback(flow, cookie = flow.cookie) {
  return request(`/api/v1/auth/oauth/logto/callback?code=local-test-code&state=${encodeURIComponent(flow.token)}`,
    cookie === null ? {} : { Cookie: cookie })
}

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); resetLogtoCache()
  for (const db of databases.splice(0)) db.close()
})

describe('OAuth state and SQLite lifecycle', () => {
  it('binds an explicitly supplied nonce and rejects signed off-allowlist return targets', async () => {
    const good = await signState(SECRET, { providerId: 'logto', returnTo: '/app', qrId: 'qr', nonce: 'fixed-test-nonce' })
    expect((await verifyState(SECRET, good, 'logto')).nonce).toBe('fixed-test-nonce')
    const bad = await signState(SECRET, { providerId: 'logto', returnTo: 'https://evil.example', qrId: 'qr' })
    expect(await verifyState(SECRET, bad, 'logto')).toBeNull()
    expect(await verifyState(SECRET, good, 'other')).toBeNull()
  })

  it('initializes each database and invalidates only legacy ephemeral OAuth sessions', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`CREATE TABLE oauth_sessions (qr_id TEXT PRIMARY KEY, status TEXT CHECK(status IN ('pending','complete','expired')));
      INSERT INTO oauth_sessions VALUES ('legacy','pending');
      CREATE TABLE retained (value TEXT); INSERT INTO retained VALUES ('device-credentials');`)
    const first = new Store(storage(db))
    expect(first.getOAuthSession('legacy')).toBeNull()
    expect(db.prepare('SELECT value FROM retained').get().value).toBe('device-credentials')
    const second = fixture()
    second.store.createOAuthSession({ qrId: 'new-db', provider: 'logto', expiresAt: Date.now() + 60_000 })
    expect(second.store.getOAuthSession('new-db').status).toBe('pending')
  })

  it('has one verifier writer and one atomic callback winner, with no resurrection', async () => {
    const { store, database } = fixture()
    store.createOAuthSession({ qrId: 'one', provider: 'logto', expiresAt: Date.now() + 60_000 })
    expect(store.completeOAuthSession('one', 'owner@example.com', false, 'premature')).toBe(false)
    expect(store.setOAuthPkce('one', 'first-verifier')).toBe(true)
    expect(store.setOAuthPkce('one', 'scanner-or-reload')).toBe(false)
    const claimed = await Promise.all([0, 1, 2].map(async () => store.takeOAuthPkce('one')))
    expect(claimed.filter(value => value !== null)).toEqual(['first-verifier'])
    expect(store.getOAuthSession('one').status).toBe('exchanging')
    expect(database.sql.exec('SELECT pkce FROM oauth_sessions WHERE qr_id = ?', 'one').toArray()[0].pkce).toBeNull()
    expect(store.setOAuthPkce('one', 'resurrection')).toBe(false)
    expect(store.completeOAuthSession('one', 'owner@example.com', false, 'result-token')).toBe(true)
    expect(store.completeOAuthSession('one', 'owner@example.com', false, 'replacement')).toBe(false)
    expect(store.takeOAuthToken('one').token).toBe('result-token')
    expect(store.takeOAuthToken('one')).toBeNull()
    expect(store.setOAuthPkce('one', 'after-poll')).toBe(false)
  })

  it('checks provider and expiry at claim, completion and token collection boundaries', () => {
    const { store, database } = fixture()
    const expiry = Date.now() + 60_000
    for (const id of ['expired', 'other', 'mid-exchange', 'completed']) {
      store.createOAuthSession({ qrId: id, provider: id === 'other' ? 'other' : 'logto', expiresAt: expiry })
    }
    expect(store.setOAuthPkce('other', 'verifier')).toBe(false)
    database.sql.exec("UPDATE oauth_sessions SET pkce = 'legacy' WHERE qr_id = 'other'")
    expect(store.takeOAuthPkce('other')).toBeNull()
    expect(store.setOAuthPkce('expired', 'verifier')).toBe(true)
    database.sql.exec("UPDATE oauth_sessions SET expires_at = ? WHERE qr_id = 'expired'", Date.now() - 1)
    expect(store.setOAuthPkce('expired', 'replacement')).toBe(false)
    expect(store.takeOAuthPkce('expired')).toBeNull()
    for (const id of ['mid-exchange', 'completed']) {
      store.setOAuthPkce(id, 'verifier'); store.takeOAuthPkce(id)
    }
    store.completeOAuthSession('completed', 'owner@example.com', false, 'result')
    database.sql.exec("UPDATE oauth_sessions SET expires_at = ? WHERE qr_id IN ('mid-exchange','completed')", Date.now() - 1)
    expect(store.completeOAuthSession('mid-exchange', 'owner@example.com', false, 'too-late')).toBe(false)
    expect(store.takeOAuthToken('completed')).toBeNull()
  })
})

describe('OAuth handlers with real signed provider tokens and local SQLite', () => {
  it('completes QR sign-in once, clears the cookie and delivers the token once', async () => {
    const f = fixture(), p = provider(), flow = await startQr(f)
    p.setNonce(flow.state.nonce)
    const response = await handleCallback(callback(flow), env, f.deps)
    expect(response.status).toBe(200); privateResponse(response)
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0')
    expect(response.headers.get('Set-Cookie')).toContain('Secure')
    expect(f.deps.issueSession).toHaveBeenCalledTimes(1)
    expect(f.deps.issueSession).toHaveBeenCalledWith('owner@example.com')
    const poll = await pollSession(request(`/api/v1/auth/oauth/qr/${flow.qrId}`), env, f.deps, flow.qrId)
    privateResponse(poll)
    expect(await poll.json()).toEqual({ status: 'complete', token: 'local-session-token' })
    expect(await (await pollSession(request('/poll'), env, f.deps, flow.qrId)).json()).toEqual({ status: 'expired' })
    expect((await handleCallback(callback(flow), env, f.deps)).status).toBe(410)
    expect(p.exchanges).toHaveLength(1)
    expect(p.exchanges[0].get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect((await landingPage(request('/landing'), env, f.deps, flow.qrId)).status).toBe(200)
    expect(f.store.setOAuthPkce(flow.qrId, 'resurrect')).toBe(false)
  })

  it('allows only one concurrent direct callback without changing the token-query contract', async () => {
    const f = fixture(), p = provider()
    const started = await startRedirect(request('/api/v1/auth/oauth/logto/start?return_to=%2Fapp'), env, f.deps)
    privateResponse(started)
    const flow = await browserFlow(started)
    p.setNonce(flow.state.nonce)
    const responses = await Promise.all([handleCallback(callback(flow), env, f.deps), handleCallback(callback(flow), env, f.deps)])
    expect(responses.map(value => value.status).sort()).toEqual([303, 410])
    const success = responses.find(value => value.status === 303)
    privateResponse(success)
    expect(success.headers.get('Location')).toBe('/app?token=local-session-token')
    expect(success.headers.get('Set-Cookie')).toContain('Max-Age=0')
    expect(f.deps.issueSession).toHaveBeenCalledTimes(1)
    expect(p.exchanges).toHaveLength(1)
    expect(f.store.setOAuthPkce(flow.state.flowId, 'retry')).toBe(false)
  })

  it.each(['qr', 'direct'])('does not deliver %s credentials if the flow expires during signing', async kind => {
    const f = fixture(), p = provider()
    const flow = kind === 'qr' ? await startQr(f) : await browserFlow(
      await startRedirect(request('/api/v1/auth/oauth/logto/start'), env, f.deps),
    )
    p.setNonce(flow.state.nonce)
    f.deps.issueSession.mockImplementation(async () => {
      f.database.sql.exec('UPDATE oauth_sessions SET expires_at = ? WHERE qr_id = ?',
        Date.now() - 1, flow.state.qrId ?? flow.state.flowId)
      return { token: 'must-not-deliver', expiresAt: Date.now() + 60_000 }
    })
    const response = await handleCallback(callback(flow), env, f.deps)
    expect(response.status).toBe(410); privateResponse(response)
    expect(response.headers.get('Location')).toBeNull()
    expect(await response.text()).not.toContain('must-not-deliver')
    expect(f.store.takeOAuthToken(flow.state.qrId ?? flow.state.flowId)).toBeNull()
  })

  it('rejects missing/mismatched cookies and foreign-provider state before claiming', async () => {
    const f = fixture(), p = provider(), flow = await startQr(f)
    for (const cookie of [null, `${stateCookieName('logto')}=other-state`]) {
      expect((await handleCallback(callback(flow, cookie), env, f.deps)).status).toBe(400)
    }
    const other = await signState(SECRET, { providerId: 'other', returnTo: '/app', qrId: flow.qrId })
    const forgedFlow = { token: other, cookie: `${stateCookieName('logto')}=${other}` }
    expect((await handleCallback(callback(forgedFlow), env, f.deps)).status).toBe(400)
    expect(f.store.getOAuthSession(flow.qrId).status).toBe('pending')
    expect(p.exchanges).toHaveLength(0)
    expect(f.deps.issueSession).not.toHaveBeenCalled()
  })

  it.each([{ wrongNonce: true }, { failExchange: true }, { claims: { email: 'not-allowed@example.com' } }])(
    'consumes failed callbacks without a retry or landing-page resurrection: %j', async options => {
      const f = fixture(), p = provider(options), flow = await startQr(f)
      p.setNonce(flow.state.nonce)
      const failed = await handleCallback(callback(flow), env, f.deps)
      expect(failed.status).toBe(options.claims ? 403 : 502)
      expect((await handleCallback(callback(flow), env, f.deps)).status).toBe(410)
      const landing = await landingPage(request('/landing'), env, f.deps, flow.qrId)
      expect(landing.headers.get('Location')).toBeNull()
      expect(f.store.getOAuthSession(flow.qrId).status).toBe('exchanging')
      expect(p.exchanges).toHaveLength(1)
      expect(f.deps.issueSession).not.toHaveBeenCalled()
    },
  )

  it('prevents scanner/reload replacement and never consumes expired or exchanging polls', async () => {
    const f = fixture(); provider()
    const flow = await startQr(f)
    const original = f.database.sql.exec('SELECT pkce FROM oauth_sessions WHERE qr_id = ?', flow.qrId).toArray()[0].pkce
    expect((await landingPage(request('/reload'), env, f.deps, flow.qrId)).status).toBe(409)
    expect(f.store.takeOAuthPkce(flow.qrId)).toBe(original)
    const polling = await pollSession(request('/poll'), env, f.deps, flow.qrId)
    expect(await polling.json()).toEqual({ status: 'pending' })
    expect((await landingPage(request('/reload'), env, f.deps, flow.qrId)).headers.get('Location')).toBeNull()
    for (const phase of ['pending', 'exchanging', 'complete', 'expired']) {
      f.database.sql.exec('UPDATE oauth_sessions SET status = ?, expires_at = ? WHERE qr_id = ?', phase, Date.now() - 1, flow.qrId)
      const count = f.deps.call.mock.calls.filter(([method]) => method === 'takeOAuthToken').length
      const response = await pollSession(request('/poll'), env, f.deps, flow.qrId)
      expect(await response.json()).toEqual({ status: 'expired' }); privateResponse(response)
      expect(f.deps.call.mock.calls.filter(([method]) => method === 'takeOAuthToken')).toHaveLength(count)
    }
  })

  it('uses the canonical public origin for POST and permits absent-Origin native clients only when not cross-site', async () => {
    const f = fixture()
    for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' },
      { Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site' }]) {
      const response = await startSession(request('/api/v1/auth/oauth/qr/start', headers, 'POST'), env, f.deps)
      expect(response.status).toBe(403); privateResponse(response)
    }
    expect(f.deps.call).not.toHaveBeenCalled()
    for (const headers of [{}, { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin' }]) {
      const response = await startSession(request('/api/v1/auth/oauth/qr/start', headers, 'POST'),
        { ...env, DSH_SERVER_PUBLIC_URL: `${ORIGIN}/` }, f.deps)
      expect(response.status).toBe(200); privateResponse(response)
    }
    privateResponse(providersResponse(env))
    const rejected = await startRedirect(request('/api/v1/auth/oauth/logto/start?return_to=https%3A%2F%2Fevil.example'), env, f.deps)
    expect(rejected.status).toBe(400); privateResponse(rejected)
  })
})
