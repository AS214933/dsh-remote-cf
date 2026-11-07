import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/env.js'
import type { TenantPrincipal } from '../src/store.js'
import { createControlFrame, type ControlFrame } from '../src/protocol.js'
import { sha256Hex } from '../src/crypto.js'

// Store's SQL isolation is exercised separately. These tests invoke the actual
// Gateway auth/WS/link/ICE handlers with two tenants sharing identical device IDs.
vi.mock('../src/store.js', () => ({
  LIMITS: { tokens: 1024, accessTokenMs: 3_600_000, refreshTokenMs: 86400_000 },
  StoreError: class StoreError extends Error { constructor(readonly code: string, readonly status: number) { super(code) } },
  Store: class {
    constructor(private storage: StateData) {}
    ensureLegacyTenant() { return { tenantId: 'legacy-owner' } }
    getTenant(tenant: string) { return this.storage.tenants.get(tenant) ?? null }
    getDevice(tenant: string, id: string) { return this.storage.devices.get(JSON.stringify([tenant, id])) ?? null }
    listDevices(tenant: string) { return [...this.storage.devices.values()].filter(row => row.tenant_id === tenant && !row.revoked) }
    findToken(digest: string) { return this.storage.tokens.get(digest) ?? null }
    upsertDevice(tenant: string, input: Record<string, unknown>) {
      const key = JSON.stringify([tenant, input.device_id]), existing = this.storage.devices.get(key)
      if (!existing) throw new Error('test fixture expects an existing device')
      Object.assign(existing, input)
      return { created: false }
    }
    touchDevice() {}
    revokeDevice(tenant: string, id: string) { const row = this.getDevice(tenant, id); if (row) row.revoked = 1; this.deleteTokensFor(tenant, id) }
    renameDevice(tenant: string, id: string, name: string) { const row = this.getDevice(tenant, id); if (row) row.name = name }
    deleteTokensFor(tenant: string, id: string, preserveUsedRefresh = false) { for (const [digest, row] of this.storage.tokens) if (row.tenant_id === tenant && row.device_id === id && !(preserveUsedRefresh && row.kind === 'refresh' && row.used !== 0)) this.storage.tokens.delete(digest) }
    markTokenUsed(digest: string) { const row = this.storage.tokens.get(digest); if (row) row.used = 1 }
    purgeExpiredTokens() {}
    countTokens(tenant: string) { return [...this.storage.tokens.values()].filter(row => row.tenant_id === tenant).length }
    insertToken(digest: string, tenant: string, id: string, kind: string, expiry: number) { this.storage.tokens.set(digest, { tenant_id: tenant, device_id: id, kind, expires_at: expiry, used: 0 }) }
  },
}))
import { Gateway, MAX_TENANT_PEERS } from '../src/gateway.js'

