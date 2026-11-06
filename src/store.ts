/**
 * Persistent state for the single account: devices, tokens, and lockout counters.
 *
 * Lives in the Gateway Durable Object's SQLite database. Single-account means one
 * account row and a flat device table — no account foreign key, no tenancy.
 *
 * The SQL API is synchronous (`ctx.storage.sql.exec`), but token digests need
 * SHA-256, which Web Crypto only exposes asynchronously. So digests are computed
 * by the caller and passed in — the store never hashes anything itself. That keeps
 * digests identical to the reference implementation instead of inventing a weaker
 * local hash to dodge the async boundary.
 */
import type { DurableObjectStorage } from '@cloudflare/workers-types'

export interface DeviceRow extends Record<string, SqlStorageValue> {
  device_id: string
  role: 'host' | 'client'
  name: string
  platform: string
  identity_key: string
  client_version: string
  harness_version: string | null
  revoked: number
  last_seen_at: number
  created_at: number
}

export interface TokenRow extends Record<string, SqlStorageValue> {
  digest: string
  device_id: string
  kind: 'access' | 'refresh'
  expires_at: number
  used: number
}

/**
 * Fields a caller supplies when registering. A separate interface rather than
 * `Omit<DeviceRow, ...>`: DeviceRow carries an index signature to satisfy the SQL
 * binding type, and Omit would inherit it — turning every field into a union.
 */
export interface DeviceInput {
  device_id: string
  role: 'host' | 'client'
  name: string
  platform: string
  identity_key: string
  client_version: string
  harness_version: string | null
}

let schemaReady = false

