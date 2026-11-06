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
 *   node fix-host-claim.mjs <server-url> <email> <password>
 *
 * Safe to re-run: it reuses the existing Host identity, so the device id stays stable
 * and previously pinned peers keep working.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'

const [serverUrl, email, password] = process.argv.slice(2)
if (!serverUrl || !email || !password) {
  console.error('usage: node fix-host-claim.mjs <server-url> <email> <password>')
  process.exit(2)
}

const scope = createHash('sha256').update(serverUrl).digest('hex').slice(0, 24)
const root = join(homedir(), '.dsh', 'remote', 'servers', scope)
const hostDir = join(root, 'host')
const hostDevicePath = join(hostDir, 'device.json')
const hostCredPath = join(hostDir, 'server-credentials.json')

const readJson = p => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null)

console.log(`server : ${serverUrl}`)
console.log(`state  : ${root}\n`)

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
    console.error(`login failed: ${login.status} ${JSON.stringify(loginBody)?.slice(0, 200)}`)
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
      console.error(`  client registration failed: ${registered.status} ${JSON.stringify(body)?.slice(0, 200)}`)
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
    console.error(`  claim failed: ${claim.status} ${JSON.stringify(tokens)?.slice(0, 300)}`)
    process.exit(1)
  }
  console.log(`  ok, access token issued (${String(tokens.accessToken).slice(0, 10)}…)`)

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
