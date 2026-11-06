/**
 * Single-account credential check, matching the reference server's model.
 *
 * One account comes from the environment (`DSH_SERVER_ACCOUNT` +
 * `DSH_SERVER_PASSWORD`). There is no user table, no identity provider, and no
 * registration flow — exactly like the self-hosted server this is a port of.
 *
 * Comparison is SHA-256 then a constant-time compare, which is what the reference
 * implementation does. No KDF is applied *on purpose*: the password is supplied by
 * the operator at deploy time and is never stored anywhere, so there is no stored
 * verifier for an attacker to grind offline. Online guessing is bounded by the
 * rate limits and the lockout instead.
 */
import type { Env } from './env.js'
import { sha256Hex, timingSafeEqualBytes } from './crypto.js'

export type LoginOutcome =
  | { ok: true; account: string }
  | { ok: false; reason: 'invalid' | 'misconfigured' }

/**
 * Both comparisons always run, and neither short-circuits.
 *
 * `a && b` would skip the password hash when the address is wrong, which makes a
 * wrong address measurably cheaper than a wrong password and turns response time
 * into an oracle for "is this the right account name". Evaluating both keeps the
 * cost identical; the digests are equal length so the compare itself is constant
 * time.
 */
export async function verifyCredentials(env: Env, email: string, password: string): Promise<LoginOutcome> {
  const configuredAccount = env.DSH_SERVER_ACCOUNT?.trim() ?? ''
  const configuredPassword = env.DSH_SERVER_PASSWORD ?? ''
  if (configuredAccount === '' || configuredPassword === '') {
    // Misconfiguration must not be indistinguishable from a wrong password, or an
    // operator would see "wrong password" forever with no clue what is missing.
    return { ok: false, reason: 'misconfigured' }
  }

  const [emailHash, accountHash, passwordHash, expectedHash] = await Promise.all([
    sha256Hex(email.trim()),
    sha256Hex(configuredAccount),
    sha256Hex(password),
    sha256Hex(configuredPassword),
  ])
  const encoder = new TextEncoder()
  const emailMatches = timingSafeEqualBytes(encoder.encode(emailHash), encoder.encode(accountHash))
  const passwordMatches = timingSafeEqualBytes(encoder.encode(passwordHash), encoder.encode(expectedHash))
  if (!emailMatches || !passwordMatches) return { ok: false, reason: 'invalid' }
  return { ok: true, account: configuredAccount }
}

/**
 * Minimum password length accepted at startup.
 *
 * Lower than the reference server's 12 because this is a single-operator
 * deployment where the password is chosen by the person who owns the account, and a
 * hard 12-character floor would reject a legitimate short secret outright. The
 * defence that actually matters here is the lockout and the rate limits, both of
 * which are independent of length. Set it higher if the password is reused
 * anywhere; this floor only stops an obviously trivial one.
 */
export const MIN_PASSWORD_LENGTH = 8

/** Fail fast and loudly when the deployment is not usable. */
export function assertConfigured(env: Env): void {
  if (!env.DSH_SERVER_ACCOUNT?.trim()) {
    throw new Error('DSH_SERVER_ACCOUNT is required')
  }
  if ((env.DSH_SERVER_PASSWORD ?? '').length < MIN_PASSWORD_LENGTH) {
    throw new Error(`DSH_SERVER_PASSWORD (at least ${MIN_PASSWORD_LENGTH} characters) is required`)
  }
  const publicUrl = env.DSH_SERVER_PUBLIC_URL?.trim()
  if (!publicUrl) throw new Error('DSH_SERVER_PUBLIC_URL is required')
  const url = new URL(publicUrl)
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new Error('DSH_SERVER_PUBLIC_URL must be an origin (no path, query or credentials)')
  }
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 16) {
    throw new Error('SESSION_SECRET (at least 16 characters) is required to sign session cookies')
  }
}

/**
 * Whether the password form is turned off.
 *
 * `DSH_SERVER_PASSWORD_LOGIN=disabled` leaves OIDC as the only way in. The account and
 * password stay configured — `assertConfigured` still requires them — so flipping the
 * switch back does not require reconfiguring the deployment.
 */
export function passwordLoginDisabled(env: Env): boolean {
  const value = env.DSH_SERVER_PASSWORD_LOGIN?.trim().toLowerCase()
  return value === 'disabled' || value === 'off' || value === 'false'
}
