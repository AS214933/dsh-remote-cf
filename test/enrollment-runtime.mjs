/** Real workerd identity-only enrollment, isolated synthetic provider, no external network. */
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { build } from 'esbuild'
const base = 'https://relay.example', endpoint = 'https://auth.example.com', issuer = `${endpoint}/oidc`
const app = 'synthetic-enrollment-app', secret = 'synthetic-enrollment-client-secret', probeKey = 'synthetic-enrollment-high-entropy-capability', evidenceKey = 'synthetic-independent-operator-only-evidence-signing-key'
const { privateKey, publicKey } = await generateKeyPair('ES384'), jwk = { ...await exportJWK(publicKey), alg: 'ES384', kid: 'enrollment-key', use: 'sig' }
let nonce, challenge
const built = await build({ entryPoints: ['src/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], conditions: ['workerd', 'worker', 'browser'] })
const runtime = new Miniflare(convertV4MiniflareOptions({ name: 'enrollment-runtime', modules: true, script: built.outputFiles[0].text,
  compatibilityDate: '2026-04-07', compatibilityFlags: ['nodejs_compat'], durableObjects: { GATEWAY: { className: 'Gateway', useSQLite: true } },
  bindings: { DSH_SERVER_ACCOUNT: 'owner@example.com', DSH_SERVER_PASSWORD: 'synthetic-password', DSH_SERVER_PASSWORD_LOGIN: 'disabled',
    DSH_SERVER_PUBLIC_URL: base, SESSION_SECRET: 'synthetic-session-signing-secret', LOGTO_ENDPOINT: endpoint, LOGTO_CLIENT_ID: app, LOGTO_CLIENT_SECRET: secret,
    DSH_SERVER_IDENTITY_PROBE_KEY: probeKey, DSH_SERVER_IDENTITY_EVIDENCE_KEY: evidenceKey, DSH_SERVER_IDENTITY_ENROLLMENT_ONLY: '1' },
  outboundService: async request => {
    const url = new URL(request.url); assert.equal(url.origin, endpoint, 'external network denied')
    if (url.pathname.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, userinfo_endpoint: `${issuer}/me`, end_session_endpoint: `${issuer}/end`, revocation_endpoint: `${issuer}/revoke` })
    if (url.pathname.endsWith('/jwks')) return Response.json({ keys: [jwk] })
    assert.equal(url.pathname, '/oidc/token'); assert.equal(request.headers.get('Authorization'), `Basic ${Buffer.from(`${app}:${secret}`).toString('base64')}`)
    const form = new URLSearchParams(await request.text()); assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), challenge)
    const token = await new SignJWT({ email: 'owner@example.com', email_verified: true, nonce }).setProtectedHeader({ alg: 'ES384', kid: jwk.kid }).setIssuer(issuer).setSubject('synthetic-legacy-owner').setAudience(app).setIssuedAt().setExpirationTime('5m').sign(privateKey)
    return Response.json({ access_token: 'synthetic-only', id_token: token, expires_in: 300 })
  } }))
const send = (path, options) => runtime.dispatchFetch(`${base}${path}`, { redirect: 'manual', ...options })
async function login(probe) {
  const start = await send(`/api/v1/auth/oauth/logto/start${probe ? `?identity_probe=${probeKey}` : ''}`)
  assert.equal(start.status, 303)
  const target = new URL(start.headers.get('Location')); nonce = target.searchParams.get('nonce'); challenge = target.searchParams.get('code_challenge')
  assert.ok(!target.href.includes(probeKey), 'provider never receives enrollment capability')
  const path = `/api/v1/auth/oauth/logto/callback?code=synthetic&state=${encodeURIComponent(target.searchParams.get('state'))}`
  const headers = { Cookie: start.headers.get('Set-Cookie').split(';')[0] }
  assert.equal((await send(path)).status, 400)
  return { response: await send(path, { headers }), path, headers }
}
try {
  assert.equal((await send('/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', password: 'synthetic-password' }) })).status, 403)
  assert.equal((await send('/api/v1/auth/oauth/logto/start?identity_probe=wrong')).status, 403)
  const { response, path, headers } = await login(true)
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer')
  assert.match(response.headers.get('Set-Cookie'), /Max-Age=0/)
  const html = await response.text(), escaped = html.match(/<pre id="identity-evidence">([^<]+)<\/pre>/)?.[1]
  assert.ok(escaped); assert.ok(!html.includes(probeKey)); assert.equal(response.headers.get('Location'), null)
  const packet = JSON.parse(escaped.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&'))
  assert.equal(packet.signature, createHmac('sha256', evidenceKey).update(packet.evidence).digest('base64url'))
  const identity = JSON.parse(packet.evidence); assert.equal(identity.issuer, issuer); assert.equal(identity.subject, 'synthetic-legacy-owner'); assert.ok(Date.now() - identity.observedAt < 30_000)
  assert.equal((await send(path, { headers })).status, 410)
  assert.equal((await login(false)).response.status, 503)
  const ns = await runtime.getDurableObjectNamespace('GATEWAY'), gateway = ns.get(ns.idFromName('gateway'))
  assert.equal(await gateway.getTenant(identity.tenantId), null, 'probe/blocked normal login never creates a tenant')
  assert.equal((await gateway.getTenant('legacy-owner')).subject, '', 'probe never claims legacy partition')
  assert.equal((await send('/api/v1/account/devices')).status, 401)
  console.log('PASS: real workerd enrollment-only verified evidence HMAC, no session/tenant/claim, wrong capability/browser and replay denied; regular login gated')
} finally { await runtime.dispose() }
