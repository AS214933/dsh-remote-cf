/**
 * OBSOLETE — NOT CURRENT OIDC COVERAGE.
 *
 * The former generic OAUTH_PROVIDERS/mock-IdP flow was removed. Its legacy PASS
 * helper ignored predicates, so its historical totals must not be used as proof
 * of current Logto cookie, allowlist, replay or token behavior.
 *
 * Refuse before parsing a target or making any request. Current, isolated tests:
 *   npm test -- test/logto.test.ts test/oauth-flow.test.mjs
 *   npm run test:oauth-runtime
 *
 * These replacements use synthetic credentials and signed provider tokens; they
 * do not log in a user or create production devices.
 */
console.error('OBSOLETE: test/oauth-e2e.mjs does not test the current Logto/OIDC implementation.')
console.error('Use npm test -- test/logto.test.ts test/oauth-flow.test.mjs and npm run test:oauth-runtime instead.')
process.exitCode = 2
