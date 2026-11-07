/** Require an explicit, ignored deployment config rather than deploying the template. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const args = process.argv.slice(2)
const index = args.findIndex(arg => arg === '--config' || arg === '-c')
const config = index >= 0 ? args[index + 1] : process.env.DSH_DEPLOY_CONFIG
if (!config || !existsSync(config)) {
  console.error('Set DSH_DEPLOY_CONFIG or pass --config <private-config>. Copy wrangler.jsonc to an ignored *.local.jsonc first.')
  process.exit(2)
}
if (!path.basename(config).endsWith('.local.jsonc')) {
  console.error('Refusing to deploy a public template. Use an ignored *.local.jsonc deployment config.')
  process.exit(2)
}
const script = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))
const result = spawnSync(process.execPath, [script, 'deploy', ...(index >= 0 ? args : ['--config', config, ...args])], { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
