/**
 * Tenant-scoped persistent state in the singleton Gateway Durable Object.
 *
 * SQL is synchronous. The caller hashes credentials and derives stable tenant IDs;
 * this layer scopes every device lookup/write explicitly and binds OIDC identities
 * transactionally. No email address can claim an existing tenant or legacy data.
 */
import type { DurableObjectStorage } from '@cloudflare/workers-types'

export const LEGACY_TENANT_ID = 'legacy-owner'

export interface TenantPrincipal {
  tenantId: string
  account: string
  membershipId: string
  issuer: string
  subject: string
}

export interface TenantIdentity {
  tenantId: string
  account: string
  issuer: string
  subject: string
}

export interface DeviceRow extends Record<string, SqlStorageValue> {
  tenant_id: string
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
  tenant_id: string
  device_id: string
  kind: 'access' | 'refresh'
  expires_at: number
  used: number
}

/** Explicit registration fields; do not inherit DeviceRow's SQL index signature. */
export interface DeviceInput {
  device_id: string
  role: 'host' | 'client'
  name: string
  platform: string
  identity_key: string
  client_version: string
  harness_version: string | null
}

interface TenantRow extends Record<string, SqlStorageValue> {
  tenant_id: string
  account: string
  membership_id: string
  issuer: string
  subject: string
  active: number
  created_at: number
}

interface ResolveTenantOptions {
  /** Zero disables account-count limits; positive integers opt into a record cap. */
  maxTenants: number
  legacyOwnerSubject?: string
  legacyOwnerIssuer?: string
  legacyAccount: string
  legacyMembershipId: string
}

const schemaReady = new WeakSet<SqlStorage>()
const TENANT_SCHEMA_VERSION = 2

export const LIMITS = {
  devices: 64,
  tokens: 1024,
  /** Thirty-day replay markers are separately bounded; never evict a live marker to permit unsafe reuse. */
  refreshTombstones: 50_000,
  accessTokenMs: 60 * 60_000,
  refreshTokenMs: 30 * 86400_000,
} as const

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tenants (
    tenant_id     TEXT PRIMARY KEY,
    account       TEXT NOT NULL,
    membership_id TEXT NOT NULL,
    issuer        TEXT NOT NULL DEFAULT '',
    subject       TEXT NOT NULL DEFAULT '',
    active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    created_at    INTEGER NOT NULL,
    CHECK ((issuer = '' AND subject = '') OR (issuer <> '' AND subject <> ''))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS tenants_oidc_identity
     ON tenants(issuer, subject) WHERE issuer <> '' AND subject <> ''`,
  `CREATE UNIQUE INDEX IF NOT EXISTS tenants_membership
     ON tenants(membership_id) WHERE membership_id <> ''`,
  `CREATE TABLE IF NOT EXISTS devices (
    tenant_id       TEXT NOT NULL,
    device_id       TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('host','client')),
    name            TEXT NOT NULL,
    platform        TEXT NOT NULL,
    identity_key    TEXT NOT NULL,
    client_version  TEXT NOT NULL,
    harness_version TEXT,
    revoked         INTEGER NOT NULL DEFAULT 0,
    last_seen_at    INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, device_id)
  )`,
  `CREATE TABLE IF NOT EXISTS tokens (
    digest     TEXT PRIMARY KEY,
    tenant_id  TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('access','refresh')),
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS tokens_tenant_device ON tokens(tenant_id, device_id)`,
  `CREATE INDEX IF NOT EXISTS tokens_expiry_v2 ON tokens(expires_at)`,
  `CREATE TABLE IF NOT EXISTS oauth_sessions (
    qr_id      TEXT PRIMARY KEY,
    provider   TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('pending','exchanging','complete','expired')),
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

function principal(row: TenantRow): TenantPrincipal {
  return { tenantId: row.tenant_id, account: row.account, membershipId: row.membership_id,
    issuer: row.issuer, subject: row.subject }
}

function nonempty(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value)
}

