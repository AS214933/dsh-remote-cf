import { createManualChecks } from './manual-check.mjs'
/**
 * Validate every peer/device response against the client's own parsers.
 *
 * "The Server returned invalid authorized peer data" means a field the client requires
 * was missing. Rather than eyeball the JSON, this imports the client's `parseHostDevice`
 * and `parseAuthorizedPeer` shape checks by exercising the real `HostServerApi` methods,
 * so a mismatch fails here instead of in the UI.
 *
 *   npx tsx verify-peer-shape.mjs <server-url> <email> <password>
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'

const [baseUrl, email, password] = process.argv.slice(2)
if (!baseUrl || !email || !password) {
  console.error('usage: npx tsx verify-peer-shape.mjs <server-url> <email> <password>')
  process.exit(2)
}
const REPO = process.env.DSH_REPO
if (!REPO) { console.error('DSH_REPO must point at a ds-harness-remote checkout'); process.exit(2) }
const toUrl = p => `file://${p.replace(/\\/g, '/')}`

const { steps, ok, fail, check } = createManualChecks()

const { HostServerApi } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/server-api.ts')))
const { IdentityStore } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/identity-store.ts')))
const { ServerCredentialStore } = await import(toUrl(joinPath(REPO, 'packages/plugin/src/server-credentials.ts')))

async function main() {
  const dir = mkdtempSync(joinPath(tmpdir(), 'dsh-shape-'))
  console.log(`server : ${baseUrl}\n`)

  // A client and a host, both authorized, exactly as the UI leaves them.
  const clientIdentity = await new IdentityStore({ directory: joinPath(dir, 'client') }).loadOrCreate('shape-client')
  const hostIdentity = await new IdentityStore({ directory: joinPath(dir, 'host') }).loadOrCreate('shape-host')

  const clientApi = new HostServerApi(baseUrl, new ServerCredentialStore(joinPath(dir, 'client')), fetch, 'client')
  await clientApi.authorizeWithAccount(clientIdentity, email, password)
  const clientCreds = await clientApi.authenticate(clientIdentity)
  const hostApi = new HostServerApi(baseUrl, new ServerCredentialStore(joinPath(dir, 'host')), fetch, 'host')
  await hostApi.authorizeOwnedRole(hostIdentity, clientCreds.accessToken, clientCreds.account)
  await hostApi.authenticate(hostIdentity)
  ok('client and host authorized')

  console.log('\n=== 1. listDevices (the host picker) ===')
  let hosts = []
  try {
    hosts = await clientApi.listDevices()
    ok('listDevices parsed by the client', `${hosts.length} host(s)`)
    const mine = hosts.find(h => h.deviceId === hostIdentity.deviceId)
    check('the new host is listed', mine !== undefined)
    // The list must NOT carry identityKey — the client pins keys from the peer endpoint.
    const response = await fetch(`${baseUrl}/api/v1/devices`, {
      headers: { Authorization: `Bearer ${clientCreds.accessToken}` },
    })
    check('raw device list answers successfully', response.ok, `HTTP ${response.status}`)
    const raw = await response.json()
    check('raw device list has items', Array.isArray(raw.items))
    const leaked = raw.items.some(item => item.identityKey !== undefined)
    check('list omits identityKey', !leaked)
    const missingMembership = raw.items.some(item => typeof item.membershipId !== 'string')
    check('list has membershipId', !missingMembership)
  } catch (error) {
    fail('listDevices', error instanceof Error ? error.message : String(error))
    return report()
  }

  console.log('\n=== 2. deviceFor (the peer endpoint the client pins against) ===')
  try {
    // This is the call that produced "invalid authorized peer data".
    const peer = await clientApi.deviceFor(hostIdentity.deviceId)
    ok('deviceFor parsed by the client')
    check('  identityKey matches registered host', peer.identityKey === hostIdentity.publicKey)
    check('  role is host', peer.role === 'host')
  } catch (error) {
    fail('deviceFor', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  }

  console.log('\n=== 3. presence (used by the online badge) ===')
  try {
    const presence = await clientApi.presenceFor(hostIdentity.deviceId)
    check('presenceFor has a boolean online state', typeof presence.online === 'boolean', `online=${presence.online}`)
  } catch (error) {
    fail('presenceFor', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  }

  console.log('\n=== 4. the host can authenticate as itself ===')
  try {
    const me = await hostApi.authenticate(hostIdentity)
    ok('host credentials valid', `account=${me.account ?? '(none)'}`)
  } catch (error) {
    fail('host authenticate', error instanceof Error ? error.message : String(error))
  }

  return report()
}

function report() {
  const failed = steps.filter(s => !s).length
  console.log(`\n${steps.length - failed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch(error => { console.error('crashed:', error); process.exit(1) })
