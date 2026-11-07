/**
 * Fail-closed assertions for opt-in, live manual diagnostics.
 *
 * `check` accepts a real boolean, never a truthy detail string. `ok` records only
 * a milestone already guarded by an exception/failure path; use check for facts.
 * No network, profile access, or process exit happens merely by importing this.
 */
export function check(name, condition, detail = '') {
  validateText(name, detail)
  if (typeof condition !== 'boolean') throw new TypeError(`${name}: condition must be a boolean`)
  if (!condition) throw new Error(`${name}${detail ? ` — ${detail}` : ''}`)
  return true
}

function validateText(name, detail) {
  if (typeof name !== 'string' || name.trim() === '') throw new TypeError('check name must be a nonempty string')
  if (typeof detail !== 'string') throw new TypeError(`${name}: detail must be text; pass predicates to check(name, boolean, detail)`)
}

export function createManualChecks(log = console.log) {
  const steps = []
  const record = (name, pass, detail) => {
    steps.push(pass)
    log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  }
  return {
    steps,
    check(name, condition, detail = '') {
      try { check(name, condition, detail) }
      catch (error) {
        // Even a caller that catches an assertion cannot turn the final summary green.
        record(typeof name === 'string' ? name : 'invalid check', false, typeof detail === 'string' ? detail : '')
        throw error
      }
      record(name, true, detail)
    },
    ok(name, detail = '') {
      try { validateText(name, detail) }
      catch (error) {
        record(typeof name === 'string' ? name : 'invalid milestone', false, typeof detail === 'string' ? detail : '')
        throw error
      }
      record(name, true, detail)
    },
    fail(name, detail = '') {
      validateText(name, detail)
      record(name, false, detail)
    },
  }
}
