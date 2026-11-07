/** Real workerd OIDC callback smoke; synthetic ES384 provider, no external network. */
import assert from 'node:assert/strict'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { build } from 'esbuild'
import { createHash, createHmac } from 'node:crypto'
const base = 'https://relay.example', endpoint = 'https://auth.example.com', issuer = `${endpoint}/oidc`
const app = 'synthetic-app', secret = 'synthetic-client-secret'
const sessionSecret = 'synthetic-session-secret-long-enough'
const { privateKey, publicKey } = await generateKeyPair('ES384')
const jwk = { ...await exportJWK(publicKey), alg: 'ES384', kid: 'runtime-ec-key', use: 'sig' }
let nonce, challenge, tokenCalls = 0
const built = await build({ entryPoints: ['src/worker.ts'], bundle: true, write: false,
  format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], conditions: ['workerd', 'worker', 'browser'] })
const runtime = new Miniflare(convertV4MiniflareOptions({ name: 'oauth-runtime-test', modules: true,
  script: built.outputFiles[0].text, compatibilityDate: '2026-04-07', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { GATEWAY: { className: 'Gateway', useSQLite: true } },
  bindings: { DSH_SERVER_ACCOUNT: 'owner@example.com', DSH_SERVER_PASSWORD: 'synthetic-password',
    DSH_SERVER_PUBLIC_URL: base, SESSION_SECRET: sessionSecret,
    LOGTO_ENDPOINT: endpoint, LOGTO_CLIENT_ID: app, LOGTO_CLIENT_SECRET: secret },
  outboundService: async request => {
    const url = new URL(request.url)
    assert.equal(url.origin, endpoint, 'no external network permitted')
    if (url.pathname.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer,
      authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
      userinfo_endpoint: `${issuer}/me`, end_session_endpoint: `${issuer}/end`, revocation_endpoint: `${issuer}/revoke` })
    if (url.pathname === '/oidc/jwks') return Response.json({ keys: [jwk] })
    if (url.pathname === '/oidc/token') {
      tokenCalls++
      assert.equal(request.headers.get('Authorization'), `Basic ${Buffer.from(`${app}:${secret}`).toString('base64')}`)
      const body = new URLSearchParams(await request.text())
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), challenge)
      const token = await new SignJWT({ email: 'owner@example.com', email_verified: true, nonce })
        .setProtectedHeader({ alg: 'ES384', kid: jwk.kid }).setIssuer(issuer).setSubject('synthetic-owner')
        .setAudience(app).setIssuedAt().setExpirationTime('5m').sign(privateKey)
      return Response.json({ access_token: 'synthetic-access', id_token: token, expires_in: 300 })
    }
    return new Response('not found', { status: 404 })
  },
}))
const send = (path, options) => runtime.dispatchFetch(`${base}${path}`, { redirect: 'manual', ...options })
const assertPrivate = response => { assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer') }
function readStart(response) {
  assert.equal(response.status, 303); assertPrivate(response)
  const target = new URL(response.headers.get('Location'))
  assert.equal(target.origin, endpoint)
  nonce = target.searchParams.get('nonce'); challenge = target.searchParams.get('code_challenge')
  assert.ok(nonce); assert.ok(challenge)
  assert.ok(!target.searchParams.get('scope').includes('offline_access'))
  return { state: target.searchParams.get('state'), cookie: response.headers.get('Set-Cookie').split(';')[0] }
}
try {
  const start = await send('/api/v1/auth/oauth/qr/start?provider=logto', { method: 'POST' })
  assert.equal(start.status, 200); assertPrivate(start)
  const qr = await start.json()
  const { state, cookie } = readStart(await send(`/api/v1/auth/q/${qr.qrId}`))
  const rescan = await send(`/api/v1/auth/q/${qr.qrId}`)
  assert.equal(rescan.status, 409, 'rescan cannot replace the live PKCE verifier')
  const callbackPath = `/api/v1/auth/oauth/logto/callback?code=synthetic-code&state=${encodeURIComponent(state)}`
  const wrongBrowser = await send(callbackPath)
  assert.equal(wrongBrowser.status, 400); assert.equal(tokenCalls, 0)
  const result = await send(callbackPath, { headers: { Cookie: cookie } })
  assert.equal(result.status, 200); assertPrivate(result)
  assert.match(result.headers.get('Set-Cookie'), /Max-Age=0/)
  assert.equal(tokenCalls, 1)
  assert.equal((await send(callbackPath, { headers: { Cookie: cookie } })).status, 410)
  assert.equal(tokenCalls, 1, 'duplicate callback must not reexchange')
  const poll = await send(`/api/v1/auth/oauth/qr/${qr.qrId}`)
  assertPrivate(poll)
  const complete = await poll.json(); assert.equal(complete.status, 'complete'); assert.ok(complete.token)
  const [sessionBody, sessionSignature] = complete.token.split('.')
  assert.equal(sessionSignature, createHmac('sha256', sessionSecret).update(sessionBody).digest('base64url'))
  const session = JSON.parse(Buffer.from(sessionBody, 'base64url').toString())
  assert.equal(session.v, 2)
  assert.equal(session.issuer, issuer); assert.equal(session.subject, 'synthetic-owner')
  assert.equal(session.account, 'owner@example.com')
  assert.equal(session.tenantId, createHash('sha256').update(JSON.stringify(['oidc-v1', issuer, 'synthetic-owner'])).digest('hex'))
  assert.notEqual(session.tenantId, 'legacy-owner', 'matching email cannot claim migrated owner devices')
  assert.equal((await (await send(`/api/v1/auth/oauth/qr/${qr.qrId}`)).json()).status, 'expired')
  const listing = await send('/api/v1/account/devices', { headers: { Authorization: `Bearer ${complete.token}` } })
  assert.equal(listing.status, 200); assert.deepEqual((await listing.json()).items, [])
  const me = await send('/api/v1/auth/me', { headers: { Authorization: `Bearer ${complete.token}` } })
  assert.equal(me.status, 200)
  assert.deepEqual((await me.json()).identity, { issuer, subject: 'synthetic-owner' })
  const namespace = await runtime.getDurableObjectNamespace('GATEWAY')
  const gateway = namespace.get(namespace.idFromName('gateway'))
  const principal = await gateway.getTenant(session.tenantId)
  assert.equal(principal.tenantId, session.tenantId); assert.equal(principal.subject, session.subject)
  assert.ok(principal.membershipId.startsWith('account:'))
  console.log('PASS: real workerd ES384 QR callback, confidential auth, verified email, nonce, PKCE, cookie, one-shot poll; no devices created')
  const direct = readStart(await send('/api/v1/auth/oauth/logto/start?return_to=dshremote%3A%2F%2Foauth'))
  const finish = await send(`/api/v1/auth/oauth/logto/callback?code=direct-code&state=${encodeURIComponent(direct.state)}`, { headers: { Cookie: direct.cookie } })
  assert.equal(finish.status, 303); assertPrivate(finish)
  assert.ok(finish.headers.get('Location').startsWith('dshremote://oauth?token='))
  assert.equal((await send('/api/v1/auth/oauth/qr/start', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403)
  assert.equal((await send('/api/v1/auth/oauth/evil/start')).status, 404)
  console.log('PASS: real workerd direct callback and OAuth start Origin/provider boundaries')
} finally { await runtime.dispose() }