export class Store {
  private readonly sql: SqlStorage

  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = (storage as unknown as { sql: SqlStorage }).sql
    if (!schemaReady.has(this.sql)) {
      storage.transactionSync(() => this.initializeSchema())
      schemaReady.add(this.sql)
    }
  }

  private tableSchema(name: string): string | undefined {
    return this.sql.exec<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", name,
    ).toArray()[0]?.sql
  }

  private hasColumn(table: 'devices' | 'tokens', column: string): boolean {
    // The table identifier is an internal union, never request input.
    return this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().some(row => row.name === column)
  }

  /** One atomic migration; old device/token rows remain in private backup tables. */
  private initializeSchema(): void {
    this.sql.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')
    const version = this.sql.exec<{ version: number }>('SELECT MAX(version) AS version FROM schema_migrations').toArray()[0]?.version ?? 0
    if (version > TENANT_SCHEMA_VERSION) throw new StoreError('STORE_SCHEMA_UNSUPPORTED', 503)
    const legacyDevices = this.tableSchema('devices') !== undefined && !this.hasColumn('devices', 'tenant_id')
    const legacyTokens = this.tableSchema('tokens') !== undefined && !this.hasColumn('tokens', 'tenant_id')
    if (version === TENANT_SCHEMA_VERSION && (legacyDevices || legacyTokens)) throw new StoreError('STORE_SCHEMA_INVALID', 503)
    if (legacyDevices) {
      if (this.tableSchema('archived_v1_devices') !== undefined) throw new StoreError('STORE_SCHEMA_INVALID', 503)
      this.sql.exec('ALTER TABLE devices RENAME TO archived_v1_devices')
    }
    if (legacyTokens) {
      if (this.tableSchema('archived_v1_tokens') !== undefined) throw new StoreError('STORE_SCHEMA_INVALID', 503)
      this.sql.exec('ALTER TABLE tokens RENAME TO archived_v1_tokens')
    }
    const oauthSchema = this.tableSchema('oauth_sessions')
    if (oauthSchema !== undefined && !oauthSchema.includes("'exchanging'")) {
      // Very old ephemeral flows lack fields/checks required for one-shot claiming.
      this.sql.exec('DROP TABLE oauth_sessions')
    }
    for (const statement of SCHEMA) this.sql.exec(statement)
    this.sql.exec(
      "INSERT OR IGNORE INTO tenants (tenant_id, account, membership_id, issuer, subject, active, created_at) VALUES (?, '', '', '', '', 1, ?)",
      LEGACY_TENANT_ID, Date.now(),
    )
    if (legacyDevices) this.sql.exec(
      `INSERT INTO devices (tenant_id, device_id, role, name, platform, identity_key, client_version,
         harness_version, revoked, last_seen_at, created_at)
       SELECT ?, device_id, role, name, platform, identity_key, client_version,
         harness_version, revoked, last_seen_at, created_at FROM archived_v1_devices`, LEGACY_TENANT_ID,
    )
    if (legacyTokens) this.sql.exec(
      `INSERT INTO tokens (digest, tenant_id, device_id, kind, expires_at, used)
       SELECT digest, ?, device_id, kind, expires_at, used FROM archived_v1_tokens`, LEGACY_TENANT_ID,
    )
    if (version < TENANT_SCHEMA_VERSION) {
      // Signed legacy sessions contain no tenant identity. Never deliver one from
      // a completed old ticket, or allow a pending old callback to finish later.
      if (oauthSchema !== undefined) this.sql.exec("UPDATE oauth_sessions SET status = 'expired', token = NULL, pkce = NULL")
      this.sql.exec('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', TENANT_SCHEMA_VERSION, Date.now())
    }
  }

  // --- tenant registry -----------------------------------------------------

  private tenantRow(tenantId: string): TenantRow | null {
    return this.sql.exec<TenantRow>('SELECT * FROM tenants WHERE tenant_id = ?', tenantId).toArray()[0] ?? null
  }

  /** Disabled tenants are not valid principals, including for device auth. */
  getTenant(tenantId: string): TenantPrincipal | null {
    const row = this.tenantRow(tenantId)
    return row === null || row.active !== 1 ? null : principal(row)
  }

  /** Initialize only missing legacy display/membership data; never rebind identity. */
  ensureLegacyTenant(account: string, membershipId: string): TenantPrincipal {
    // Initialization is not authentication: a disabled legacy account must not
    // prevent the singleton from starting for unrelated active tenants. Callers
    // authenticate via getTenant(), which returns null for inactive rows.
    return this.storage.transactionSync(() => this.ensureLegacyTenantSync(account, membershipId))
  }

  private ensureLegacyTenantSync(account: string, membershipId: string): TenantPrincipal {
    if (!nonempty(account) || !nonempty(membershipId)) throw new StoreError('TENANT_CONFIG_INVALID', 503)
    const row = this.tenantRow(LEGACY_TENANT_ID)
    if (row === null) throw new StoreError('STORE_SCHEMA_INVALID', 503)
    if (row.membership_id !== '' && row.membership_id !== membershipId) throw new StoreError('TENANT_IDENTITY_MISMATCH', 409)
    this.sql.exec(
      "UPDATE tenants SET account = CASE WHEN account = '' THEN ? ELSE account END, membership_id = CASE WHEN membership_id = '' THEN ? ELSE membership_id END WHERE tenant_id = ?",
      account, membershipId, LEGACY_TENANT_ID,
    )
    return principal(this.tenantRow(LEGACY_TENANT_ID)!)
  }

  /**
   * Stable issuer+subject binding. Email is display metadata only. The reserved
   * legacy ID can be bound solely by the exact operator-pinned issuer AND subject.
   * This synchronous transaction also serializes first-login capacity checks.
   */
  resolveTenant(identity: TenantIdentity, options: ResolveTenantOptions): TenantPrincipal {
    if (!nonempty(identity.tenantId) || identity.tenantId.length > 256 || !nonempty(identity.account)
      || !nonempty(identity.issuer) || !nonempty(identity.subject)
      || !Number.isSafeInteger(options.maxTenants) || options.maxTenants < 0) throw new StoreError('TENANT_CONFIG_INVALID', 503)
    return this.storage.transactionSync(() => {
      this.ensureLegacyTenantSync(options.legacyAccount, options.legacyMembershipId)
      const known = this.sql.exec<TenantRow>('SELECT * FROM tenants WHERE issuer = ? AND subject = ?', identity.issuer, identity.subject).toArray()[0]
      const ownerPinMatches = nonempty(options.legacyOwnerIssuer ?? '') && nonempty(options.legacyOwnerSubject ?? '')
        && identity.issuer === options.legacyOwnerIssuer && identity.subject === options.legacyOwnerSubject
      if (known !== undefined) {
        if (known.active !== 1) throw new StoreError('TENANT_DISABLED', 403)
        // Do not transfer a pre-existing nonlegacy tenant into the legacy data pool.
        if (ownerPinMatches && known.tenant_id !== LEGACY_TENANT_ID) throw new StoreError('TENANT_IDENTITY_MISMATCH', 409)
        this.sql.exec('UPDATE tenants SET account = ? WHERE tenant_id = ?', identity.account, known.tenant_id)
        return principal(this.tenantRow(known.tenant_id)!)
      }
      if (!ownerPinMatches && identity.tenantId === LEGACY_TENANT_ID) throw new StoreError('TENANT_IDENTITY_MISMATCH', 409)
      const legacy = this.tenantRow(LEGACY_TENANT_ID)!
      if (ownerPinMatches && legacy.active !== 1) throw new StoreError('TENANT_DISABLED', 403)
      if (ownerPinMatches && (legacy.issuer !== '' || legacy.subject !== '')) throw new StoreError('TENANT_IDENTITY_MISMATCH', 409)
      if (!ownerPinMatches && this.tenantRow(identity.tenantId) !== null) throw new StoreError('TENANT_IDENTITY_MISMATCH', 409)
      if (options.maxTenants > 0) {
        // An explicit optional cap includes disabled principals and reserves the
        // original owner's slot. Unlimited mode skips the count query entirely.
        const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tenants WHERE issuer <> '' AND subject <> ''").toArray()[0]?.n ?? 0
        const reservedOwnerSlots = !ownerPinMatches && legacy.issuer === '' && legacy.subject === '' ? 1 : 0
        if (count >= options.maxTenants - reservedOwnerSlots) throw new StoreError('TENANT_LIMIT_REACHED', 403)
      }
      if (ownerPinMatches) {
        this.sql.exec('UPDATE tenants SET issuer = ?, subject = ?, account = ? WHERE tenant_id = ?', identity.issuer, identity.subject, identity.account, LEGACY_TENANT_ID)
        return principal(this.tenantRow(LEGACY_TENANT_ID)!)
      }
      const membershipId = `account:${identity.tenantId.slice(0, 16)}`
      if (this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM tenants WHERE membership_id = ?', membershipId).toArray()[0]?.n) {
        throw new StoreError('TENANT_IDENTITY_MISMATCH', 409)
      }
      this.sql.exec('INSERT INTO tenants (tenant_id, account, membership_id, issuer, subject, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
        identity.tenantId, identity.account, membershipId, identity.issuer, identity.subject, Date.now())
      return principal(this.tenantRow(identity.tenantId)!)
    })
  }

  // --- devices -------------------------------------------------------------

  getDevice(tenantId: string, deviceId: string): DeviceRow | null {
    return this.sql.exec<DeviceRow>('SELECT * FROM devices WHERE tenant_id = ? AND device_id = ?', tenantId, deviceId).toArray()[0] ?? null
  }

  /** Active (not revoked) devices belonging only to this tenant. */
  listDevices(tenantId: string): DeviceRow[] {
    return this.sql.exec<DeviceRow>('SELECT * FROM devices WHERE tenant_id = ? AND revoked = 0 ORDER BY created_at', tenantId).toArray()
  }

  countDevices(tenantId: string): number {
    return this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM devices WHERE tenant_id = ?', tenantId).toArray()[0]?.n ?? 0
  }

  upsertDevice(tenantId: string, input: DeviceInput): { created: boolean } {
    if (this.getTenant(tenantId) === null) throw new StoreError('AUTH_INVALID', 401)
    const existing = this.getDevice(tenantId, input.device_id)
    if (existing) {
      if (existing.revoked) throw new StoreError('DEVICE_REVOKED', 403)
      if (existing.identity_key !== input.identity_key || existing.role !== input.role) throw new StoreError('PEER_IDENTITY_MISMATCH', 409)
      this.sql.exec(
        'UPDATE devices SET name = ?, platform = ?, client_version = ?, harness_version = ? WHERE tenant_id = ? AND device_id = ?',
        input.name, input.platform, input.client_version, input.harness_version, tenantId, input.device_id,
      )
      return { created: false }
    }
    if (this.countDevices(tenantId) >= LIMITS.devices) throw new StoreError('RATE_LIMITED', 429)
    this.sql.exec(
      `INSERT INTO devices (tenant_id, device_id, role, name, platform, identity_key, client_version,
        harness_version, revoked, last_seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
      tenantId, input.device_id, input.role, input.name, input.platform, input.identity_key,
      input.client_version, input.harness_version, Date.now(),
    )
    return { created: true }
  }

  touchDevice(tenantId: string, deviceId: string, clientVersion?: string, harnessVersion?: string): void {
    this.sql.exec(
      `UPDATE devices SET last_seen_at = ?, client_version = COALESCE(?, client_version),
         harness_version = CASE WHEN role = 'host' THEN COALESCE(?, harness_version) ELSE harness_version END
       WHERE tenant_id = ? AND device_id = ?`,
      Date.now(), clientVersion ?? null, harnessVersion ?? null, tenantId, deviceId,
    )
  }

  revokeDevice(tenantId: string, deviceId: string): void {
    this.storage.transactionSync(() => {
      this.sql.exec('UPDATE devices SET revoked = 1 WHERE tenant_id = ? AND device_id = ?', tenantId, deviceId)
      this.deleteTokensFor(tenantId, deviceId)
    })
  }

  renameDevice(tenantId: string, deviceId: string, name: string): void {
    this.sql.exec('UPDATE devices SET name = ? WHERE tenant_id = ? AND device_id = ?', name, tenantId, deviceId)
  }

  // --- tokens --------------------------------------------------------------

  countTokens(tenantId: string): number {
    return this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM tokens WHERE tenant_id = ? AND used = 0', tenantId).toArray()[0]?.n ?? 0
  }

  /** Global digest lookup discovers tenant; it never authenticates without device/tenant checks. */
  findToken(digest: string): TokenRow | null {
    return this.sql.exec<TokenRow>('SELECT * FROM tokens WHERE digest = ?', digest).toArray()[0] ?? null
  }

  insertToken(digest: string, tenantId: string, deviceId: string, kind: 'access' | 'refresh', expiresAt: number): void {
    const device = this.getDevice(tenantId, deviceId)
    if (this.getTenant(tenantId) === null || device === null || device.revoked !== 0) throw new StoreError('AUTH_INVALID', 401)
    if (this.countTokens(tenantId) >= LIMITS.tokens) throw new StoreError('RATE_LIMITED', 429)
    this.sql.exec('INSERT INTO tokens (digest, tenant_id, device_id, kind, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)',
      digest, tenantId, deviceId, kind, expiresAt)
  }

  markTokenUsed(digest: string): void {
    const row = this.findToken(digest)
    if (row === null || row.used !== 0) throw new StoreError('AUTH_INVALID', 401)
    const retained = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM tokens WHERE tenant_id = ? AND used <> 0', row.tenant_id).toArray()[0]?.n ?? 0
    if (retained >= LIMITS.refreshTombstones) throw new StoreError('RATE_LIMITED', 429)
    this.sql.exec('UPDATE tokens SET used = 1 WHERE digest = ?', digest)
  }

  deleteTokensFor(tenantId: string, deviceId: string, preserveUsedRefresh = false): void {
    this.sql.exec(`DELETE FROM tokens WHERE tenant_id = ? AND device_id = ?${preserveUsedRefresh ? " AND NOT (kind = 'refresh' AND used <> 0)" : ''}`, tenantId, deviceId)
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

  recordFailure(key: string, now: number, threshold: number, lockMs: number, streakMs: number): { locked: boolean; retryAfterMs: number } {
    const existing = this.getLockout(key)
    const stale = existing !== null && existing.lockedUntil === null && now - existing.firstFailureAt > streakMs
    const failures = (existing === null || stale ? 0 : existing.failures) + 1
    const firstFailureAt = existing === null || stale ? now : existing.firstFailureAt
    const lockedUntil = failures >= threshold ? now + lockMs : null
    this.sql.exec(
      `INSERT INTO lockout (key, failures, first_failure_at, locked_until) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, first_failure_at = excluded.first_failure_at, locked_until = excluded.locked_until`,
      key, failures, firstFailureAt, lockedUntil,
    )
    return { locked: lockedUntil !== null, retryAfterMs: lockedUntil === null ? 0 : lockedUntil - now }
  }

  clearFailures(key: string): void { this.sql.exec('DELETE FROM lockout WHERE key = ?', key) }

  // --- oauth sessions ------------------------------------------------------

  createOAuthSession(input: { qrId: string; provider: string; expiresAt: number }): void {
    this.purgeExpiredOAuthSessions()
    this.sql.exec('INSERT INTO oauth_sessions (qr_id, provider, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
      input.qrId, input.provider, 'pending', input.expiresAt, Date.now())
  }

  getOAuthSession(qrId: string): { qrId: string; provider: string; status: string; account: string | null; isAdmin: number | null; token: string | null; expiresAt: number } | null {
    const row = this.sql.exec<{ qr_id: string; provider: string; status: string; account: string | null; is_admin: number | null; token: string | null; expires_at: number }>(
      'SELECT * FROM oauth_sessions WHERE qr_id = ?', qrId).toArray()[0]
    return row === undefined ? null : { qrId: row.qr_id, provider: row.provider, status: row.status, account: row.account, isAdmin: row.is_admin, token: row.token, expiresAt: row.expires_at }
  }

  completeOAuthSession(qrId: string, account: string, isAdmin: boolean, token: string): boolean {
    return this.sql.exec(
      `UPDATE oauth_sessions SET status = 'complete', account = ?, is_admin = ?, token = ?
       WHERE qr_id = ? AND provider = 'logto' AND status = 'exchanging' AND expires_at > ? RETURNING qr_id`,
      account, isAdmin ? 1 : 0, token, qrId, Date.now(),
    ).toArray().length === 1
  }

  takeOAuthToken(qrId: string): { account: string; isAdmin: boolean; token: string } | null {
    return this.storage.transactionSync(() => {
      const row = this.getOAuthSession(qrId)
      if (row === null || row.provider !== 'logto' || row.status !== 'complete' || row.expiresAt <= Date.now() || row.token === null || row.account === null) return null
      this.sql.exec('UPDATE oauth_sessions SET token = NULL WHERE qr_id = ?', qrId)
      return { account: row.account, isAdmin: row.isAdmin === 1, token: row.token }
    })
  }

  purgeExpiredOAuthSessions(now = Date.now()): void { this.sql.exec('DELETE FROM oauth_sessions WHERE expires_at <= ?', now) }

  setOAuthPkce(qrId: string, verifier: string): boolean {
    if (verifier === '') return false
    return this.sql.exec(
      `UPDATE oauth_sessions SET pkce = ? WHERE qr_id = ? AND provider = 'logto' AND status = 'pending' AND expires_at > ? AND pkce IS NULL RETURNING qr_id`,
      verifier, qrId, Date.now(),
    ).toArray().length === 1
  }

  takeOAuthPkce(qrId: string): string | null {
    return this.storage.transactionSync(() => {
      const row = this.sql.exec<{ pkce: string }>(
        `UPDATE oauth_sessions SET status = 'exchanging' WHERE qr_id = ? AND provider = 'logto' AND status = 'pending' AND expires_at > ? AND pkce IS NOT NULL RETURNING pkce`,
        qrId, Date.now(),
      ).toArray()[0]
      if (row === undefined) return null
      this.sql.exec('UPDATE oauth_sessions SET pkce = NULL WHERE qr_id = ?', qrId)
      return row.pkce
    })
  }

  purgeExpiredLockouts(now: number, streakMs: number): void {
    this.sql.exec(`DELETE FROM lockout WHERE (locked_until IS NOT NULL AND locked_until <= ?) OR (locked_until IS NULL AND first_failure_at < ?)`, now, now - streakMs)
  }
}

export class StoreError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

/** 32 bytes of CSPRNG output, base64url. */
export function randomTokenValue(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