export const LIMITS = {
  devices: 64,
  tokens: 1024,
  accessTokenMs: 60 * 60_000,
  refreshTokenMs: 30 * 86400_000,
} as const

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS devices (
    device_id       TEXT PRIMARY KEY,
    role            TEXT NOT NULL CHECK (role IN ('host','client')),
    name            TEXT NOT NULL,
    platform        TEXT NOT NULL,
    identity_key    TEXT NOT NULL,
    client_version  TEXT NOT NULL,
    harness_version TEXT,
    revoked         INTEGER NOT NULL DEFAULT 0,
    last_seen_at    INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tokens (
    digest     TEXT PRIMARY KEY,
    device_id  TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('access','refresh')),
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS tokens_device ON tokens(device_id)`,
  `CREATE INDEX IF NOT EXISTS tokens_expiry ON tokens(expires_at)`,
  `CREATE TABLE IF NOT EXISTS oauth_sessions (
    qr_id      TEXT PRIMARY KEY,
    provider   TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('pending','complete','expired')),
    account    TEXT,
    is_admin   INTEGER,
    token      TEXT,
    pkce       TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS oauth_sessions_expiry ON oauth_sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS lockout (
    key              TEXT PRIMARY KEY,
    failures         INTEGER NOT NULL,
    first_failure_at INTEGER NOT NULL,
    locked_until     INTEGER
  )`,
] as const

export class Store {
  private readonly sql: SqlStorage

  constructor(storage: DurableObjectStorage) {
    // `cloudflare:workers` types are not installed here; the DO runtime provides
    // `storage.sql` with this exact shape.
    this.sql = (storage as unknown as { sql: SqlStorage }).sql
    // Idempotent statements, but each one still takes a write lock. A Durable
    // Object is a per-instance singleton, so a module-level flag is enough to make
    // this once-per-cold-start instead of once-per-construction — which matters
    // because construction happens on every RPC entry.
    if (!schemaReady) {
      for (const statement of SCHEMA) this.sql.exec(statement)
      schemaReady = true
    }
  }

  // --- devices -------------------------------------------------------------

  getDevice(deviceId: string): DeviceRow | null {
    return (this.sql.exec<DeviceRow>('SELECT * FROM devices WHERE device_id = ?', deviceId).toArray()[0] as DeviceRow | undefined) ?? null
  }

  /** Active (not revoked) devices. */
  listDevices(): DeviceRow[] {
    return this.sql.exec<DeviceRow>('SELECT * FROM devices WHERE revoked = 0 ORDER BY created_at').toArray()
  }

  countDevices(): number {
    return this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM devices').toArray()[0]?.n ?? 0
  }

  /**
   * Register or update a device.
   *
   * Refuses to overwrite an existing device's identity key or role: a device id
   * that suddenly maps to a different public key is either a reinstall (which
   * must re-pair) or impersonation, and accepting it would defeat the local
   * pinning the clients perform.
   */
  upsertDevice(input: DeviceInput): { created: boolean } {
    const existing = this.getDevice(input.device_id)
    if (existing) {
      if (existing.revoked) throw new StoreError('DEVICE_REVOKED', 403)
      if (existing.identity_key !== input.identity_key || existing.role !== input.role) {
        throw new StoreError('PEER_IDENTITY_MISMATCH', 409)
      }
      this.sql.exec(
        'UPDATE devices SET name = ?, platform = ?, client_version = ?, harness_version = ? WHERE device_id = ?',
        input.name, input.platform, input.client_version, input.harness_version, input.device_id,
      )
      return { created: false }
    }
    if (this.countDevices() >= LIMITS.devices) throw new StoreError('RATE_LIMITED', 429)
    this.sql.exec(
      `INSERT INTO devices (device_id, role, name, platform, identity_key, client_version,
        harness_version, revoked, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      input.device_id, input.role, input.name, input.platform, input.identity_key,
      input.client_version, input.harness_version, Date.now(),
    )
    return { created: true }
  }

  touchDevice(deviceId: string, clientVersion?: string, harnessVersion?: string): void {
    this.sql.exec(
      `UPDATE devices SET last_seen_at = ?,
         client_version = COALESCE(?, client_version),
         harness_version = CASE WHEN role = 'host' THEN COALESCE(?, harness_version) ELSE harness_version END
       WHERE device_id = ?`,
      Date.now(), clientVersion ?? null, harnessVersion ?? null, deviceId,
    )
  }

  revokeDevice(deviceId: string): void {
    this.sql.exec('UPDATE devices SET revoked = 1 WHERE device_id = ?', deviceId)
    this.deleteTokensFor(deviceId)
  }

  renameDevice(deviceId: string, name: string): void {
    this.sql.exec('UPDATE devices SET name = ? WHERE device_id = ?', name, deviceId)
  }

  // --- tokens --------------------------------------------------------------

  countTokens(): number {
    return this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM tokens').toArray()[0]?.n ?? 0
  }

  /** Insert one token row. The caller supplies the already-computed digest. */
  insertToken(digest: string, deviceId: string, kind: 'access' | 'refresh', expiresAt: number): void {
    this.sql.exec(
      'INSERT INTO tokens (digest, device_id, kind, expires_at, used) VALUES (?, ?, ?, ?, 0)',
      digest, deviceId, kind, expiresAt,
    )
  }

  findToken(digest: string): TokenRow | null {
    return (this.sql.exec<TokenRow>('SELECT * FROM tokens WHERE digest = ?', digest).toArray()[0] as TokenRow | undefined) ?? null
  }

  markTokenUsed(digest: string): void {
    this.sql.exec('UPDATE tokens SET used = 1 WHERE digest = ?', digest)
  }

  deleteTokensFor(deviceId: string): void {
    this.sql.exec('DELETE FROM tokens WHERE device_id = ?', deviceId)
  }

  purgeExpiredTokens(now = Date.now()): void {
    this.sql.exec('DELETE FROM tokens WHERE expires_at <= ?', now)
  }

  // --- lockout -------------------------------------------------------------

  getLockout(key: string): { failures: number; firstFailureAt: number; lockedUntil: number | null } | null {
    const row = this.sql.exec<{ failures: number; first_failure_at: number; locked_until: number | null }>(
      'SELECT failures, first_failure_at, locked_until FROM lockout WHERE key = ?', key,
    ).toArray()[0]
    if (!row) return null
    return { failures: row.failures, firstFailureAt: row.first_failure_at, lockedUntil: row.locked_until }
  }

  /**
   * Record a failed attempt and report whether it triggered a lock.
   *
   * A strike older than `streakMs` starts a fresh count, so a few isolated typos
   * spread over days never accumulate into a lock.
   */
  recordFailure(
    key: string, now: number, threshold: number, lockMs: number, streakMs: number,
  ): { locked: boolean; retryAfterMs: number } {
    const existing = this.getLockout(key)
    const stale = existing !== null && existing.lockedUntil === null && now - existing.firstFailureAt > streakMs
    const failures = (existing === null || stale ? 0 : existing.failures) + 1
    const firstFailureAt = existing === null || stale ? now : existing.firstFailureAt
    const lockedUntil = failures >= threshold ? now + lockMs : null
    this.sql.exec(
      `INSERT INTO lockout (key, failures, first_failure_at, locked_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET failures = excluded.failures,
         first_failure_at = excluded.first_failure_at, locked_until = excluded.locked_until`,
      key, failures, firstFailureAt, lockedUntil,
    )
    return { locked: lockedUntil !== null, retryAfterMs: lockedUntil === null ? 0 : lockedUntil - now }
  }

  clearFailures(key: string): void {
    this.sql.exec('DELETE FROM lockout WHERE key = ?', key)
  }

  // --- oauth sessions ------------------------------------------------------

  createOAuthSession(input: {
    qrId: string; provider: string; expiresAt: number
  }): void {
    this.purgeExpiredOAuthSessions()
    this.sql.exec(
      'INSERT INTO oauth_sessions (qr_id, provider, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      input.qrId, input.provider, 'pending', input.expiresAt, Date.now(),
    )
  }

  getOAuthSession(qrId: string): {
    qrId: string; provider: string; status: string
    account: string | null; isAdmin: number | null; token: string | null; expiresAt: number
  } | null {
    const row = this.sql.exec<{
      qr_id: string; provider: string; status: string
      account: string | null; is_admin: number | null; token: string | null; expires_at: number
    }>('SELECT * FROM oauth_sessions WHERE qr_id = ?', qrId).toArray()[0]
    if (row === undefined) return null
    return {
      qrId: row.qr_id, provider: row.provider, status: row.status,
      account: row.account, isAdmin: row.is_admin, token: row.token, expiresAt: row.expires_at,
    }
  }

  /**
   * Mark a session complete and hand it the session token.
   *
   * Only a `pending` row may transition: a second callback for the same qr id would
   * otherwise overwrite the token, and a callback replay is exactly what an attacker
   * with a stolen `code` would attempt.
   */
  completeOAuthSession(qrId: string, account: string, isAdmin: boolean, token: string): boolean {
    const existing = this.getOAuthSession(qrId)
    if (existing === null || existing.status !== 'pending') return false
    if (existing.expiresAt <= Date.now()) return false
    this.sql.exec(
      'UPDATE oauth_sessions SET status = ?, account = ?, is_admin = ?, token = ? WHERE qr_id = ? AND status = ?',
      'complete', account, isAdmin ? 1 : 0, token, qrId, 'pending',
    )
    return true
  }

  /** Read the token once; the row keeps its complete status but loses the token. */
  takeOAuthToken(qrId: string): { account: string; isAdmin: boolean; token: string } | null {
    const row = this.getOAuthSession(qrId)
    if (row === null || row.status !== 'complete' || row.token === null || row.account === null) return null
    this.sql.exec('UPDATE oauth_sessions SET token = NULL WHERE qr_id = ?', qrId)
    return { account: row.account, isAdmin: row.isAdmin === 1, token: row.token }
  }

  purgeExpiredOAuthSessions(now = Date.now()): void {
    this.sql.exec('DELETE FROM oauth_sessions WHERE expires_at <= ?', now)
  }

  setOAuthPkce(qrId: string, verifier: string): void {
    this.sql.exec('UPDATE oauth_sessions SET pkce = ? WHERE qr_id = ?', verifier, qrId)
  }

  getOAuthPkce(qrId: string): string | null {
    const row = this.sql.exec<{ pkce: string | null }>(
      'SELECT pkce FROM oauth_sessions WHERE qr_id = ?', qrId,
    ).toArray()[0]
    return row?.pkce ?? null
  }

  purgeExpiredLockouts(now: number, streakMs: number): void {
    this.sql.exec(
      `DELETE FROM lockout
        WHERE (locked_until IS NOT NULL AND locked_until <= ?)
           OR (locked_until IS NULL AND first_failure_at < ?)`,
      now, now - streakMs,
    )
  }
}

export class StoreError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

/** 32 bytes of CSPRNG output, base64url. Used for access/refresh tokens. */
export function randomTokenValue(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
