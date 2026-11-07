import { afterEach, describe, it, expect, vi } from 'vitest'
import { startRedirect, handleCallback } from '../src/oauth-routes.ts'
import { createHmac } from 'node:crypto'
import { resetLogtoCache } from '../src/logto.ts'
const env = { DSH_SERVER_ACCOUNT: 'owner@example.com', DSH_SERVER_PUBLIC_URL: 'https://relay.example', SESSION_SECRET: 'synthetic-long-session-secret',
  LOGTO_ENDPOINT: 'https://auth.example.com', LOGTO_CLIENT_ID: 'test-app', LOGTO_CLIENT_SECRET: 'test-client-secret',
  DSH_SERVER_IDENTITY_PROBE_KEY: 'synthetic-enrollment-private-capability', DSH_SERVER_IDENTITY_EVIDENCE_KEY: 'synthetic-operator-only-independent-key', DSH_SERVER_IDENTITY_ENROLLMENT_ONLY: '1' }
const issuer = `${env.LOGTO_ENDPOINT}/oidc`
let key
const b64 = v => Buffer.from(v).toString('base64url')
afterEach(() => { vi.unstubAllGlobals(); resetLogtoCache() })
async function setup() {
  const localEnv = { ...env }
  resetLogtoCache(); key ??= await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify'])
  let nonce = ''
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = String(input)
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, userinfo_endpoint: `${issuer}/me`, end_session_endpoint: `${issuer}/end`, revocation_endpoint: `${issuer}/revoke` })
    if (url.endsWith('/jwks')) return Response.json({ keys: [{ ...await crypto.subtle.exportKey('jwk', key.publicKey), kid: 'test-ec', use: 'sig', alg: 'ES384' }] })
    const h = b64(JSON.stringify({ kid: 'test-ec', alg: 'ES384' })), p = b64(JSON.stringify({ iss: issuer, sub: 'synthetic-owner', aud: 'test-app', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, email: 'owner@example.com', email_verified: true, nonce }))
    return Response.json({ access_token: 'synthetic-only', id_token: `${h}.${p}.${b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, key.privateKey, new TextEncoder().encode(`${h}.${p}`)))}`, expires_in: 300 })
  }))
  const flows = new Map()
  const deps = { rate: vi.fn(), clientKey: () => 'test', resolveIdentity: vi.fn(), issueSession: vi.fn(), readJson: r => r.json(), errorResponse: (code, status) => Response.json({ error: code }, { status }),
    call: vi.fn(async (method, [id, value]) => {
      if (method === 'createOAuthSession') { flows.set(id.qrId, { ...id, status: 'pending' }); return }
      const flow = flows.get(id)
      if (method === 'setOAuthPkce') { flow.pkce = value; return true }
      if (method === 'getOAuthSession') return flow
      if (method === 'takeOAuthPkce') { if (flow.status !== 'pending') return null; flow.status = 'exchanging'; const v = flow.pkce; delete flow.pkce; return v }
      throw new Error('unexpected RPC')
    }) }
  async function login(probe = true) {
    const start = await startRedirect(new Request(`https://relay.example/api/v1/auth/oauth/logto/start${probe ? `?identity_probe=${env.DSH_SERVER_IDENTITY_PROBE_KEY}` : ''}`), localEnv, deps)
    const target = new URL(start.headers.get('Location')); nonce = target.searchParams.get('nonce')
    const request = new Request(`https://relay.example/api/v1/auth/oauth/logto/callback?code=test&state=${encodeURIComponent(target.searchParams.get('state'))}`, { headers: { Cookie: start.headers.get('Set-Cookie').split(';')[0] } })
    return { response: await handleCallback(request, localEnv, deps), request }
  }
  return { deps, login, localEnv, flows }
}
describe('temporary identity-only enrollment', () => {
  it('rejects incorrect enrollment capability before provider or state creation', async () => {
    const { deps } = await setup()
    expect((await startRedirect(new Request('https://relay.example/api/v1/auth/oauth/logto/start?identity_probe=wrong'), env, deps)).status).toBe(403)
    expect(deps.call).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled()
  })
  it('reports signed identity evidence but never resolves/creates a tenant or issues a session', async () => {
    const { deps, login } = await setup(); const { response, request } = await login()
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store')
    const html = await response.text()
    expect(html).toContain('identity-evidence'); expect(html).toContain('synthetic-owner')
    expect(html).not.toContain(env.DSH_SERVER_IDENTITY_PROBE_KEY)
    expect(html).not.toContain(env.DSH_SERVER_IDENTITY_EVIDENCE_KEY)
    const packet = JSON.parse(html.match(/<pre id="identity-evidence">([^<]+)<\/pre>/)[1].replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&'))
    expect(packet.signature).toBe(createHmac('sha256', env.DSH_SERVER_IDENTITY_EVIDENCE_KEY).update(packet.evidence).digest('base64url'))
    expect(packet.signature).not.toBe(createHmac('sha256', env.DSH_SERVER_IDENTITY_PROBE_KEY).update(packet.evidence).digest('base64url'))
    expect(deps.resolveIdentity).not.toHaveBeenCalled(); expect(deps.issueSession).not.toHaveBeenCalled()
    expect((await handleCallback(request, env, deps)).status).toBe(410)
  })
  it('fails closed if evidence signer is missing or equals the disclosed start capability', async () => {
    const { deps, localEnv } = await setup()
    for (const key of [undefined, localEnv.DSH_SERVER_IDENTITY_PROBE_KEY]) {
      localEnv.DSH_SERVER_IDENTITY_EVIDENCE_KEY = key
      expect((await startRedirect(new Request(`https://relay.example/api/v1/auth/oauth/logto/start?identity_probe=${env.DSH_SERVER_IDENTITY_PROBE_KEY}`), localEnv, deps)).status).toBe(403)
    }
    expect(deps.call).not.toHaveBeenCalled()
  })
  it('rechecks expiry after evidence signing yields', async () => {
    const { deps, login, flows } = await setup()
    const original = crypto.subtle.sign.bind(crypto.subtle)
    vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => {
      const result = await original(...args)
      if (args[0] === 'HMAC') for (const flow of flows.values()) if (flow.status === 'exchanging') flow.expiresAt = 1
      return result
    })
    try {
      expect((await login()).response.status).toBe(410)
      expect(deps.resolveIdentity).not.toHaveBeenCalled(); expect(deps.issueSession).not.toHaveBeenCalled()
    } finally { vi.restoreAllMocks() }
  })
  it('blocks regular login while enrollment-only gate is set', async () => {
    const { deps, login } = await setup(); expect((await login(false)).response.status).toBe(503)
    expect(deps.resolveIdentity).not.toHaveBeenCalled(); expect(deps.issueSession).not.toHaveBeenCalled()
  })
})
