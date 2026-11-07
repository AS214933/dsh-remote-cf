import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { identityFromClaims, resetLogtoCache } from '../src/logto.ts'
import { handleCallback, startRedirect } from '../src/oauth-routes.ts'

const ORIGIN = 'https://relay.example'
const ENDPOINT = 'https://auth.example.com'
const ISSUER = `${ENDPOINT}/oidc`
const CLIENT_ID = 'synthetic-tenant-app'
const baseEnv = {
  DSH_SERVER_ACCOUNT: 'owner@example.com', DSH_SERVER_PUBLIC_URL: ORIGIN,
  SESSION_SECRET: 'synthetic-tenant-session-secret', LOGTO_ENDPOINT: ENDPOINT,
  LOGTO_CLIENT_ID: CLIENT_ID, LOGTO_CLIENT_SECRET: 'synthetic-confidential-secret',
}
const hashIdentity = (issuer, subject) => createHash('sha256').update(JSON.stringify(['oidc-v1', issuer, subject])).digest('hex')
let keyPromise
async function signingKey() {
  keyPromise ??= crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify'])
  return keyPromise
}
const b64 = value => Buffer.from(value).toString('base64url')
async function signedToken(nonce, claims) {
  const now = Math.floor(Date.now() / 1000)
  const header = b64(JSON.stringify({ alg: 'ES384', kid: 'tenant-test-key', typ: 'JWT' }))
  const payload = b64(JSON.stringify({ iss: ISSUER, aud: CLIENT_ID, iat: now, exp: now + 300, nonce,
    sub: 'subject-one', email: 'owner@example.com', email_verified: true, ...claims }))
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, (await signingKey()).privateKey,
    new TextEncoder().encode(`${header}.${payload}`))
  return `${header}.${payload}.${b64(signature)}`
}

