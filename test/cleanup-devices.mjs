/**
 * Operator utility, NOT an automated test. Lists a narrowly selected test-device
 * set; dry-run is the default. Supply --apply to revoke the listed devices.
 * Never use against a shared account unless every matching device is disposable.
 * Password login must be enabled on the disposable target. OIDC-only deployments
 * should manage devices through their authenticated client instead.
 *
 * node test/cleanup-devices.mjs <server-url> <email> [--apply]
 * Provide DSH_TEST_PASSWORD through a protected environment, not a CLI argument.
 */
const [serverUrl, email, ...flags] = process.argv.slice(2)
const password = process.env.DSH_TEST_PASSWORD
if (!serverUrl || !email || !password || flags.some(flag => !['--apply', '--dry-run'].includes(flag))
  || (flags.includes('--apply') && flags.includes('--dry-run'))) {
  console.error('usage: DSH_TEST_PASSWORD=<protected-value> node test/cleanup-devices.mjs <server-url> <email> [--apply]')
  process.exit(2)
}
const target = new URL(serverUrl)
if (target.username || target.password || target.search || target.hash || target.pathname !== '/') {
  console.error('server-url must be an origin, without credentials, path or query')
  process.exit(2)
}
const dryRun = !flags.includes('--apply')
const TEST_PREFIXES = [
  'cf-test-', 'data-host-', 'data-client-', 'flow-host', 'flow-client',
  'replay-host', 'replay-client', 'rpc-host-', 'rpc-client-',
  'rtc-host-', 'rtc-client-', 'shape-host', 'shape-client',
  'soak-host-', 'soak-client-', 'turn-host-', 'turn-client-', 'diag-host',
]
const isTestDevice = device => typeof device.name === 'string' && TEST_PREFIXES.some(prefix => device.name.startsWith(prefix))
async function main() {
  console.log(`mode: ${dryRun ? 'DRY RUN (no revocations)' : 'APPLY (revocations enabled)'}`)
  const login = await fetch(`${target.origin}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  })
  const session = await login.json().catch(() => null)
  if (!login.ok || typeof session?.token !== 'string') throw new Error(`login failed HTTP ${login.status}`)
  const headers = { Authorization: `Bearer ${session.token}` }
  const response = await fetch(`${target.origin}/api/v1/account/devices`, { headers })
  if (!response.ok) throw new Error(`list failed HTTP ${response.status}`)
  const { items } = await response.json()
  if (!Array.isArray(items)) throw new Error('device response missing items')
  const targets = items.filter(isTestDevice)
  console.log(`matching disposable-name devices: ${targets.length}; other devices left untouched: ${items.length - targets.length}`)
  for (const device of targets) console.log(`  ${device.role} ${device.name}`)
  if (dryRun) { console.log('dry run: authentication/listing only; no DELETE requests sent'); return }
  for (const device of targets) {
    const removed = await fetch(`${target.origin}/api/v1/account/devices/${encodeURIComponent(device.deviceId)}`, { method: 'DELETE', headers })
    if (!removed.ok) throw new Error(`revoke failed HTTP ${removed.status}; stop and inspect before retrying`)
  }
  console.log(`revoked ${targets.length} selected test devices`)
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
