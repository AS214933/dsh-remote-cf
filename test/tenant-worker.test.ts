import { describe, expect, it, vi } from 'vitest'
import worker from '../src/worker.js'
import { signSession } from '../src/crypto.js'
import type { Env } from '../src/env.js'

const ORIGIN = 'https://relay.example'
const SECRET = 'tenant-worker-session-secret-long-enough'
const ISSUER = 'https://auth.example.com/oidc'
const A = { tenantId: 'a'.repeat(64), account: 'a@example.com', membershipId: 'account:tenant-a', issuer: ISSUER, subject: 'subject-a' }
const B = { tenantId: 'b'.repeat(64), account: 'b@example.com', membershipId: 'account:tenant-b', issuer: ISSUER, subject: 'subject-b' }
const HOST = '00000000-0000-4000-8000-000000000001'
const CLIENT = '00000000-0000-4000-8000-000000000002'
const B_ONLY = '00000000-0000-4000-8000-000000000003'
const key = (tenant: string, id: string) => JSON.stringify([tenant, id])
let sequence = 0

function fixture() {
  const tenants = new Map([A, B].map(principal => [principal.tenantId, { ...principal }]))
  const devices = new Map<string, Record<string, unknown>>()
  for (const principal of [A, B]) for (const [id, role] of [[HOST, 'host'], [CLIENT, 'client']] as const) {
    devices.set(key(principal.tenantId, id), { ...principal, deviceId: id, role, name: `${principal.subject}-${role}`,
      platform: 'test', identityKey: `${principal === A ? 'A' : 'B'}`.repeat(43), clientVersion: '1.0.0', harnessVersion: null,
      online: true, lastSeenAt: 123, revoked: false })
  }
  devices.set(key(B.tenantId, B_ONLY), { ...devices.get(key(B.tenantId, HOST)), deviceId: B_ONLY, name: 'b-only-host' })
  const tokenDevice = (token: string) => token === 'a-device-token' ? devices.get(key(A.tenantId, CLIENT))
    : token === 'b-device-token' ? devices.get(key(B.tenantId, CLIENT)) : null
  const stub = {
    getTenant: vi.fn(async (tenantId: string) => tenants.get(tenantId) ?? null),
    listDevices: vi.fn(async (tenantId: string) => [...devices.values()].filter(device => device.tenantId === tenantId)),
    getDevice: vi.fn(async (tenantId: string, deviceId: string) => devices.get(key(tenantId, deviceId)) ?? null),
    revokeDevice: vi.fn(async (tenantId: string, deviceId: string) => { devices.delete(key(tenantId, deviceId)) }),
    renameDevice: vi.fn(async (tenantId: string, deviceId: string, name: string) => { const device = devices.get(key(tenantId, deviceId)); if (device) device.name = name }),
    registerDevice: vi.fn(async (tenantId: string, input: Record<string, unknown>) => {
      expect(tenants.has(tenantId)).toBe(true)
      return { ok: true, value: { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', accessTokenExpiresAt: Date.now() + 60_000, refreshTokenExpiresAt: Date.now() + 120_000 } }
    }),
    authenticateDevice: vi.fn(async (token: string) => { const device = tokenDevice(token); return device ? { ok: true, value: device } : { ok: false, code: 'AUTH_INVALID', status: 401 } }),
    getAuthorizedPeer: vi.fn(async (token: string, targetId: string) => {
      const source = tokenDevice(token)
      if (!source) return { ok: false, code: 'AUTH_INVALID', status: 401 }
      const target = devices.get(key(source.tenantId as string, targetId))
      if (!target) return { ok: false, code: 'DEVICE_NOT_FOUND', status: 404 }
      if (target.role === source.role) return { ok: false, code: 'MEMBERSHIP_REQUIRED', status: 403 }
      return { ok: true, value: target }
    }),
  }
  const env = { DSH_SERVER_ACCOUNT: 'owner@example.com', DSH_SERVER_PASSWORD: 'synthetic-password', DSH_SERVER_PUBLIC_URL: ORIGIN,
    SESSION_SECRET: SECRET, GATEWAY: { getByName: () => stub }, ASSETS: { fetch: vi.fn() } } as unknown as Env
  async function session(principal = A, overrides = {}) {
    return signSession(SECRET, { v: 2, ...principal, expiresAt: Date.now() + 60_000, ...overrides })
  }
  async function send(path: string, token: string, method = 'GET', body?: unknown) {
    return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: { Authorization: `Bearer ${token}`,
      'CF-Connecting-IP': `198.51.100.${++sequence % 250 + 1}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env)
  }
  return { env, devices, tenants, stub, session, send }
}

describe('Worker derives every account operation from authenticated tenant identity', () => {
  it('rejects tenantless legacy sessions and wrong issuer/subject before scoped operations', async () => {
    const f = fixture()
    const legacy = await signSession(SECRET, { account: A.account, expiresAt: Date.now() + 60_000 })
    expect((await f.send('/api/v1/account/devices', legacy)).status).toBe(401)
    expect(f.stub.getTenant).not.toHaveBeenCalled()
    expect((await f.send('/api/v1/account/devices', await f.session(A, { subject: B.subject }))).status).toBe(401)
    expect((await f.send('/api/v1/account/devices', await f.session(A, { issuer: 'https://other.example/oidc' }))).status).toBe(401)
    expect(f.stub.listDevices).not.toHaveBeenCalled()
  })

  it('lists only own account devices and ignores forged tenant/membership selectors', async () => {
    const f = fixture()
    const tokenA = await f.session(A), tokenB = await f.session(B)
    const a = await (await f.send(`/api/v1/account/devices?tenantId=${B.tenantId}&account=${B.account}`, tokenA)).json() as { items: Array<Record<string, unknown>> }
    const b = await (await f.send('/api/v1/account/devices', tokenB)).json() as { items: Array<Record<string, unknown>> }
    expect(a.items).toHaveLength(2); expect(b.items).toHaveLength(3)
    expect(a.items.every(device => device.membershipId === A.membershipId)).toBe(true)
    expect(a.items.map(device => device.name)).toEqual(['subject-a-host', 'subject-a-client'])
    expect(b.items.every(device => device.membershipId === B.membershipId)).toBe(true)
    expect(f.stub.listDevices).toHaveBeenNthCalledWith(1, A.tenantId)
    expect(f.stub.listDevices).toHaveBeenNthCalledWith(2, B.tenantId)
  })

  it('cannot target foreign-only devices or rename/revoke a same-ID foreign copy', async () => {
    const f = fixture(), token = await f.session(A)
    expect((await f.send(`/api/v1/account/devices/${B_ONLY}?tenantId=${B.tenantId}`, token, 'DELETE')).status).toBe(404)
    expect(f.stub.revokeDevice).not.toHaveBeenCalled()
    const rename = await f.send(`/api/v1/devices/${HOST}/name?tenantId=${B.tenantId}`, token, 'POST', { tenantId: B.tenantId, name: 'renamed-own-host' })
    expect(rename.status).toBe(200)
    expect(f.stub.renameDevice).toHaveBeenCalledWith(A.tenantId, HOST, 'renamed-own-host')
    expect(f.devices.get(key(A.tenantId, HOST))?.name).toBe('renamed-own-host')
    expect(f.devices.get(key(B.tenantId, HOST))?.name).toBe('subject-b-host')
    expect((await f.send(`/api/v1/account/devices/${HOST}`, token, 'DELETE')).status).toBe(200)
    expect(f.stub.revokeDevice).toHaveBeenCalledWith(A.tenantId, HOST)
    expect(f.devices.has(key(A.tenantId, HOST))).toBe(false)
    expect(f.devices.has(key(B.tenantId, HOST))).toBe(true)
  })

  it('registers only in session/device authority tenant even when the body forges another tenant', async () => {
    const f = fixture(), token = await f.session(A)
    const body = { v: 1, tenantId: B.tenantId, account: B.account, device: { deviceId: HOST, tenantId: B.tenantId,
      role: 'host', name: 'own host', platform: 'test', identityKey: 'A'.repeat(43), clientVersion: '1.0.0' } }
    expect((await f.send(`/api/v1/devices/register?tenantId=${B.tenantId}`, token, 'POST', body)).status).toBe(200)
    expect(f.stub.registerDevice.mock.calls[0]?.[0]).toBe(A.tenantId)
    expect(f.stub.registerDevice.mock.calls[0]?.[1]).not.toHaveProperty('tenantId')
    expect((await f.send('/api/v1/devices/register-owned-role', 'a-device-token', 'POST', body)).status).toBe(200)
    expect(f.stub.registerDevice.mock.calls[1]?.[0]).toBe(A.tenantId)
  })

  it('device descriptor/presence/list authority cannot select another tenant using target/query/header data', async () => {
    const f = fixture()
    const peer = await f.send(`/api/v1/devices/${HOST}?tenantId=${B.tenantId}`, 'a-device-token')
    expect(peer.status).toBe(200)
    const descriptor = await peer.json() as Record<string, unknown>
    expect(descriptor.name).toBe('subject-a-host'); expect(descriptor.membershipId).toBe(A.membershipId)
    expect(descriptor.identityKey).toBe('A'.repeat(43))
    expect((await f.send(`/api/v1/devices/${B_ONLY}/presence?tenantId=${B.tenantId}`, 'a-device-token')).status).toBe(404)
    const listing = await (await f.send(`/api/v1/devices?tenantId=${B.tenantId}`, 'a-device-token')).json() as { items: Array<Record<string, unknown>> }
    expect(listing.items).toHaveLength(1)
    expect(listing.items[0]?.name).toBe('subject-a-host')
    expect(listing.items[0]).not.toHaveProperty('identityKey')
    expect(f.stub.listDevices).toHaveBeenCalledWith(A.tenantId)
  })

  it('revalidates live registry membership instead of accepting a previously signed disabled tenant', async () => {
    const f = fixture(), token = await f.session(A)
    expect((await f.send('/api/v1/auth/me', token)).status).toBe(200)
    f.tenants.delete(A.tenantId)
    expect((await f.send('/api/v1/account/devices', token)).status).toBe(401)
    expect(f.stub.listDevices).not.toHaveBeenCalled()
  })
})
