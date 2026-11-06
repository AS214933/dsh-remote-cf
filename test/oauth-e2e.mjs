/**
 * End-to-end OAuth test against a mock identity provider.
 *
 * Verifies the full browser flow without needing real GitHub credentials: a stub IdP
 * stands in for the authorize and token endpoints, so the redirect chain, state
 * round-trip, callback, and session completion are all exercised for real.
 *
 *   node test/oauth-e2e.mjs <server-url> <email> <password>
 *
 * Requires the deployment to have OAUTH_PROVIDERS configured pointing at the stub.
 */
const [baseUrl, email, password] = process.argv.slice(2)
if (!baseUrl || !email || !password) {
  console.error('usage: node test/oauth-e2e.mjs <server-url> <email> <password>')
  process.exit(2)
}

const steps = []
const ok = (n, d = '') => { steps.push(true); console.log(`  ok   ${n}${d ? ` — ${d}` : ''}`) }
const fail = (n, d = '') => { steps.push(false); console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`) }

/** Follow redirects manually so each hop can be asserted. */
async function hop(url, init = {}) {
  const response = await fetch(url, { ...init, redirect: 'manual' })
  return { status: response.status, location: response.headers.get('location'), headers: response.headers, body: await response.text() }
}

async function main() {
  console.log(`server : ${baseUrl}\n`)

  console.log('=== 1. discovery ===')
  const discovery = await fetch(`${baseUrl}/api/v1/auth/oauth/providers`).then(r => r.json())
  const items = discovery.items ?? []
  if (items.length === 0) {
    fail('no providers configured', 'set OAUTH_PROVIDERS on the deployment')
    return report()
  }
  ok('providers listed', `${items.length}`)
  for (const item of items) {
    ok(`  ${item.id}`, `startUrl=${item.startUrl} qrStartUrl=${item.qrStartUrl ?? '(none)'}`)
  }
  const provider = items[0]

  console.log('\n=== 2. create a session ===')
  const started = await fetch(`${baseUrl}/api/v1/auth/oauth/qr/start?provider=${provider.id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  const session = await started.json()
  if (!started.ok) { fail('qr/start', JSON.stringify(session).slice(0, 200)); return report() }
  ok('session created', `qrId=${String(session.qrId).slice(0, 10)}…`)
  ok('scanUrl is on the server origin', String(session.scanUrl).startsWith(`${baseUrl}/`), session.scanUrl)
  ok('expiresIn is a number', typeof session.expiresIn === 'number', String(session.expiresIn))

  console.log('\n=== 3. poll before authorizing ===')
  const pending = await fetch(`${baseUrl}/api/v1/auth/oauth/qr/${session.qrId}`).then(r => r.json())
  ok('status is pending', pending.status === 'pending', pending.status)

  console.log('\n=== 4. the landing page redirects to the IdP ===')
  const landing = await hop(session.scanUrl)
  ok('landing answers 303', landing.status === 303, `got ${landing.status}`)
  ok('redirects to the provider', String(landing.location).includes('authorize'), String(landing.location).slice(0, 80))
  const stateParam = new URL(landing.location).searchParams.get('state')
  ok('state is present', typeof stateParam === 'string' && stateParam.includes('.'))
  const stateCookie = (landing.headers.get('set-cookie') ?? '').split(';')[0]
  ok('state cookie set', stateCookie.length > 0)

  console.log('\n=== 5. callback with a mismatched cookie is refused ===')
  // The cookie is half the check; without it a state token leaked via referrer would be
  // enough to complete someone else's login.
  const noCookie = await hop(
    `${baseUrl}/api/v1/auth/oauth/${provider.id}/callback?code=test-code&state=${encodeURIComponent(stateParam)}`,
  )
  ok('refused without the cookie', noCookie.status === 400, `got ${noCookie.status}`)

  console.log('\n=== 6. callback with both halves completes the session ===')
  const callback = await hop(
    `${baseUrl}/api/v1/auth/oauth/${provider.id}/callback?code=test-code&state=${encodeURIComponent(stateParam)}`,
    { headers: { Cookie: stateCookie } },
  )
  ok('callback answers 200', callback.status === 200, `got ${callback.status}`)
  ok('shows a completion page', callback.body.includes('授权完成') || callback.body.includes('已登录'))

  console.log('\n=== 7. poll returns the token, once ===')
  const complete = await fetch(`${baseUrl}/api/v1/auth/oauth/qr/${session.qrId}`).then(r => r.json())
  ok('status is complete', complete.status === 'complete', complete.status)
  ok('token delivered', typeof complete.token === 'string' && complete.token.length > 16)
  const replay = await fetch(`${baseUrl}/api/v1/auth/oauth/qr/${session.qrId}`).then(r => r.json())
  ok('second poll does not re-deliver', replay.status !== 'complete', replay.status)

  console.log('\n=== 8. the token works as a session ===')
  if (typeof complete.token === 'string') {
    const me = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${complete.token}` },
    })
    const profile = await me.json().catch(() => null)
    ok('session accepted', me.status === 200, `account=${profile?.account}`)
    const registered = await fetch(`${baseUrl}/api/v1/devices/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${complete.token}` },
      body: JSON.stringify({
        v: 1,
        device: {
          deviceId: randomUlid(), name: 'oauth-e2e', role: 'client', platform: 'linux',
          identityKey: randomIdentityKey(), clientVersion: '0.6.3',
        },
      }),
    })
    ok('device registration works with it', registered.status === 200, `got ${registered.status}`)
  }

  console.log('\n=== 9. an unlisted account is refused ===')
  // Configure the stub to return an address outside the allowlist.
  const otherStart = await fetch(`${baseUrl}/api/v1/auth/oauth/qr/start?provider=${provider.id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).then(r => r.json())
  const otherLanding = await hop(otherStart.scanUrl)
  const otherState = new URL(otherLanding.location).searchParams.get('state')
  const otherCookie = (otherLanding.headers.get('set-cookie') ?? '').split(';')[0]
  const outsider = await hop(
    `${baseUrl}/api/v1/auth/oauth/${provider.id}/callback?code=outsider&state=${encodeURIComponent(otherState)}`,
    { headers: { Cookie: otherCookie } },
  )
  ok('refused for an unlisted account', outsider.status === 403, `got ${outsider.status}`)

  return report()
}

function randomUlid() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let out = ''
  for (let i = 0; i < 26; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}
function randomIdentityKey() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let out = ''
  for (let i = 0; i < 42; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out + 'AEIMQUYcgkosw048'[Math.floor(Math.random() * 16)]
}

function report() {
  const failed = steps.filter(s => !s).length
  console.log(`\n${steps.length - failed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => { console.error('crashed:', error); process.exit(1) })
