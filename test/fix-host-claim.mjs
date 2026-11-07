/**
 * Register the local Host and write its credentials, bypassing the plugin's silent
 * skip.
 *
 * Why this exists: `ClientModeRuntime.authorizeHostByDefault()` begins with
 * `if (this.host === undefined) return`, so when the Host control is not wired into
 * the runtime the registration is skipped with no error at all. The UI then reports
 * AUTH_INVALID forever, because the Host keeps presenting a device id the server has
 * never seen. Confirmed from the server log: `register-owned-role` was never called.
 *
 * This performs the one request the plugin skipped, using the Host identity already on
 * disk, and writes the result where the plugin expects to find it.
 *
 * OPERATOR REPAIR UTILITY, NOT AN AUTOMATED TEST. Re-registration replaces live
 * Host credentials and can invalidate its old tokens. Stop the Host first.
 *
 *   DSH_TEST_PASSWORD=<protected-value> node test/fix-host-claim.mjs <server-url> <email> --state-root <server-state-directory> [--apply]
 *
 * Without --apply this only checks paths. An explicit scoped state directory is
 * mandatory; no home-profile discovery occurs. A backup is made before overwriting.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, copyFileSync, constants } from 'node:fs'
import { join, resolve } from 'node:path'

const [serverUrl, email, ...flags] = process.argv.slice(2)
const stateIndex = flags.indexOf('--state-root')
const rootArg = stateIndex >= 0 ? flags[stateIndex + 1] : null
const apply = flags.includes('--apply')
const password = process.env.DSH_TEST_PASSWORD
const validFlags = flags.filter((_, index) => index !== stateIndex && index !== stateIndex + 1)
if (validFlags.some(flag => flag !== '--apply')) throw new Error('Unsupported repair flag')
if (!serverUrl || !email || !rootArg || (apply && !password)) {
  console.error('usage: node test/fix-host-claim.mjs <server-url> <email> --state-root <server-state-directory> [--apply]; apply requires DSH_TEST_PASSWORD')
  process.exit(2)
}
const target = new URL(serverUrl)
if (target.username || target.password || target.search || target.hash || target.pathname !== '/') throw new Error('server-url must be an origin')
const root = resolve(rootArg)
const hostDir = join(root, 'host')
const hostDevicePath = join(hostDir, 'device.json')
const hostCredPath = join(hostDir, 'server-credentials.json')

const readJson = p => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null)

console.log(`server : ${serverUrl}`)
console.log(`state  : ${root}\n`)

if (!apply) {
  console.log('DRY RUN: no profile content read, no network or credential write. Stop Host and add --apply only for intentional repair.')
  console.log(`identity exists: ${existsSync(hostDevicePath)}; credentials exist: ${existsSync(hostCredPath)}`)
  process.exit(0)
}
if (existsSync(hostCredPath)) {
  copyFileSync(hostCredPath, `${hostCredPath}.${Date.now()}.backup`, constants.COPYFILE_EXCL)
  console.log('Existing credential file backed up locally; keep the backup private.')
}

const hostDevice = readJson(hostDevicePath)
if (hostDevice === null) {
  console.error(`no Host identity at ${hostDevicePath}`)
  console.error('Start the Host once so the plugin creates its key pair, then re-run.')
  process.exit(1)
}
console.log(`host device : ${hostDevice.deviceId}`)
console.log(`host name   : ${hostDevice.name}`)

async function main() {
  // The authorizing credential must be a device token of this account. Sign in and
  // register a client device for that purpose; the Host's own token comes later.
  console.log('\n=== 1. sign in ===')
  const login = await fetch(`${serverUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const loginBody = await login.json().catch(() => null)
  if (!login.ok || typeof loginBody?.token !== 'string') {
    console.error(`login failed: ${login.status}`)
    process.exit(1)
  }
  console.log(`  ok, account=${loginBody.account}`)

  console.log('\n=== 2. obtain an authorizing device token ===')
  // Reuse the client credentials already on disk when they still work; otherwise
  // register a fresh client device with the session.
  const clientCreds = readJson(join(root, 'client', 'server-credentials.json'))
  let authorizingToken = null
  if (clientCreds !== null) {
    const check = await fetch(`${serverUrl}/api/v1/me`, {
      headers: { Authorization: `Bearer ${clientCreds.accessToken}` },
    })
    if (check.ok) {
      authorizingToken = clientCreds.accessToken
      console.log(`  reusing stored client token (${clientCreds.deviceId})`)
    }
  }
  if (authorizingToken === null) {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
    let deviceId = ''
    for (let i = 0; i < 26; i += 1) deviceId += alphabet[Math.floor(Math.random() * 32)]
    const keyAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    let identityKey = ''
    for (let i = 0; i < 42; i += 1) identityKey += keyAlphabet[Math.floor(Math.random() * 64)]
    identityKey += 'AEIMQUYcgkosw048'[Math.floor(Math.random() * 16)]
    const registered = await fetch(`${serverUrl}/api/v1/devices/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginBody.token}`,
      },
      body: JSON.stringify({
        v: 1,
        device: {
          deviceId, name: 'host-claim-helper', role: 'client', platform: process.platform,
          identityKey, clientVersion: '0.6.3',
        },
      }),
    })
    const body = await registered.json().catch(() => null)
    if (!registered.ok) {
      console.error(`  client registration failed: ${registered.status}`)
      process.exit(1)
    }
    authorizingToken = body.accessToken
    console.log(`  registered helper client ${deviceId}`)
  }

  console.log('\n=== 3. register the Host as an owned device ===')
  // The exact request `authorizeOwnedRole` would send, with the Host's real identity.
  const claim = await fetch(`${serverUrl}/api/v1/devices/register-owned-role`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authorizingToken}`,
    },
    body: JSON.stringify({
      v: 1,
      device: {
        deviceId: hostDevice.deviceId,
        name: hostDevice.name,
        role: 'host',
        platform: process.platform,
        identityKey: hostDevice.publicKey,
        clientVersion: '0.6.3',
        harnessVersion: '0.2.2',
      },
    }),
  })
  const tokens = await claim.json().catch(() => null)
  if (!claim.ok || typeof tokens?.accessToken !== 'string') {
    console.error(`  claim failed: ${claim.status}`)
    process.exit(1)
  }
  console.log('  ok, access token issued (value withheld)')

  console.log('\n=== 4. write the credential file the plugin reads ===')
  // Schema matches what `ServerCredentialStore` parses; a mismatch makes the plugin
  // throw ServerCredentialsInvalidError rather than silently ignore the file.
  const record = {
    schemaVersion: 1,
    serverUrl,
    deviceId: hostDevice.deviceId,
    account: loginBody.account,
    authorizationMethod: 'owned_device',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
  }
  mkdirSync(hostDir, { recursive: true })
  writeFileSync(hostCredPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  try { chmodSync(hostCredPath, 0o600) } catch { /* best effort on Windows */ }
  console.log(`  wrote ${hostCredPath}`)

  console.log('\n=== 5. verify the Host can authenticate ===')
  const me = await fetch(`${serverUrl}/api/v1/me`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  })
  const meBody = await me.json().catch(() => null)
  console.log(`  GET /api/v1/me -> ${me.status} role=${meBody?.role} name=${meBody?.name}`)
  if (me.ok && meBody?.role === 'host') {
    console.log('\nHost is registered and authorized. Restart DSH, then reconnect.')
  } else {
    console.log('\nthe Host token did not resolve to a host device — check the output above')
    process.exit(1)
  }
}

main().catch(error => { console.error('failed:', error); process.exit(1) })
