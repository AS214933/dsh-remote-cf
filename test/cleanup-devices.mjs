/**
 * Remove test devices created during development, keeping the operator's real ones.
 *
 * Matches by explicit name prefix rather than by "everything else": a cleanup script
 * that deletes whatever it does not recognise is one bug away from removing a real
 * device, and a revoked device cannot be restored without re-pairing.
 *
 *   node cleanup-devices.mjs <server-url> <email> <password> [--dry-run]
 */
const [serverUrl, email, password, flag] = process.argv.slice(2)
if (!serverUrl || !email || !password) {
  console.error('usage: node cleanup-devices.mjs <server-url> <email> <password> [--dry-run]')
  process.exit(2)
}
const dryRun = flag === '--dry-run'

// Every name the test scripts generate. Kept as explicit prefixes so an unexpected
// name is left alone and reported instead of swept up.
const TEST_PREFIXES = [
  'cf-test-', 'data-host-', 'data-client-', 'flow-host', 'flow-client',
  'replay-host', 'replay-client', 'rpc-host-', 'rpc-client-',
  'rtc-host-', 'rtc-client-', 'shape-host', 'shape-client',
  'soak-host-', 'soak-client-', 'turn-host-', 'turn-client-',
  'diag-host',
]

// Devices that must survive: the operator's real host, client and phone.
const KEEP_NAMES = new Set(['EXAMPLE-WORKSTATION', 'DSH App (Android)'])

// An orphaned identity from before the local state was cleared. It shares the display
// name with the live client, so only the id distinguishes it — and it can never
// reconnect, because its private key was deleted with the old state directory.
const ORPHAN_DEVICE_IDS = new Set(['00000000-0000-4000-8000-000000000001'])

const isTestDevice = device =>
  TEST_PREFIXES.some(prefix => device.name.startsWith(prefix))
  || ORPHAN_DEVICE_IDS.has(device.deviceId)

async function main() {
  console.log(`server : ${serverUrl}`)
  console.log(`mode   : ${dryRun ? 'DRY RUN (nothing deleted)' : 'DELETE'}\n`)

  const login = await fetch(`${serverUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const session = await login.json().catch(() => null)
  if (!login.ok || typeof session?.token !== 'string') {
    console.error(`login failed: ${login.status}`)
    process.exit(1)
  }

  const list = await fetch(`${serverUrl}/api/v1/account/devices`, {
    headers: { Authorization: `Bearer ${session.token}` },
  }).then(r => r.json())
  const devices = list.items ?? []
  console.log(`devices: ${devices.length}`)

  const targets = devices.filter(isTestDevice)
  const keepers = devices.filter(d => !isTestDevice(d))

  console.log(`\nwill delete ${targets.length}:`)
  for (const device of targets) console.log(`  - ${device.role.padEnd(6)} ${device.name}`)

  console.log(`\nwill keep ${keepers.length}:`)
  for (const device of keepers) {
    const expected = KEEP_NAMES.has(device.name)
    // Anything kept that is not one of the known real devices is surfaced rather
    // than silently retained, so an unrecognised name gets a human decision.
    console.log(`  ${expected ? '·' : '?'} ${device.role.padEnd(6)} ${device.name}  ${expected ? '' : '(unrecognised — keeping anyway)'}`)
  }

  if (dryRun) {
    console.log('\ndry run: no requests sent')
    return
  }

  console.log('\ndeleting...')
  let removed = 0
  let failed = 0
  for (const device of targets) {
    // Account-scoped revoke. The reference server has no equivalent — a device can
    // only revoke itself there — so this endpoint exists specifically so an operator
    // can remove devices they no longer control.
    const response = await fetch(`${serverUrl}/api/v1/account/devices/${encodeURIComponent(device.deviceId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.token}` },
    })
    if (response.ok) { removed += 1; console.log(`  removed ${device.name}`) }
    else { failed += 1; console.log(`  FAILED  ${device.name} -> ${response.status}`) }
  }

  const after = await fetch(`${serverUrl}/api/v1/account/devices`, {
    headers: { Authorization: `Bearer ${session.token}` },
  }).then(r => r.json())
  const remaining = after.items ?? []
  console.log(`\nremoved ${removed}, failed ${failed}`)
  console.log(`remaining devices: ${remaining.length}`)
  for (const device of remaining) console.log(`  · ${device.role.padEnd(6)} ${device.name}`)
}

main().catch(error => { console.error('cleanup failed:', error); process.exit(1) })