const HOST = '00000000-0000-4000-8000-000000000001'
const CLIENT = '00000000-0000-4000-8000-000000000002'
const HOST_ONLY_B = '00000000-0000-4000-8000-000000000003'
const CAPS = ['transport.relay', 'transport.p2p', 'transport.turn']
type Device = { tenant_id: string; device_id: string; role: 'host' | 'client'; name: string; platform: string; identity_key: string; client_version: string; harness_version: null; revoked: number; last_seen_at: number }
type Token = { tenant_id: string; device_id: string; kind: string; expires_at: number; used: number }
type StateData = { tenants: Map<string, TenantPrincipal>; devices: Map<string, Device>; tokens: Map<string, Token> }
class Socket {
  static OPEN = 1
  readyState = Socket.OPEN
  frames: ControlFrame[] = []
  closes: { code: number; reason: string }[] = []
  constructor(private attachment: Record<string, unknown>) { this.attachment = structuredClone(attachment) }
  serializeAttachment(value: Record<string, unknown>) { this.attachment = structuredClone(value) }
  deserializeAttachment(): Record<string, unknown> { return structuredClone(this.attachment) }
  send(raw: string) { this.frames.push(JSON.parse(raw)) }
  close(code: number, reason: string) { this.closes.push({ code, reason }); this.readyState = 3 }
}
function peer(tenantId: string, deviceId: string, role: 'host' | 'client', extra = {}): Socket {
  return new Socket({ state: 'authenticated', tenantId, deviceId, role, capabilities: CAPS, version: '0.6.3', lastPong: Date.now(), sessionId: `${tenantId}-${deviceId}`, ...extra })
}
async function fixture(sockets = [peer('tenant-a', HOST, 'host'), peer('tenant-a', CLIENT, 'client'), peer('tenant-b', HOST, 'host'), peer('tenant-b', CLIENT, 'client')]) {
  let alarm: number | null = null
  const data: StateData = { tenants: new Map(['tenant-a', 'tenant-b'].map(tenantId => [tenantId, { tenantId, account: `${tenantId}@example.com`, membershipId: `membership-${tenantId}`, issuer: 'https://auth.example.com/oidc', subject: tenantId }])), devices: new Map(), tokens: new Map() }
  for (const tenant of ['tenant-a', 'tenant-b']) for (const [id, role] of [[HOST, 'host'], [CLIENT, 'client'], ...(tenant === 'tenant-b' ? [[HOST_ONLY_B, 'host']] : [])] as const) {
    data.devices.set(JSON.stringify([tenant, id]), { tenant_id: tenant, device_id: id, role: role as 'host' | 'client', name: `${tenant}-${role}`, platform: 'test', identity_key: 'a'.repeat(42) + 'A', client_version: '0.6.3', harness_version: null, revoked: 0, last_seen_at: Date.now() })
    data.tokens.set(await sha256Hex(`${tenant}-${id}`), { tenant_id: tenant, device_id: id, kind: 'access', expires_at: Date.now() + 3600_000, used: 0 })
  }
  const tasks: Promise<unknown>[] = []
  const storage = { ...data, getAlarm: vi.fn(async () => alarm), setAlarm: vi.fn(async (value: number | Date) => { alarm = Number(value) }) }
  const ctx = { storage, getWebSockets: () => sockets, waitUntil: (task: Promise<unknown>) => { tasks.push(task) } }
  const env = { DSH_SERVER_ACCOUNT: 'owner@example.com', TURN_KEY_ID: 'synthetic-key', TURN_KEY_API_TOKEN: 'synthetic-token' } as Env
  const wake = () => new Gateway(ctx as unknown as DurableObjectState, env)
  const message = (gateway: Gateway, socket: Socket, type: Parameters<typeof createControlFrame>[0], payload: Record<string, unknown>) => gateway.webSocketMessage(socket as unknown as WebSocket, JSON.stringify(createControlFrame(type, payload)))
  return { data, sockets, tasks, env, wake, message }
}
async function open(f: Awaited<ReturnType<typeof fixture>>, gateway: Gateway, offset: number) {
  await f.message(gateway, f.sockets[offset + 1]!, 'connect.request', { hostDeviceId: HOST, preferredTransports: ['p2p', 'turn', 'relay'] })
  const frame = f.sockets[offset]!.frames.filter(frame => frame.type === 'connect.incoming').at(-1)
  expect(frame).toBeDefined()
  return frame!.payload.connectionId as string
}
async function accept(f: Awaited<ReturnType<typeof fixture>>, gateway: Gateway, id: string, offset: number) {
  await f.message(gateway, f.sockets[offset]!, 'connect.accepted', { connectionId: id })
}
beforeEach(() => { vi.stubGlobal('WebSocket', Socket); vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Gateway tenant isolation', () => {
  it('rejects an older issuing generation when same-device registration overtakes its hash await', async () => {
    const f = await fixture(), gateway = f.wake(), original = crypto.subtle.digest.bind(crypto.subtle)
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    let notify!: () => void
    const started = new Promise<void>(resolve => { notify = resolve })
    let blockNext = true
    vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      if (blockNext) { blockNext = false; notify(); await paused }
      return original(algorithm, data)
    })
    const input = { deviceId: CLIENT, role: 'client' as const, name: 'same-device', platform: 'test', identityKey: 'a'.repeat(42) + 'A', clientVersion: '0.6.3' }
    const older = gateway.registerDevice('tenant-a', input)
    await started
    const newer = await gateway.registerDevice('tenant-a', input)
    release()
    expect((await older).ok).toBe(false)
    expect(newer.ok).toBe(true)
    if (newer.ok) expect((await gateway.authenticateDevice(newer.value.accessToken)).ok).toBe(true)
    expect((await gateway.authenticateDevice(`tenant-b-${CLIENT}`)).ok).toBe(true)
  })

  it('retains refresh tombstones and revokes only the replayed tenant, including racing reuse', async () => {
    for (const racing of [false, true]) {
      const f = await fixture(), gateway = f.wake(), raw = `synthetic-refresh-${racing}`
      f.data.tokens.set(await sha256Hex(raw), { tenant_id: 'tenant-a', device_id: CLIENT, kind: 'refresh', used: 0, expires_at: Date.now() + 60_000 })
      if (racing) {
        const results = await Promise.all([gateway.refreshToken(CLIENT, raw), gateway.refreshToken(CLIENT, raw)])
        expect(results.some(result => !result.ok)).toBe(true)
      } else {
        expect((await gateway.refreshToken(CLIENT, raw)).ok).toBe(true)
        expect((await gateway.refreshToken(CLIENT, raw)).ok).toBe(false)
      }
      expect(f.data.devices.get(JSON.stringify(['tenant-a', CLIENT]))?.revoked).toBe(1)
      expect(f.data.devices.get(JSON.stringify(['tenant-b', CLIENT]))?.revoked).toBe(0)
      expect((await gateway.authenticateDevice(`tenant-b-${CLIENT}`)).ok).toBe(true)
    }
  })

  it('keeps identical device IDs online independently, including after real handler link restore', async () => {
    const f = await fixture(); let gateway = f.wake()
    const a = await open(f, gateway, 0); const b = await open(f, gateway, 2)
    expect(a).not.toBe(b)
    expect(f.sockets[0]!.frames.filter(frame => frame.type === 'connect.incoming')).toHaveLength(1)
    expect(f.sockets[2]!.frames.filter(frame => frame.type === 'connect.incoming')).toHaveLength(1)
    gateway = f.wake()
    await accept(f, gateway, a, 0); await accept(f, gateway, b, 2)
    expect(f.sockets[1]!.frames.some(frame => frame.type === 'connect.accepted' && frame.payload.connectionId === a)).toBe(true)
    expect(f.sockets[3]!.frames.some(frame => frame.type === 'connect.accepted' && frame.payload.connectionId === b)).toBe(true)
    expect((await gateway.listDevices('tenant-a')).every(row => row.name.startsWith('tenant-a') && row.online)).toBe(true)
    expect((await gateway.authenticateDevice(`tenant-b-${CLIENT}`))).toMatchObject({ ok: true, value: { tenantId: 'tenant-b', account: 'tenant-b@example.com', membershipId: 'membership-tenant-b', online: true } })
  })

  it('denies cross-tenant descriptors, connect targets, accept, relay and lease without touching victim link', async () => {
    const f = await fixture(); const gateway = f.wake(); const victim = await open(f, gateway, 2)
    expect(await gateway.getAuthorizedPeer(`tenant-a-${CLIENT}`, HOST_ONLY_B)).toMatchObject({ ok: false, code: 'DEVICE_NOT_FOUND' })
    await f.message(gateway, f.sockets[1]!, 'connect.request', { hostDeviceId: HOST_ONLY_B, preferredTransports: ['relay'] })
    expect(f.sockets[1]!.frames.at(-1)?.payload.code).toBe('HOST_OFFLINE')
    await f.message(gateway, f.sockets[0]!, 'connect.accepted', { connectionId: victim })
    expect(f.sockets[0]!.frames.at(-1)?.payload.code).toBe('CONNECTION_NOT_FOUND')
    for (const type of ['signal.offer', 'relay', 'connection.lease.close'] as const) await f.message(gateway, f.sockets[1]!, type, { connectionId: victim, targetDeviceId: HOST, counter: 0, payload: 'opaque' })
    expect(f.sockets[3]!.frames.some(frame => frame.type === 'error')).toBe(false)
    await accept(f, gateway, victim, 2)
    expect(f.sockets[3]!.frames.some(frame => frame.type === 'connect.accepted')).toBe(true)
  })

  it('revokes, renames and replaces only the exact tenant/device composite', async () => {
    const f = await fixture(); const gateway = f.wake()
    await gateway.renameDevice('tenant-a', HOST, 'only-a')
    expect((await gateway.getDevice('tenant-a', HOST))?.name).toBe('only-a')
    expect((await gateway.getDevice('tenant-b', HOST))?.name).toBe('tenant-b-host')
    await gateway.revokeDevice('tenant-a', HOST)
    expect(f.sockets[0]!.readyState).toBe(3)
    expect(f.sockets[2]!.readyState).toBe(1)
    const replacement = new Socket({ state: 'awaiting_hello', helloDeadline: Date.now() + 5000 }); f.sockets.push(replacement)
    await f.message(gateway, replacement, 'hello', { deviceId: CLIENT, role: 'client', accessToken: `tenant-b-${CLIENT}`, protocols: [1], capabilities: CAPS })
    expect(f.sockets[3]!.closes.at(-1)?.code).toBe(4003)
    expect(f.sockets[1]!.readyState).toBe(1)
  })

  it('fails closed for pre-tenant attachments and cross-tenant forged snapshots', async () => {
    const legacy = peer('tenant-a', CLIENT, 'client'); const attachment = legacy.deserializeAttachment(); delete attachment.tenantId; legacy.serializeAttachment(attachment)
    const f = await fixture([peer('tenant-a', HOST, 'host'), legacy, peer('tenant-b', HOST, 'host'), peer('tenant-b', CLIENT, 'client')]); f.wake()
    expect(legacy.closes.at(-1)?.reason).toBe('AUTH_INVALID')
    const clean = await fixture(); let gateway = clean.wake(); const id = await open(clean, gateway, 0)
    const forged = clean.sockets[1]!.deserializeAttachment(); (forged.link as Record<string, unknown>).tenantId = 'tenant-b'; clean.sockets[1]!.serializeAttachment(forged)
    gateway = clean.wake(); await accept(clean, gateway, id, 0)
    expect(clean.sockets[0]!.frames.at(-1)?.payload.code).toBe('CONNECTION_NOT_FOUND')
  })

  it('isolates TURN cache identity and revalidates both tenants around issuance', async () => {
    let count = 0
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ iceServers: [{ urls: ['turn:turn.example.com'], username: `user-${++count}`, credential: 'synthetic' }] })))
    const f = await fixture(); const gateway = f.wake(); const a = await open(f, gateway, 0); const b = await open(f, gateway, 2)
    await accept(f, gateway, a, 0); await accept(f, gateway, b, 2); await Promise.all(f.tasks)
    const one = await gateway.getIceServers(`tenant-a-${CLIENT}`, a); const two = await gateway.getIceServers(`tenant-b-${CLIENT}`, b)
    expect(count).toBe(4)
    expect(one.ok && two.ok && one.value[0]?.username !== two.value[0]?.username).toBe(true)
    expect(await gateway.getIceServers(`tenant-a-${CLIENT}`, b)).toMatchObject({ ok: false, code: 'CONNECTION_NOT_FOUND' })
    await gateway.revokeDevice('tenant-a', CLIENT)
    expect((await gateway.getIceServers(`tenant-b-${CLIENT}`, b)).ok).toBe(true)
  })

  it('derives refresh tenant from its secret before device lookup and leaves colliding tenant untouched', async () => {
    const f = await fixture(); const gateway = f.wake()
    const digest = await sha256Hex('tenant-a-refresh')
    f.data.tokens.set(digest, { tenant_id: 'tenant-a', device_id: CLIENT, kind: 'refresh', expires_at: Date.now() + 3600_000, used: 0 })
    expect(await gateway.refreshToken(HOST_ONLY_B, 'tenant-a-refresh')).toMatchObject({ ok: false, code: 'AUTH_INVALID' })
    expect(f.data.tokens.has(digest)).toBe(true)
    expect((await gateway.refreshToken(CLIENT, 'tenant-a-refresh')).ok).toBe(true)
    expect((await gateway.authenticateDevice(`tenant-b-${CLIENT}`))).toMatchObject({ ok: true, value: { tenantId: 'tenant-b' } })
    expect((await gateway.authenticateDevice(`tenant-a-${CLIENT}`))).toMatchObject({ ok: false, code: 'AUTH_INVALID' })
  })

  it('rejects returned ICE credentials when tenant is disabled while mint yields', async () => {
    let release!: (response: Response) => void
    const held = new Promise<Response>(resolve => { release = resolve })
    vi.stubGlobal('fetch', vi.fn(async () => (await held).clone()))
    const f = await fixture(); const gateway = f.wake(); const id = await open(f, gateway, 0)
    await accept(f, gateway, id, 0)
    const response = gateway.getIceServers(`tenant-a-${CLIENT}`, id)
    await new Promise(resolve => setTimeout(resolve, 0))
    f.data.tenants.delete('tenant-a')
    release(Response.json({ iceServers: [{ urls: ['turn:turn.example.com'], username: 'synthetic', credential: 'synthetic' }] }))
    expect(await response).toMatchObject({ ok: false, code: 'AUTH_INVALID' })
    await Promise.all(f.tasks)
  })

  it('rejects disabled tenants even with valid raw tokens or restored attachment', async () => {
    const f = await fixture(); f.data.tenants.delete('tenant-a'); const gateway = f.wake()
    expect(f.sockets[0]!.closes.at(-1)?.reason).toBe('AUTH_INVALID')
    expect(await gateway.authenticateDevice(`tenant-a-${CLIENT}`)).toMatchObject({ ok: false, code: 'AUTH_INVALID' })
    expect((await gateway.listDevices('tenant-b')).length).toBe(3)
  })

  it('enforces the per-tenant peer cap without consuming another tenant slot', async () => {
    const f = await fixture(); const sockets = f.sockets
    for (let n = 0; n < MAX_TENANT_PEERS; n++) {
      const id = `00000000-0000-4000-8001-${String(n).padStart(12, '0')}`
      const template = f.data.devices.get(JSON.stringify(['tenant-a', CLIENT]))!
      f.data.devices.set(JSON.stringify(['tenant-a', id]), { ...template, device_id: id })
      sockets.push(peer('tenant-a', id, 'client'))
    }
    const gateway = f.wake()
    expect(sockets.filter(s => s.deserializeAttachment().tenantId === 'tenant-a' && s.readyState === 1)).toHaveLength(MAX_TENANT_PEERS)
    expect(f.sockets[2]!.readyState).toBe(1)
    expect((await gateway.authenticateDevice(`tenant-b-${CLIENT}`))).toMatchObject({ ok: true })
  })
})
