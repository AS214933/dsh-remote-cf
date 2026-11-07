/** Require an explicit, ignored deployment config rather than deploying the template. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const args = process.argv.slice(2)
const configOptions = args.filter(arg => arg === '--config' || arg === '-c' || arg.startsWith('--config=') || arg.startsWith('-c'))
if (configOptions.length > 1 || configOptions.some(arg => arg !== '--config' && arg !== '-c')) {
  console.error('Pass exactly one standalone --config <private-file>; duplicate or equals-form config flags are rejected.')
  process.exit(2)
}
const index = args.findIndex(arg => arg === '--config' || arg === '-c')
const config = index >= 0 ? args[index + 1] : process.env.DSH_DEPLOY_CONFIG
if (config?.startsWith('-')) { console.error('Missing config path'); process.exit(2) }
if (!config || !existsSync(config)) {
  console.error('Set DSH_DEPLOY_CONFIG or pass --config <private-config>. Copy wrangler.jsonc to an ignored *.local.jsonc first.')
  process.exit(2)
}
if (!path.basename(config).endsWith('.local.jsonc')) {
  console.error('Refusing to deploy a public template. Use an ignored *.local.jsonc deployment config.')
  process.exit(2)
}
const script = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
const rest = index >= 0 ? args.filter((_, position) => position !== index && position !== index + 1) : args
const result = spawnSync(process.execPath, [script, 'deploy', '--config', config, ...rest], { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
