/**
 * Reproduce the plugin's actual sign-in flow.
 *
 * The earlier tests covered `authorizeWithAccount` in isolation, which passes as soon
 * as the login and the plain registration work. The real UI does more: it signs in as
 * a **client**, then has the local **Host** adopt the same account through
 * `/api/v1/devices/register-owned-role`. Missing that endpoint is invisible to a
 * per-endpoint test and fatal in the UI — the user signs in successfully and is then
 * shown a host picker with nothing in it.
 *
 *   npx tsx client-flow.mjs <server-url> <email> <password>
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'

const [baseUrl, email, password] = process.argv.slice(2)
if (!baseUrl || !email || !password) {
  console.error('usage: npx tsx client-flow.mjs <server-url> <email> <password>')
  process.exit(2)
}
const REPO = process.env.DSH_REPO
if (!REPO) { console.error('DSH_REPO must point at a ds-harness-remote checkout'); process.exit(2) }
const toUrl = p => `file://${p.replace(/\\/g, '/')}`

const steps = []
const ok = (n, d = '') => { steps.push(true); console.log(`  ok   ${n}${d ? ` — ${d}` : ''}`) }
const fail = (n, d = '') => { steps.push(false); console.log(`  FAIL ${n}${d ? ` — ${d}` : ''}`) }

const { HostServerApi } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/server-api.ts')))
const { IdentityStore } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/identity-store.ts')))
const { ServerCredentialStore } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/server-credentials.ts')))

async function main() {
  const dir = mkdtempSync(joinPath(tmpdir(), 'dsh-flow-'))
  console.log(`server : ${baseUrl}\n`)

  // Two identities in one process, exactly as the plugin has: a client device and a
  // host device, each with its own key pair and credential file.
  const clientIdentity = await new IdentityStore({ directory: joinPath(dir, 'client') }).loadOrCreate('flow-client')
  const hostIdentity = await new IdentityStore({ directory: joinPath(dir, 'host') }).loadOrCreate('flow-host')
  ok('two identities', `client=${clientIdentity.deviceId.slice(0, 8)}… host=${hostIdentity.deviceId.slice(0, 8)}…`)

  const clientApi = new HostServerApi(baseUrl, new ServerCredentialStore(joinPath(dir, 'client')), fetch, 'client')

  console.log('\n=== 1. discovery the UI does on mount ===')
  try {
    const providers = await clientApi.oauthProviders()
    ok('oauthProviders answered', `${providers.length} provider(s)`)
    ok('empty list is the correct answer for a password-only server', providers.length === 0 ? 'none configured' : 'unexpected')
  } catch (error) {
    fail('oauthProviders', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  }

  console.log('\n=== 2. client sign-in (what the login button does) ===')
  let authorization
  try {
    authorization = await clientApi.authorizeWithAccount(clientIdentity, email, password)
    ok('client authorizeWithAccount', `method=${authorization.method}`)
  } catch (error) {
    fail('client authorizeWithAccount', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    return report()
  }

  console.log('\n=== 3. the Host adopts the same account ===')
  // This is `authorizeHostAsOwned` -> `authorizeOwnedRole` ->
  // POST /api/v1/devices/register-owned-role. It is the step that was missing.
  const hostApi = new HostServerApi(baseUrl, new ServerCredentialStore(joinPath(dir, 'host')), fetch, 'host')
  try {
    const credentials = await clientApi.authenticate(clientIdentity)
    ok('client credentials loaded', `account=${credentials.account ?? '(none)'}`)
    const owned = await hostApi.authorizeOwnedRole(hostIdentity, credentials.accessToken, credentials.account)
    ok('Host adopted the account', `method=${owned.method}`)
  } catch (error) {
    fail('Host adoption', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    return report()
  }

  console.log('\n=== 4. the Host can now authenticate and connect ===')
  let hostCredentials
  try {
    hostCredentials = await hostApi.authenticate(hostIdentity)
    ok('Host credentials issued', `accessToken=${String(hostCredentials.accessToken).slice(0, 8)}…`)
  } catch (error) {
    fail('Host authenticate', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    return report()
  }

  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws/v1/connect`)
  const frames = []
  socket.addEventListener('message', event => {
    try { frames.push(JSON.parse(String(event.data))) } catch { /* ignore */ }
  })
  const upgraded = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 10_000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(true) }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); resolve(false) }, { once: true })
  })
  if (!upgraded) { fail('Host websocket upgrade'); return report() }
  socket.send(JSON.stringify({
    v: 1, id: crypto.randomUUID(), type: 'hello', timestamp: Date.now(),
    payload: {
      role: 'host', deviceId: hostIdentity.deviceId, accessToken: hostCredentials.accessToken,
      protocols: [1], capabilities: ['transport.relay'], clientVersion: '0.4.15',
    },
  }))
  const ackDeadline = Date.now() + 10_000
  let ack = null
  while (ack === null && Date.now() < ackDeadline) {
    ack = frames.find(f => f.type === 'hello.ack') ?? null
    if (ack === null) await new Promise(r => setTimeout(r, 100))
  }
  if (ack === null) { fail('Host hello.ack'); return report() }
  ok('Host online', `heartbeat=${ack.payload.heartbeatIntervalMs}ms`)

  console.log('\n=== 5. the client can see that Host ===')
  try {
    const devices = await clientApi.listDevices()
    const found = devices.some(device => device.deviceId === hostIdentity.deviceId)
    ok('client listDevices includes the host', found ? 'yes' : `no (${devices.length} device(s))`)
    if (!found) {
      for (const device of devices) console.log(`       ${device.role} ${device.deviceId.slice(0, 8)}… online=${device.online}`)
    }
  } catch (error) {
    fail('client listDevices', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  }

  try { socket.close() } catch { /* already closed */ }
  return report()
}

function report() {
  const failed = steps.filter(s => !s).length
  console.log(`\n${steps.length - failed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => { console.error('crashed:', error); process.exit(1) })
