/**
 * Contract check: every endpoint the shipped plugin calls must be implemented.
 *
 * The `register-owned-role` gap was invisible because each endpoint passed its own
 * test while the *sequence* the UI performs had a hole in it. This test inverts that:
 * it extracts the paths the plugin actually requests, from the plugin's own source,
 * and asserts this server answers each one with something other than "unknown route".
 *
 * It cannot judge whether the semantics are right, but it does guarantee that no
 * endpoint is simply missing — which is the failure mode that produced a login that
 * appeared to work and then showed an empty host list.
 *
 *   npx tsx endpoint-contract.mjs <server-url> <email> <password>
 */
import { readFileSync } from 'node:fs'
import { join as joinPath } from 'node:path'

const [baseUrl, email, password] = process.argv.slice(2)
if (!baseUrl || !email || !password) {
  console.error('usage: npx tsx endpoint-contract.mjs <server-url> <email> <password>')
  process.exit(2)
}
const REPO = process.env.DSH_REPO
if (!REPO) { console.error('DSH_REPO must point at a ds-harness-remote checkout'); process.exit(2) }

const steps = []
const ok = (n, d = '') => { steps.push(true); console.log(`  ok   ${n}${d ? ` — ${d}` : ''}`) }
const fail = (n, d = '') => { steps.push(false); console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`) }

const source = readFileSync(joinPath(REPO, 'packages/plugin/src/server-api.ts'), 'utf8')

/**
 * Pull the literal and template paths out of the plugin source.
 *
 * A template literal becomes a pattern with its substitutions replaced by
 * placeholders, so the probe can substitute a plausible value.
 */
const paths = new Set()
for (const match of source.matchAll(/'(\/api\/v1\/[a-z0-9/_.-]+)'/gi)) paths.add(match[1])
for (const match of source.matchAll(/`(\/api\/v1\/[^`]+)`/g)) {
  paths.add(match[1]
    .replace(/\$\{encodeURIComponent\((\w+)\)\}/g, (_, name) => `__${name}__`)
    .replace(/\$\{[^}]+\}/g, '__x__'))
}

// Endpoints that legitimately do not exist on a password-only single-account server.
const OPTIONAL = [
  // OAuth is not configured; the plugin treats 404 as "no providers" and falls back.
  /^\/api\/v1\/auth\/oauth\//,
  // Registration codes authorize a Host without an account, which this deployment
  // does not offer — it has an account, so the UI offers the account path.
  /^\/api\/v1\/devices\/register-with-code$/,
]

console.log(`server : ${baseUrl}`)
console.log(`source : packages/plugin/src/server-api.ts`)
console.log(`paths  : ${paths.size} discovered\n`)

const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
})
const session = login.ok ? await login.json() : null
if (session === null || typeof session.token !== 'string') {
  fail('login', `status ${login.status}`)
  process.exit(1)
}
ok('login', 'session obtained')

console.log('\n=== every path the plugin requests ===')
let missing = 0
for (const raw of [...paths].sort()) {
  if (OPTIONAL.some(pattern => pattern.test(raw))) {
    console.log(`  --   ${raw}  (not offered by a password-only deployment)`)
    continue
  }
  // Substitute plausible values for the template placeholders.
  const path = raw
    .replace(/__deviceId__|__peerDeviceId__/g, '01ARZ3NDEKTSV4RRFFQ69G5FAV')
    .replace(/__connectionId__/g, 'probe-connection')
    .replace(/__qrId__/g, 'probe-qrid-000000000000000000')
    .replace(/__x__/g, 'probe')
    .replace(/\?.*$/, '')

  // Probe with GET and POST; the point is whether the route exists at all, and a
  // 404/405 pair is the signal that it does not.
  const results = []
  for (const method of ['GET', 'POST']) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.token}`,
      },
      ...(method === 'POST' ? { body: '{"v":1,"device":{}}' } : {}),
    })
    results.push({ method, status: response.status })
  }
  // A route exists if any method got past "no such route". 404 from the API layer is
  // ambiguous, so treat both 404 and 405 as missing only when both methods say so.
  const exists = results.some(r => r.status !== 404 && r.status !== 405)
  if (exists) {
    ok(raw, results.map(r => `${r.method} ${r.status}`).join(', '))
  } else {
    fail(raw, `both methods 404/405 — endpoint not implemented`)
    missing += 1
  }
}

console.log(`\n${steps.length - steps.filter(s => !s).length} passed, ${missing} missing`)
process.exit(missing === 0 ? 0 : 1)
