import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { check, createManualChecks } from './manual-check.mjs'

// Built-in require avoids old Vite resolvers interpreting child_process as a browser dependency.
const { spawnSync } = createRequire(import.meta.url)('node:child_process')
const helperUrl = new URL('./manual-check.mjs', import.meta.url).href

function isolatedCheck(expression) {
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { check } from ${JSON.stringify(helperUrl)}; check('isolated predicate', ${expression});`],
  { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)) })
}

describe('manual diagnostic assertions', () => {
  it('requires exact true; neither false nor a display string passes', () => {
    expect(check('valid predicate', true, 'safe metadata')).toBe(true)
    expect(() => check('failed predicate', false, 'actual differs')).toThrow('failed predicate')
    for (const condition of ['false', 'exact match', 1, null, undefined, [], {}]) {
      expect(() => check('not boolean', condition)).toThrow('condition must be a boolean')
    }
    expect(() => check('', true)).toThrow('nonempty string')
  })

  it('records failed predicates even if the caller catches them', () => {
    const output = vi.fn()
    const checks = createManualChecks(output)
    checks.ok('guarded operation completed', 'no exception')
    checks.check('actual condition', 2 + 2 === 4)
    expect(() => checks.check('mismatched payload', 'actual' === 'expected', 'not equal')).toThrow('mismatched payload')
    expect(checks.steps).toEqual([true, true, false])
    expect(output).toHaveBeenLastCalledWith(expect.stringContaining('FAIL mismatched payload'))
  })

  it('refuses predicates passed into the old detail position', () => {
    const checks = createManualChecks(vi.fn())
    expect(() => checks.ok('old false detail', false)).toThrow('detail must be text')
    expect(() => checks.ok('old true detail', true)).toThrow('detail must be text')
    expect(() => checks.ok(false, 'conditional title')).toThrow('nonempty string')
    checks.fail('explicit failure', 'guard failed')
    expect(checks.steps).toEqual([false, false, false, false])
  })

  it('exits nonzero in a fresh process for a false check', () => {
    const failed = isolatedCheck('false')
    expect(failed.error).toBeUndefined()
    expect(failed.status).not.toBe(0)
    expect(failed.stderr).toContain('isolated predicate')
  })

  it('keeps current manual scripts on the shared strict helpers', () => {
    for (const name of ['data-plane', 'webrtc-path', 'turn-relay', 'host-connect', 'client-flow',
      'endpoint-contract', 'rpc-tunnel', 'soak', 'reconnect-race', 'verify-peer-shape', 'e2e']) {
      const source = readFileSync(new URL(`./${name}.mjs`, import.meta.url), 'utf8')
      expect(source).toContain("from './manual-check.mjs'")
      expect(source).not.toMatch(/const\s+ok\s*=/)
    }
  })

  it('marks the obsolete OAuth harness noncurrent without a network path', () => {
    const source = readFileSync(new URL('./oauth-e2e.mjs', import.meta.url), 'utf8')
    expect(source).toContain('OBSOLETE')
    expect(source).toContain('process.exitCode = 2')
    expect(source).not.toMatch(/\bfetch\s*\(/)
  })

  it('exits nonzero for wrong predicate types and zero only for true', () => {
    const wrongType = isolatedCheck(JSON.stringify('false'))
    expect(wrongType.error).toBeUndefined()
    expect(wrongType.status).not.toBe(0)
    expect(wrongType.stderr).toContain('condition must be a boolean')
    const passed = isolatedCheck('true')
    expect(passed.error).toBeUndefined()
    expect(passed.status).toBe(0)
  })
})
