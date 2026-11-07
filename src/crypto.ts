/**
 * Crypto helpers built on Web Crypto (the only option in Workers).
 *
 * Note what is NOT here: password hashing. Passwords never reach this server —
 * Logto owns them — so there is no need for scrypt/argon2, which Workers cannot
 * run anyway. Everything below is either a digest or an HMAC.
 */

const encoder = new TextEncoder()

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** URL-safe random token, 32 bytes of entropy. */
export function randomToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

export async function hmacSha256(secret: string, message: string): Promise<ArrayBuffer> {
  return crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(message))
}

/** Compare two byte strings without an early exit that leaks length. */
export function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i += 1) diff |= left[i]! ^ right[i]!
  return diff === 0
}

export async function timingSafeEqualString(secret: string, left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([hmacSha256(secret, left), hmacSha256(secret, right)])
  return timingSafeEqualBytes(new Uint8Array(a), new Uint8Array(b))
}

// ---------------------------------------------------------------------------
// Signed session cookie: MAC verification is stateless. The API additionally
// checks the live tenant registry before authorizing account operations.
// ---------------------------------------------------------------------------

export interface SessionPayload {
  account: string; expiresAt: number
  /** v2 sessions carry an authenticated tenant identity. Legacy values may be decoded only to reject/re-login at the API. */
  v?: 2; tenantId?: string; issuer?: string; subject?: string
}

export async function signSession(secret: string, payload: SessionPayload): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)))
  const signature = toBase64Url(await hmacSha256(secret, body))
  return `${body}.${signature}`
}

export async function verifySession(secret: string, cookie: string, now = Date.now()): Promise<SessionPayload | null> {
  const separator = cookie.indexOf('.')
  if (separator <= 0 || separator === cookie.length - 1) return null
  const body = cookie.slice(0, separator)
  const provided = cookie.slice(separator + 1)
  let expected: string
  try { expected = toBase64Url(await hmacSha256(secret, body)) } catch { return null }
  if (!timingSafeEqualBytes(encoder.encode(expected), encoder.encode(provided))) return null
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) } catch { return null }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (typeof record.account !== 'string' || typeof record.expiresAt !== 'number') return null
  if (record.expiresAt <= now) return null
  if (record.v === 2) {
    if (typeof record.tenantId !== 'string' || record.tenantId.length === 0
      || typeof record.issuer !== 'string' || typeof record.subject !== 'string') return null
    return { v: 2, tenantId: record.tenantId, account: record.account, issuer: record.issuer, subject: record.subject, expiresAt: record.expiresAt }
  }
  return { account: record.account, expiresAt: record.expiresAt }
}

/**
 * Cloudflare Realtime TURN credential HMAC is not needed: the TURN service
 * issues its own credentials through its API. This helper exists only for the
 * self-hosted coturn fallback, where the username is `<expiry>:<deviceId>` and
 * the credential is base64(HMAC-SHA1(secret, username)).
 */
export async function coturnCredential(secret: string, username: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(username))
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
}
