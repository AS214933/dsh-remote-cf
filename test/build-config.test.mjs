import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const script = fileURLToPath(new URL('../scripts/build-config.mjs', import.meta.url))
describe('private Workers Builds configuration', () => {
  it('generates ignored neutral deployment settings without runtime secret values', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'dsh-config-test-'))
    try {
      const run = spawnSync(process.execPath, [script], { cwd, encoding: 'utf8', env: { ...process.env,
        DSH_BUILD_WORKER_NAME: 'test-worker', DSH_SERVER_PUBLIC_URL: 'https://remote.example.com',
        DSH_SERVER_ACCOUNT: 'owner@example.com', DSH_SERVER_PASSWORD_LOGIN: 'disabled',
        SESSION_SECRET: 'must-not-copy-runtime-secret', LOGTO_CLIENT_SECRET: 'must-not-copy-runtime-secret',
      } })
      expect(run.status).toBe(0)
      const text = readFileSync(path.join(cwd, 'wrangler.build.local.jsonc'), 'utf8')
      const config = JSON.parse(text)
      expect(config.name).toBe('test-worker')
      expect(config.vars.DSH_SERVER_PASSWORD_LOGIN).toBe('disabled')
      expect(config.observability.redact_query_string).toBe(true)
      expect(config.durable_objects.bindings[0]).toEqual({ name: 'GATEWAY', class_name: 'Gateway' })
      expect(text).not.toContain('must-not-copy-runtime-secret')
      expect(run.stdout).not.toContain('remote.example.com')
      expect(run.stdout).not.toContain('owner@example.com')
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  })
  it('fails closed if private build identity is missing', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'dsh-config-test-'))
    try {
      const env = { ...process.env }; delete env.DSH_BUILD_WORKER_NAME
      expect(spawnSync(process.execPath, [script], { cwd, env, encoding: 'utf8' }).status).not.toBe(0)
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  })
})