/** Actual routes + signed provider tokens; only the registry/flow RPC boundary is in memory. */
function fixture(overrides = {}) {
  resetLogtoCache()
  const env = { ...baseEnv, ...overrides }
  const flows = new Map()
  let claims = {}, expectedNonce = ''
  const resolveIdentity = vi.fn(async identity => ({ ...identity, membershipId: 'synthetic-live-membership' }))
  const issueSession = vi.fn(async () => ({ token: 'synthetic-signed-principal-session', expiresAt: Date.now() + 300_000 }))
  const deps = {
    resolveIdentity, issueSession, rate: vi.fn(), clientKey: () => 'synthetic-source',
    readJson: async request => request.json(),
    errorResponse: (code, status, headers) => Response.json({ error: { code } }, { status, headers }),
    call: vi.fn(async (method, args) => {
      const [id, value] = args
      if (method === 'createOAuthSession') { flows.set(id.qrId, { ...id, status: 'pending', pkce: null }); return }
      const flow = flows.get(id)
      if (method === 'getOAuthSession') return flow ? { ...flow } : null
      if (method === 'setOAuthPkce') {
        if (!flow || flow.status !== 'pending' || flow.pkce !== null || flow.expiresAt <= Date.now()) return false
        flow.pkce = value; return true
      }
      if (method === 'takeOAuthPkce') {
        if (!flow || flow.status !== 'pending' || flow.pkce === null || flow.expiresAt <= Date.now()) return null
        const pkce = flow.pkce; flow.pkce = null; flow.status = 'exchanging'; return pkce
      }
      throw new Error(`Unexpected synthetic RPC ${method}`)
    }),
  }
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === `${ISSUER}/.well-known/openid-configuration`) return Response.json({
      issuer: ISSUER, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`, userinfo_endpoint: `${ISSUER}/me`,
      end_session_endpoint: `${ISSUER}/end`, revocation_endpoint: `${ISSUER}/revoke`,
    })
    if (url === `${ISSUER}/jwks`) return Response.json({ keys: [{
      ...await crypto.subtle.exportKey('jwk', (await signingKey()).publicKey), kid: 'tenant-test-key', alg: 'ES384', use: 'sig',
    }] })
    if (url === `${ISSUER}/token`) {
      expect(new Headers(init.headers).get('Authorization')).toBe(`Basic ${btoa(`${CLIENT_ID}:${env.LOGTO_CLIENT_SECRET}`)}`)
      expect(new URLSearchParams(init.body).get('grant_type')).toBe('authorization_code')
      return Response.json({ access_token: 'synthetic-access-token', id_token: await signedToken(expectedNonce, claims), expires_in: 300 })
    }
    throw new Error('Unexpected provider endpoint; external requests forbidden')
  }))
  async function authenticate(nextClaims = {}, extraQuery = '') {
    claims = nextClaims
    const start = await startRedirect(new Request(`${ORIGIN}/api/v1/auth/oauth/logto/start?return_to=dshremote%3A%2F%2Foauth`), env, deps)
    expect(start.status).toBe(303)
    const target = new URL(start.headers.get('Location'))
    expectedNonce = target.searchParams.get('nonce')
    expect(expectedNonce).toBeTruthy()
    expect(target.searchParams.get('scope').split(' ')).not.toContain('roles')
    const cookie = start.headers.get('Set-Cookie').split(';')[0]
    const callback = new Request(`${ORIGIN}/api/v1/auth/oauth/logto/callback?code=synthetic-code&state=${encodeURIComponent(target.searchParams.get('state'))}${extraQuery}`, { headers: { Cookie: cookie } })
    const response = await handleCallback(callback, env, deps)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    return response
  }
  return { env, deps, authenticate, flows }
}
afterEach(() => { vi.unstubAllGlobals(); resetLogtoCache() })

describe('OIDC stable tenant identity', () => {
  it('derives different tenants for two verified signed subjects with the same email', async () => {
    const f = fixture({ DSH_SERVER_OIDC_ADMISSION: 'application' })
    expect((await f.authenticate({ sub: 'subject-A', email: 'shared@example.com' })).status).toBe(303)
    expect((await f.authenticate({ sub: 'subject-B', email: 'shared@example.com' })).status).toBe(303)
    const first = f.deps.issueSession.mock.calls[0][0], second = f.deps.issueSession.mock.calls[1][0]
    expect(first.account).toBe(second.account)
    expect(first.tenantId).toBe(hashIdentity(ISSUER, 'subject-A'))
    expect(second.tenantId).toBe(hashIdentity(ISSUER, 'subject-B'))
    expect(first.tenantId).not.toBe(second.tenantId)
    expect(first.membershipId).toBe('synthetic-live-membership')
    expect(f.deps.resolveIdentity.mock.invocationCallOrder[0]).toBeLessThan(f.deps.issueSession.mock.invocationCallOrder[0])
  })

  it('keeps the namespace stable across verified email changes for one subject', async () => {
    const f = fixture({ DSH_SERVER_OIDC_ADMISSION: 'application' })
    await f.authenticate({ sub: 'stable-subject', email: 'Old@Example.com' })
    await f.authenticate({ sub: 'stable-subject', email: 'New@Example.com' })
    const first = f.deps.issueSession.mock.calls[0][0], second = f.deps.issueSession.mock.calls[1][0]
    expect(first.tenantId).toBe(second.tenantId)
    expect(first.account).toBe('old@example.com'); expect(second.account).toBe('new@example.com')
    expect(second.subject).toBe('stable-subject'); expect(second.issuer).toBe(ISSUER)
  })

  it('does not accept caller-selected tenant/account query parameters', async () => {
    const f = fixture({ DSH_SERVER_OIDC_ADMISSION: 'application' })
    expect((await f.authenticate({ sub: 'real-subject', email: 'verified@example.com' }, '&tenantId=forged&account=forged%40example.com')).status).toBe(303)
    expect(f.deps.resolveIdentity).toHaveBeenCalledWith({
      tenantId: hashIdentity(ISSUER, 'real-subject'), account: 'verified@example.com', issuer: ISSUER, subject: 'real-subject',
    })
  })

  it('rejects malformed identity fields and never hashes an email as identity', async () => {
    const valid = { iss: ISSUER, sub: 'same-subject', email: 'owner@example.com', email_verified: true }
    for (const patch of [{ iss: '' }, { iss: 'not-an-issuer' }, { iss: 'http://auth.example.com/oidc' },
      { iss: 'https://user:secret@auth.example.com/oidc' }, { sub: '' }, { sub: '   ' }, { sub: '\u0000' },
      { email_verified: false }, { email_verified: 'true' }]) {
      expect(await identityFromClaims({ ...valid, ...patch })).toBeNull()
    }
    expect((await identityFromClaims(valid)).tenantId).toBe(hashIdentity(ISSUER, 'same-subject'))
    expect((await identityFromClaims({ ...valid, iss: 'https://other.example.com/oidc' })).tenantId)
      .not.toBe((await identityFromClaims(valid)).tenantId)
  })
})

describe('OIDC application admission', () => {
  it('retains the default email allowlist and unknown modes fail closed', async () => {
    for (const mode of [undefined, 'unknown', 'Application']) {
      const f = fixture(mode === undefined ? {} : { DSH_SERVER_OIDC_ADMISSION: mode })
      expect((await f.authenticate({ email: 'outsider@example.com' })).status).toBe(403)
      expect(f.deps.resolveIdentity).not.toHaveBeenCalled(); expect(f.deps.issueSession).not.toHaveBeenCalled()
    }
  })

  it('continues to accept default-owner and explicitly allowlisted verified accounts', async () => {
    const owner = fixture()
    expect((await owner.authenticate()).status).toBe(303)
    const allowlisted = fixture({ OAUTH_ALLOWED_ACCOUNTS: ' permitted@example.com ' })
    expect((await allowlisted.authenticate({ email: 'Permitted@Example.com' })).status).toBe(303)
    expect(allowlisted.deps.resolveIdentity.mock.calls[0][0].account).toBe('permitted@example.com')
  })

  it('application opt-in accepts a successful app token without a server role claim', async () => {
    const f = fixture({ DSH_SERVER_OIDC_ADMISSION: 'application' })
    expect((await f.authenticate({ email: 'outside-default@example.com' })).status).toBe(303)
    expect(f.deps.resolveIdentity).toHaveBeenCalledOnce()
    expect(f.deps.issueSession).toHaveBeenCalledWith(expect.objectContaining({
      account: 'outside-default@example.com', tenantId: hashIdentity(ISSUER, 'subject-one'), membershipId: 'synthetic-live-membership',
    }))
  })

  it('application mode still rejects unverified emails and tokens for a different application', async () => {
    for (const claims of [{ email_verified: undefined }, { email_verified: false }, { email_verified: 'true' },
      { aud: 'other-app' }, { nonce: 'wrong-nonce' }]) {
      const f = fixture({ DSH_SERVER_OIDC_ADMISSION: 'application' })
      expect((await f.authenticate(claims)).status).toBe(502)
      expect(f.deps.resolveIdentity).not.toHaveBeenCalled(); expect(f.deps.issueSession).not.toHaveBeenCalled()
    }
  })

  it('does not sign a session if the live registry rejects admission', async () => {
    const f = fixture({ DSH_SERVER_OIDC_ADMISSION: 'application' })
    const rejection = Object.assign(new Error('capacity unavailable'), { code: 'TENANT_LIMIT_REACHED', status: 429 })
    f.deps.resolveIdentity.mockRejectedValueOnce(rejection)
    await expect(f.authenticate({ email: 'allowed-by-application@example.com' })).rejects.toBe(rejection)
    expect(f.deps.issueSession).not.toHaveBeenCalled()
  })
})
