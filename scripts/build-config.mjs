/**
 * Workers Builds adapter. Generate an ignored deployment file from private build
 * settings without logging it. Runtime secrets belong in Workers Secrets, not here.
 * Run: node scripts/build-config.mjs, then npm run deploy -- --config wrangler.build.local.jsonc
 */
import { writeFileSync } from 'node:fs'
function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing private build setting: ${name}`)
  return value
}
const name = required('DSH_BUILD_WORKER_NAME')
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error('Invalid Worker name')
let publicUrl
try { publicUrl = new URL(required('DSH_SERVER_PUBLIC_URL')) }
catch { throw new Error('DSH_SERVER_PUBLIC_URL must be a valid HTTPS origin (value withheld)') }
if (publicUrl.protocol !== 'https:' || publicUrl.port || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') {
  throw new Error('Public URL must be an HTTPS origin')
}
const vars = { DSH_SERVER_ACCOUNT: required('DSH_SERVER_ACCOUNT'), DSH_SERVER_PUBLIC_URL: publicUrl.origin }
for (const key of ['DSH_SERVER_PASSWORD_LOGIN', 'LOGTO_ENDPOINT', 'LOGTO_CLIENT_ID', 'OAUTH_ALLOWED_ACCOUNTS',
  'DSH_SERVER_OIDC_ADMISSION', 'DSH_SERVER_MAX_TENANTS', 'DSH_SERVER_LEGACY_OWNER_ISSUER',
  'DSH_SERVER_LEGACY_OWNER_SUBJECT', 'DSH_SERVER_IDENTITY_ENROLLMENT_ONLY',
  'DSH_SERVER_ALLOW_CONCURRENT_HOSTS', 'DSH_SERVER_ALLOWED_ORIGINS']) {
  if (process.env[key]?.trim()) vars[key] = process.env[key].trim()
}
// Explicit application admission is opt-in. Stable tenant ownership is issuer+sub,
// never any allowlist email. Enrollment capability stays a runtime Secret.
const config = {
  $schema: 'node_modules/wrangler/config-schema.json', name, main: 'src/worker.ts',
  compatibility_date: '2026-04-07', compatibility_flags: ['nodejs_compat'],
  durable_objects: { bindings: [{ name: 'GATEWAY', class_name: 'Gateway' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['Gateway'] }],
  assets: { directory: './public', binding: 'ASSETS', run_worker_first: true, not_found_handling: 'none' },
  observability: { enabled: true, redact_query_string: true }, workers_dev: false,
  routes: [{ pattern: publicUrl.hostname, custom_domain: true }], vars,
}
if (process.env.CLOUDFLARE_ACCOUNT_ID?.trim()) config.account_id = process.env.CLOUDFLARE_ACCOUNT_ID.trim()
writeFileSync('wrangler.build.local.jsonc', `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
console.log('Generated ignored build config; private values withheld. Runtime Secrets are not generated or replaced.')
