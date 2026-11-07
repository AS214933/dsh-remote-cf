import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { LEGACY_TENANT_ID, LIMITS, Store } from '../src/store.ts'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
const databases = []
const options = { maxTenants: 10, legacyOwnerIssuer: 'https://auth.example.com/oidc', legacyOwnerSubject: 'pinned-owner',
  legacyAccount: 'legacy@example.com', legacyMembershipId: 'legacy-membership' }
const identity = (suffix, extra = {}) => ({ tenantId: `${suffix}0123456789abcdef0123456789abcdef`, account: `${suffix}@example.com`,
  issuer: 'https://auth.example.com/oidc', subject: `sub-${suffix}`, ...extra })
const device = (id = 'same-device', extra = {}) => ({ device_id: id, role: 'host', name: 'synthetic host', platform: 'test',
  identity_key: 'synthetic-key', client_version: '1.0.0', harness_version: '1.0.0', ...extra })
function storage(db = new DatabaseSync(':memory:'), reject = () => false) {
  if (!databases.includes(db)) databases.push(db)
  return { db, sql: { exec(query, ...bindings) {
    if (reject(query)) throw new Error('synthetic SQL failure')
    const rows = db.prepare(query).all(...bindings)
    return { toArray: () => rows }
  } }, transactionSync(fn) {
    db.exec('BEGIN')
    try { const result = fn(); db.exec('COMMIT'); return result }
    catch (error) { db.exec('ROLLBACK'); throw error }
  } }
}
function fixture() { const database = storage(); return { store: new Store(database), database } }
function legacyDatabase() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE devices (device_id TEXT PRIMARY KEY, role TEXT NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL,
    identity_key TEXT NOT NULL, client_version TEXT NOT NULL, harness_version TEXT, revoked INTEGER NOT NULL DEFAULT 0,
    last_seen_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE tokens (digest TEXT PRIMARY KEY, device_id TEXT NOT NULL, kind TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX tokens_device ON tokens(device_id); CREATE INDEX tokens_expiry ON tokens(expires_at);
    CREATE TABLE lockout (key TEXT PRIMARY KEY, failures INTEGER NOT NULL, first_failure_at INTEGER NOT NULL, locked_until INTEGER);
    CREATE TABLE oauth_sessions (qr_id TEXT PRIMARY KEY, provider TEXT NOT NULL,
      status TEXT CHECK(status IN ('pending','exchanging','complete','expired')), account TEXT, is_admin INTEGER, token TEXT,
      pkce TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO devices VALUES ('same-device','host','retained name','test','retained-key','0.6.3','1.2.3',0,123,456);
    INSERT INTO devices VALUES ('revoked-device','client','revoked name','test','revoked-key','0.6.3',NULL,1,321,654);
    INSERT INTO tokens VALUES ('retained-access','same-device','access',9876543210000,0);
    INSERT INTO tokens VALUES ('retained-used-refresh','same-device','refresh',9876543220000,1);
    INSERT INTO lockout VALUES ('retained-lockout',3,12,34);
    INSERT INTO oauth_sessions VALUES ('old-ticket','logto','complete','legacy@example.com',0,'old-bearer','old-verifier',9876543210000,123);
    CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('preserved');`)
  return db
}
afterEach(() => { for (const db of databases.splice(0)) db.close() })

describe('tenant store migration and identity binding', () => {
  it('migrates legacy devices/tokens once, preserves all credential fields and private backup tables', () => {
    const db = legacyDatabase(), database = storage(db), store = new Store(database)
    expect(store.getDevice(LEGACY_TENANT_ID, 'same-device')).toMatchObject({ tenant_id: LEGACY_TENANT_ID, identity_key: 'retained-key',
      harness_version: '1.2.3', revoked: 0, last_seen_at: 123, created_at: 456 })
    expect(store.getDevice(LEGACY_TENANT_ID, 'revoked-device').revoked).toBe(1)
    expect(store.findToken('retained-used-refresh')).toEqual({ digest: 'retained-used-refresh', tenant_id: LEGACY_TENANT_ID,
      device_id: 'same-device', kind: 'refresh', expires_at: 9876543220000, used: 1 })
    expect(db.prepare('SELECT COUNT(*) n FROM archived_v1_devices').get().n).toBe(2)
    expect(db.prepare('SELECT COUNT(*) n FROM archived_v1_tokens').get().n).toBe(2)
    expect(db.prepare('SELECT value FROM unrelated').get().value).toBe('preserved')
    expect(store.getLockout('retained-lockout')).toEqual({ failures: 3, firstFailureAt: 12, lockedUntil: 34 })
    expect(store.getOAuthSession('old-ticket')).toMatchObject({ status: 'expired', token: null })
    expect(store.takeOAuthPkce('old-ticket')).toBeNull()
    expect(db.prepare('SELECT pkce FROM oauth_sessions').get().pkce).toBeNull()
    store.createOAuthSession({ qrId: 'new-ticket', provider: 'logto', expiresAt: Date.now() + 60_000 })
    store.setOAuthPkce('new-ticket', 'new-verifier')
    // A new wrapper represents an independently reconstructed DO SQL API.
    const afterWake = new Store(storage(db))
    expect(afterWake.countDevices(LEGACY_TENANT_ID)).toBe(2)
    expect(afterWake.countTokens(LEGACY_TENANT_ID)).toBe(1)
    expect(afterWake.findToken('retained-used-refresh')?.used).toBe(1)
    expect(afterWake.getOAuthSession('new-ticket').status).toBe('pending')
    expect(afterWake.takeOAuthPkce('new-ticket')).toBe('new-verifier')
    expect(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=2').get().n).toBe(1)
  })

  it('rolls back a failed migration including table renames, data and schema marker', () => {
    const db = legacyDatabase()
    const fail = storage(db, query => query.includes('SELECT digest, ?, device_id'))
    expect(() => new Store(fail)).toThrow('synthetic SQL failure')
    expect(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='archived_v1_devices'").get().n).toBe(0)
    expect(db.prepare('SELECT identity_key FROM devices WHERE device_id=?').get('same-device').identity_key).toBe('retained-key')
    expect(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='schema_migrations'").get().n).toBe(0)
    const recovered = new Store(storage(db))
    expect(recovered.findToken('retained-access').tenant_id).toBe(LEGACY_TENANT_ID)
  })

  it('never claims legacy data by matching email or a caller-supplied legacy tenant ID', () => {
    const { store } = fixture()
    const initialized = store.ensureLegacyTenant(options.legacyAccount, options.legacyMembershipId)
    expect(initialized).toMatchObject({ tenantId: LEGACY_TENANT_ID, issuer: '', subject: '' })
    store.upsertDevice(LEGACY_TENANT_ID, device('private-legacy-device'))
    const stranger = store.resolveTenant(identity('stranger', { account: options.legacyAccount }), options)
    expect(stranger.tenantId).not.toBe(LEGACY_TENANT_ID)
    expect(store.listDevices(stranger.tenantId)).toEqual([])
    expect(() => store.resolveTenant(identity('forged', { tenantId: LEGACY_TENANT_ID }), options)).toThrow('TENANT_IDENTITY_MISMATCH')
    const wrongIssuer = store.resolveTenant(identity('wrongissuer', { subject: options.legacyOwnerSubject, issuer: 'https://other.example.com/oidc' }), options)
    expect(wrongIssuer.tenantId).not.toBe(LEGACY_TENANT_ID)
    const owner = store.resolveTenant(identity('owner', { subject: options.legacyOwnerSubject }), options)
    expect(owner).toMatchObject({ tenantId: LEGACY_TENANT_ID, membershipId: options.legacyMembershipId, issuer: options.legacyOwnerIssuer, subject: options.legacyOwnerSubject })
    expect(store.getDevice(owner.tenantId, 'private-legacy-device')).not.toBeNull()
    expect(store.findToken('absent')).toBeNull()
  })

  it('keeps identity and membership stable across email change; owner binding cannot transfer', () => {
    const { store } = fixture()
    const first = store.resolveTenant(identity('alpha'), options)
    const again = store.resolveTenant(identity('ignored-new-hash', { issuer: first.issuer, subject: first.subject, account: 'changed@example.com' }), options)
    expect(again).toEqual({ ...first, account: 'changed@example.com' })
    expect(store.getTenant(identity('ignored-new-hash').tenantId)).toBeNull()
    expect(() => store.resolveTenant(identity('collision', { tenantId: first.tenantId }), options)).toThrow('TENANT_IDENTITY_MISMATCH')
    const owner = store.resolveTenant(identity('owner', { subject: options.legacyOwnerSubject }), options)
    expect(() => store.resolveTenant(identity('replacement'), { ...options, legacyOwnerSubject: 'sub-replacement' })).toThrow('TENANT_IDENTITY_MISMATCH')
    expect(store.getTenant(LEGACY_TENANT_ID)).toEqual(owner)
    expect(() => store.ensureLegacyTenant('other-display@example.com', 'changed-membership')).toThrow('TENANT_IDENTITY_MISMATCH')
  })

  it('does not alias an existing ordinary identity into legacy after a pin is changed', () => {
    const { store } = fixture()
    const user = store.resolveTenant(identity('before-pin'), { ...options, legacyOwnerSubject: undefined })
    expect(() => store.resolveTenant(identity('before-pin'), { ...options, legacyOwnerSubject: user.subject })).toThrow('TENANT_IDENTITY_MISMATCH')
    expect(store.getTenant(LEGACY_TENANT_ID).subject).toBe('')
  })

  it('enforces capacity atomically, reserves the owner slot and counts disabled users', async () => {
    const { store, database } = fixture(), capped = { ...options, maxTenants: 2 }
    const results = await Promise.all(['first', 'second', 'third'].map(async id => {
      try { return store.resolveTenant(identity(id), capped) } catch (e) { return e.code }
    }))
    expect(results.filter(value => typeof value === 'object')).toHaveLength(1)
    expect(results.filter(value => value === 'TENANT_LIMIT_REACHED')).toHaveLength(2)
    expect(store.resolveTenant(identity('owner', { subject: options.legacyOwnerSubject }), capped).tenantId).toBe(LEGACY_TENANT_ID)
    database.sql.exec('UPDATE tenants SET active=0 WHERE tenant_id=?', results[0].tenantId)
    expect(store.getTenant(results[0].tenantId)).toBeNull()
    expect(() => store.resolveTenant(identity('first'), capped)).toThrow('TENANT_DISABLED')
    expect(() => store.resolveTenant(identity('fourth'), capped)).toThrow('TENANT_LIMIT_REACHED')
  })

  it('admits more than ten and one hundred distinct users when account count is unlimited', () => {
    const { store, database } = fixture(), unlimited = { ...options, maxTenants: 0 }
    for (let index = 0; index < 125; index++) {
      const id = String(index).padStart(5, '0')
      const admitted = store.resolveTenant(identity(id), unlimited)
      expect(admitted.subject).toBe(`sub-${id}`)
    }
    const owner = store.resolveTenant(identity('owner', { subject: options.legacyOwnerSubject }), unlimited)
    expect(owner.tenantId).toBe(LEGACY_TENANT_ID)
    database.sql.exec('UPDATE tenants SET active=0 WHERE tenant_id=?', identity('00000').tenantId)
    expect(() => store.resolveTenant(identity('00000'), unlimited)).toThrow('TENANT_DISABLED')
    expect(store.resolveTenant(identity('new-after-disabled'), unlimited).subject).toBe('sub-new-after-disabled')
  })

  it('counts claimed legacy once and permits existing tenants when the cap is lowered', () => {
    const { store } = fixture(), capped = { ...options, maxTenants: 1 }
    const ownerIdentity = identity('owner', { subject: options.legacyOwnerSubject })
    const owner = store.resolveTenant(ownerIdentity, capped)
    expect(store.resolveTenant(ownerIdentity, capped)).toEqual(owner)
    expect(() => store.resolveTenant(identity('extra'), capped)).toThrow('TENANT_LIMIT_REACHED')
    expect(() => store.resolveTenant(identity('bad'), { ...options, maxTenants: -1 })).toThrow('TENANT_CONFIG_INVALID')
  })

  it('rolls back registry initialization and allocation on insertion failure, then can retry safely', () => {
    const db = new DatabaseSync(':memory:')
    let rejectInsert = false
    const database = storage(db, query => rejectInsert && query.startsWith('INSERT INTO tenants (tenant_id, account, membership_id, issuer'))
    const store = new Store(database)
    rejectInsert = true
    expect(() => store.resolveTenant(identity('retry'), options)).toThrow('synthetic SQL failure')
    expect(store.getTenant(identity('retry').tenantId)).toBeNull()
    expect(store.getTenant(LEGACY_TENANT_ID)).toMatchObject({ account: '', membershipId: '' })
    rejectInsert = false
    expect(store.resolveTenant(identity('retry'), options).tenantId).toBe(identity('retry').tenantId)
  })

  it('disabled legacy identity does not lock out unrelated tenant resolution', () => {
    const { store, database } = fixture()
    const ownerIdentity = identity('owner', { subject: options.legacyOwnerSubject })
    store.resolveTenant(ownerIdentity, options)
    database.sql.exec('UPDATE tenants SET active=0 WHERE tenant_id=?', LEGACY_TENANT_ID)
    expect(store.getTenant(LEGACY_TENANT_ID)).toBeNull()
    expect(store.ensureLegacyTenant(options.legacyAccount, options.legacyMembershipId).tenantId).toBe(LEGACY_TENANT_ID)
    expect(() => store.resolveTenant(ownerIdentity, options)).toThrow('TENANT_DISABLED')
    expect(store.resolveTenant(identity('unrelated'), options).tenantId).toBe(identity('unrelated').tenantId)
  })

  it('refuses a membership-prefix collision instead of merging tenant authorization domains', () => {
    const { store } = fixture()
    store.resolveTenant(identity('one', { tenantId: 'same-prefix-123456-A' }), options)
    expect(() => store.resolveTenant(identity('two', { tenantId: 'same-prefix-123456-B' }), options)).toThrow('TENANT_IDENTITY_MISMATCH')
  })
})

describe('tenant-scoped devices and tokens', () => {
  it('allows equal raw device IDs with independent identity, updates, lists and revocation', () => {
    const { store } = fixture()
    const a = store.resolveTenant(identity('a'), options), b = store.resolveTenant(identity('b'), options)
    expect(store.upsertDevice(a.tenantId, device())).toEqual({ created: true })
    expect(store.upsertDevice(b.tenantId, device('same-device', { identity_key: 'second-key', name: 'second host' }))).toEqual({ created: true })
    expect(store.countDevices(a.tenantId)).toBe(1); expect(store.countDevices(b.tenantId)).toBe(1)
    expect(store.getDevice(a.tenantId, 'same-device').identity_key).toBe('synthetic-key')
    expect(store.getDevice(b.tenantId, 'same-device').identity_key).toBe('second-key')
    expect(() => store.upsertDevice(a.tenantId, device('same-device', { identity_key: 'second-key' }))).toThrow('PEER_IDENTITY_MISMATCH')
    expect(() => store.upsertDevice(a.tenantId, device('same-device', { role: 'client' }))).toThrow('PEER_IDENTITY_MISMATCH')
    store.renameDevice(a.tenantId, 'same-device', 'renamed only a')
    store.touchDevice(a.tenantId, 'same-device', '2.0.0', '3.0.0')
    expect(store.getDevice(a.tenantId, 'same-device')).toMatchObject({ name: 'renamed only a', client_version: '2.0.0', harness_version: '3.0.0' })
    expect(store.getDevice(b.tenantId, 'same-device')).toMatchObject({ name: 'second host', client_version: '1.0.0', last_seen_at: 0 })
    store.upsertDevice(a.tenantId, device('client', { role: 'client', harness_version: null }))
    store.touchDevice(a.tenantId, 'client', '2.0.0', 'ignored-host-version')
    expect(store.getDevice(a.tenantId, 'client').harness_version).toBeNull()
    const expires = Date.now() + 60_000
    store.insertToken('a-token', a.tenantId, 'same-device', 'access', expires)
    store.insertToken('b-token', b.tenantId, 'same-device', 'access', expires)
    store.revokeDevice(a.tenantId, 'same-device')
    expect(store.listDevices(a.tenantId).map(d => d.device_id)).toEqual(['client'])
    expect(store.listDevices(b.tenantId).map(d => d.device_id)).toEqual(['same-device'])
    expect(store.findToken('a-token')).toBeNull(); expect(store.findToken('b-token').tenant_id).toBe(b.tenantId)
    expect(() => store.upsertDevice(a.tenantId, device())).toThrow('DEVICE_REVOKED')
    expect(() => store.insertToken('revoked', a.tenantId, 'same-device', 'access', expires)).toThrow('AUTH_INVALID')
  })

  it('scopes token deletion/counts, keeps global lookup tenant-bound and rejects mismatched device minting', () => {
    const { store } = fixture(), a = store.resolveTenant(identity('a'), options), b = store.resolveTenant(identity('b'), options)
    store.upsertDevice(a.tenantId, device('a-only')); store.upsertDevice(b.tenantId, device('b-only'))
    const future = Date.now() + 60_000
    store.insertToken('a-access', a.tenantId, 'a-only', 'access', future)
    store.insertToken('a-refresh', a.tenantId, 'a-only', 'refresh', future)
    store.insertToken('b-access', b.tenantId, 'b-only', 'access', future)
    expect(store.countTokens(a.tenantId)).toBe(2); expect(store.countTokens(b.tenantId)).toBe(1)
    expect(store.findToken('a-refresh')).toMatchObject({ tenant_id: a.tenantId, device_id: 'a-only', used: 0 })
    store.markTokenUsed('a-refresh'); expect(store.findToken('a-refresh').used).toBe(1)
    expect(() => store.insertToken('wrong', b.tenantId, 'a-only', 'access', future)).toThrow('AUTH_INVALID')
    expect(() => store.insertToken('unknown', 'unknown-tenant', 'a-only', 'access', future)).toThrow('AUTH_INVALID')
    store.renameDevice(b.tenantId, 'a-only', 'not a permission'); store.revokeDevice(b.tenantId, 'a-only')
    expect(store.getDevice(a.tenantId, 'a-only').name).toBe('synthetic host')
    expect(store.countTokens(a.tenantId)).toBe(1)
    store.deleteTokensFor(a.tenantId, 'a-only')
    expect(store.countTokens(a.tenantId)).toBe(0); expect(store.countTokens(b.tenantId)).toBe(1)
    store.insertToken('expired', b.tenantId, 'b-only', 'access', 1)
    store.purgeExpiredTokens(2)
    expect(store.findToken('expired')).toBeNull(); expect(store.findToken('b-access')).not.toBeNull()
  })

  it('preserves used refresh tombstones during rotation but revocation clears only that tenant', () => {
    const { store } = fixture(), a = store.resolveTenant(identity('a'), options), b = store.resolveTenant(identity('b'), options)
    for (const tenant of [a, b]) store.upsertDevice(tenant.tenantId, device('same-device'))
    const future = Date.now() + 60_000
    store.insertToken('used-refresh', a.tenantId, 'same-device', 'refresh', future)
    store.insertToken('old-access', a.tenantId, 'same-device', 'access', future)
    store.insertToken('b-access', b.tenantId, 'same-device', 'access', future)
    store.markTokenUsed('used-refresh'); store.deleteTokensFor(a.tenantId, 'same-device', true)
    expect(store.findToken('used-refresh')?.used).toBe(1)
    expect(store.countTokens(a.tenantId)).toBe(0)
    expect(store.findToken('old-access')).toBeNull()
    store.insertToken('new-access', a.tenantId, 'same-device', 'access', future)
    expect(store.countTokens(a.tenantId)).toBe(1)
    store.revokeDevice(a.tenantId, 'same-device')
    expect(store.findToken('used-refresh')).toBeNull()
    expect(store.findToken('b-access')?.tenant_id).toBe(b.tenantId)
  })

  it('enforces token limits per tenant rather than globally', () => {
    const { store } = fixture(), a = store.resolveTenant(identity('a'), options), b = store.resolveTenant(identity('b'), options)
    store.upsertDevice(a.tenantId, device('device')); store.upsertDevice(b.tenantId, device('device'))
    for (let index=0; index<LIMITS.tokens; index++) store.insertToken(`a-${index}`, a.tenantId, 'device', 'access', Date.now()+60_000)
    expect(() => store.insertToken('overflow', a.tenantId, 'device', 'access', Date.now()+60_000)).toThrow('RATE_LIMITED')
    expect(() => store.insertToken('b-first', b.tenantId, 'device', 'access', Date.now()+60_000)).not.toThrow()
    expect(store.countTokens(a.tenantId)).toBe(LIMITS.tokens); expect(store.countTokens(b.tenantId)).toBe(1)
  })

  it('enforces per-tenant device limits without consuming another tenant capacity', () => {
    const { store } = fixture(), a = store.resolveTenant(identity('a'), options), b = store.resolveTenant(identity('b'), options)
    for (let index=0; index<LIMITS.devices; index++) store.upsertDevice(a.tenantId, device(`a-${index}`))
    expect(() => store.upsertDevice(a.tenantId, device('overflow'))).toThrow('RATE_LIMITED')
    expect(store.upsertDevice(b.tenantId, device('first'))).toEqual({ created: true })
    expect(store.getDevice(b.tenantId, 'a-0')).toBeNull()
  })
})
