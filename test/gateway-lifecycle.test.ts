import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/env.js'
import { createControlFrame, type ControlFrame } from '../src/protocol.js'

// Only SQLite is replaced. Every assertion below invokes the real Gateway handlers.
vi.mock('../src/store.js', () => ({
  StoreError: class StoreError extends Error {},
  Store: class {
    constructor(private storage: { devices: Map<string, Record<string, unknown>>; token: Record<string, unknown> | null }) {}
    getDevice(id: string) { return this.storage.devices.get(id) ?? null }
    listDevices() { return [...this.storage.devices.values()] }
    findToken() { return this.storage.token }
    revokeDevice(id: string) { const device = this.getDevice(id); if (device) device.revoked = 1 }
    touchDevice() {}
  },
}))
import { Gateway } from '../src/gateway.js'

const HOST = '00000000-0000-4000-8000-000000000001'
const CLIENT = '00000000-0000-4000-8000-000000000002'
const CLIENT_B = '00000000-0000-4000-8000-000000000003'
const CAPS = ['transport.relay', 'transport.p2p', 'transport.turn']

class Socket {
  static OPEN = 1
  static CLOSED = 3
  readyState = Socket.OPEN
  frames: ControlFrame[] = []
  closes: { code: number; reason: string }[] = []
  private attachment: Record<string, unknown>
  constructor(attachment: Record<string, unknown>) { this.attachment = structuredClone(attachment) }
  serializeAttachment(value: Record<string, unknown>) { this.attachment = structuredClone(value) }
  deserializeAttachment(): Record<string, unknown> { return structuredClone(this.attachment) }
  send(raw: string) { this.frames.push(JSON.parse(raw)) }
  close(code: number, reason: string) { this.closes.push({ code, reason }); this.readyState = Socket.CLOSED }
}
function peer(id: string, role: 'host' | 'client', extra: Record<string, unknown> = {}): Socket {
  return new Socket({ state: 'authenticated', deviceId: id, role, capabilities: CAPS,
    version: '0.6.3', lastPong: Date.now(), connectedAt: Date.now(), sessionId: `session-${id}`, ...extra })
}
function fixture(sockets = [peer(HOST, 'host'), peer(CLIENT, 'client')]) {
  let alarm: number | null = null
  const devices = new Map([HOST, CLIENT, CLIENT_B].map(id => [id, {
    device_id: id, role: id === HOST ? 'host' : 'client', revoked: 0,
    client_version: '0.6.3', identity_key: 'a'.repeat(42) + 'A', last_seen_at: Date.now(),
  }]))
  const storage = { devices, token: { device_id: CLIENT, kind: 'access', expires_at: Date.now() + 3_600_000 } as Record<string, unknown> | null,
    getAlarm: vi.fn(async () => alarm),
    setAlarm: vi.fn(async (value: number | Date) => { alarm = Number(value) }),
    deleteAlarm: vi.fn(async () => { alarm = null }) }
  const tasks: Promise<unknown>[] = []
  const state = { storage, getWebSockets: () => sockets, waitUntil: (task: Promise<unknown>) => { tasks.push(task) } }
  const env = { TURN_KEY_ID: 'key', TURN_KEY_API_TOKEN: 'test', DSH_SERVER_ACCOUNT: 'owner@example.com' } as Env
  const wake = () => new Gateway(state as unknown as DurableObjectState, env)
  const message = (gateway: Gateway, socket: Socket, type: Parameters<typeof createControlFrame>[0], payload: Record<string, unknown>) =>
    gateway.webSocketMessage(socket as unknown as WebSocket, JSON.stringify(createControlFrame(type, payload)))
  return { sockets, storage, state, env, wake, message, tasks, alarm: () => alarm }
}
async function openLink(f: ReturnType<typeof fixture>, gateway: Gateway, client = f.sockets[1]!) {
  await f.message(gateway, client, 'connect.request', { hostDeviceId: HOST, preferredTransports: ['p2p', 'turn', 'relay'] })
  const incoming = f.sockets[0]!.frames.filter(frame => frame.type === 'connect.incoming').at(-1)
  expect(incoming, 'host must receive the connect request without an alarm first').toBeDefined()
  return incoming!.payload.connectionId as string
}
async function acceptLink(f: ReturnType<typeof fixture>, gateway: Gateway, connectionId: string) {
  await f.message(gateway, f.sockets[0]!, 'connect.accepted', { connectionId })
}
async function readyLink(f: ReturnType<typeof fixture>, gateway: Gateway, connectionId: string) {
  await acceptLink(f, gateway, connectionId)
  await readyLinkAfterAccept(f, gateway, connectionId)
}
async function readyLinkAfterAccept(f: ReturnType<typeof fixture>, gateway: Gateway, connectionId: string) {
  await f.message(gateway, f.sockets[1]!, 'secure.handshake', { connectionId, targetDeviceId: HOST, step: 1, data: 'AAAA' })
  await f.message(gateway, f.sockets[0]!, 'secure.handshake', { connectionId, targetDeviceId: CLIENT, step: 2, data: 'AAAA' })
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ iceServers: [] })))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Gateway hibernation and replacement lifecycle', () => {
  it('restores authenticated peers before the first message or online-status RPC', async () => {
    const f = fixture()
    const gateway = f.wake()
    expect((await gateway.getDevice(HOST))?.online).toBe(true)
    await f.message(gateway, f.sockets[1]!, 'ping', { nonce: 'first-after-wake' })
    expect(f.sockets[1]!.frames.at(-1)).toMatchObject({ type: 'pong', payload: { nonce: 'first-after-wake' } })
    expect(f.sockets[1]!.closes).toEqual([])
  })

  it('restores pending/accepted links, signaling, TURN authorization and both handshake stages across wakes', async () => {
    const f = fixture()
    let gateway = f.wake()
    const id = await openLink(f, gateway)
    gateway = f.wake()
    await acceptLink(f, gateway, id)
    expect(f.sockets[1]!.frames.at(-1)?.type).toBe('connect.accepted')
    gateway = f.wake()
    expect(await gateway.authorizeTurn(CLIENT, id)).toBe(true)
    await f.message(gateway, f.sockets[1]!, 'signal.offer', { connectionId: id, targetDeviceId: HOST, sdp: 'offer' })
    expect(f.sockets[0]!.frames.at(-1)?.type).toBe('signal.offer')
    await f.message(gateway, f.sockets[1]!, 'secure.handshake', { connectionId: id, targetDeviceId: HOST, step: 1, data: 'AAAA' })
    gateway = f.wake()
    await f.message(gateway, f.sockets[0]!, 'secure.handshake', { connectionId: id, targetDeviceId: CLIENT, step: 2, data: 'AAAA' })
    expect(f.sockets[1]!.frames.at(-1)?.type).toBe('secure.handshake')
    expect(await gateway.authorizeTurn(CLIENT, id)).toBe(false)
  })

  it('prefetches both peer credentials concurrently without blocking acceptance, then reuses the host result', async () => {
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const fetcher = vi.fn(async () => { await pending; return Response.json({ iceServers: [{ urls: 'turn:synthetic.example', credential: 'test-only' }] }) })
    vi.stubGlobal('fetch', fetcher)
    const f = fixture(), gateway = f.wake(), id = await openLink(f, gateway)
    await acceptLink(f, gateway, id)
    expect(f.sockets[1]!.frames.at(-1)?.type).toBe('connect.accepted')
    expect(fetcher).toHaveBeenCalledTimes(2)
    const clientResult = gateway.getIceServers('test', id)
    await f.message(gateway, f.sockets[1]!, 'ping', { nonce: 'while-minting' })
    expect(f.sockets[1]!.frames.at(-1)?.type).toBe('pong')
    finish()
    expect(await clientResult).toMatchObject({ ok: true, value: [{ credential: 'test-only' }] })
    f.storage.token!.device_id = HOST
    expect(await gateway.getIceServers('host-test', id)).toMatchObject({ ok: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
    const saved = JSON.stringify(f.sockets.map(socket => socket.deserializeAttachment()))
    expect(saved).not.toContain('test-only')
    expect(saved).not.toContain('synthetic.example')
  })

  it('rechecks token, revocation and link lifecycle after credential issuance yields', async () => {
    const cases = ['revoked', 'token-expired', 'token-rotated', 'closed', 'ready', 'deadline', 'replacement'] as const
    for (const scenario of cases) {
      let finish!: () => void
      const pending = new Promise<void>(resolve => { finish = resolve })
      vi.stubGlobal('fetch', vi.fn(async () => { await pending; return Response.json({ iceServers: [{ urls: 'turn:synthetic.example' }] }) }))
      const f = fixture(), gateway = f.wake(), id = await openLink(f, gateway)
      await acceptLink(f, gateway, id)
      const cache = (gateway as unknown as { turnCredentials: { get: (id: string) => Promise<unknown> } }).turnCredentials
      const lookup = vi.spyOn(cache, 'get')
      const result = gateway.getIceServers('test', id)
      // The RPC must have passed its first auth check and joined the pending mint.
      await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1))
      if (scenario === 'revoked') await gateway.revokeDevice(CLIENT)
      if (scenario === 'token-expired') f.storage.token!.expires_at = Date.now() - 1
      if (scenario === 'token-rotated') f.storage.token = null
      if (scenario === 'closed') f.sockets[0]!.readyState = Socket.CLOSED
      if (scenario === 'ready') await readyLinkAfterAccept(f, gateway, id)
      if (scenario === 'deadline') {
        const links = (gateway as unknown as { links: Map<string, { created: number }> }).links
        links.get(id)!.created = Date.now() - 30_001
      }
      if (scenario === 'replacement') await openLink(f, gateway)
      finish()
      expect(await result, scenario).toMatchObject({ ok: false })
      await Promise.all(f.tasks)
    }
  })

  it('keeps fused peer authorization and presence fresh without dropping key or role checks', async () => {
    const f = fixture(), gateway = f.wake()
    expect(await gateway.getAuthorizedPeer('test', HOST)).toMatchObject({ ok: true, value: { deviceId: HOST, online: true, identityKey: 'a'.repeat(42) + 'A' } })
    expect(await gateway.getAuthorizedPeer('test', CLIENT_B)).toMatchObject({ ok: false, code: 'MEMBERSHIP_REQUIRED' })
    expect(await gateway.getAuthorizedPeer('test', 'unknown')).toMatchObject({ ok: false, code: 'DEVICE_NOT_FOUND' })
    f.storage.devices.get(CLIENT)!.revoked = 1
    expect(await gateway.getAuthorizedPeer('test', HOST)).toMatchObject({ ok: false, code: 'DEVICE_REVOKED' })
  })

  it('preserves Relay replay counters across a wake and never forwards a replay', async () => {
    const f = fixture()
    let gateway = f.wake()
    const id = await openLink(f, gateway)
    await readyLink(f, gateway, id)
    const payload = { connectionId: id, targetDeviceId: HOST, counter: 7, ciphertext: 'AAAA' }
    await f.message(gateway, f.sockets[1]!, 'relay', payload)
    const count = f.sockets[0]!.frames.filter(frame => frame.type === 'relay').length
    expect(count).toBe(1)
    gateway = f.wake()
    await f.message(gateway, f.sockets[1]!, 'relay', payload)
    expect(f.sockets[0]!.frames.filter(frame => frame.type === 'relay')).toHaveLength(count)
    expect(f.sockets[1]!.frames.at(-1)).toMatchObject({ type: 'error', payload: { code: 'INVALID_MESSAGE', connectionId: id } })
    gateway = f.wake()
    await f.message(gateway, f.sockets[1]!, 'relay', { ...payload, counter: 8 })
    expect(f.sockets[1]!.frames.at(-1)?.payload.code).toBe('CONNECTION_NOT_FOUND')
  })

  it('ignores a delayed error from a replaced socket instead of closing its successor', async () => {
    const old = peer(CLIENT, 'client', { state: 'closing' })
    const f = fixture([peer(HOST, 'host'), peer(CLIENT, 'client'), old])
    const gateway = f.wake()
    await gateway.alarm()
    const id = await openLink(f, gateway)
    await acceptLink(f, gateway, id)
    await gateway.webSocketError(old as unknown as WebSocket)
    expect(f.sockets[1]!.closes).toEqual([])
    expect(await gateway.authorizeTurn(CLIENT, id)).toBe(true)
  })

  it('closes only the predecessor with 4003 for identity takeover, independent of socket age', async () => {
    const old = peer(CLIENT, 'client')
    const replacement = new Socket({ state: 'awaiting_hello', helloDeadline: Date.now() + 5000 })
    const f = fixture([peer(HOST, 'host'), old, replacement])
    const gateway = f.wake()
    await gateway.alarm()
    await f.message(gateway, replacement, 'hello', { deviceId: CLIENT, role: 'client', accessToken: 'test',
      protocols: [1], capabilities: CAPS, clientVersion: '1.0.11' })
    expect(replacement.frames.at(-1), 'replacement hello must authenticate').toMatchObject({ type: 'hello.ack' })
    expect(old.closes).toEqual([{ code: 4003, reason: 'CONNECTION_REPLACED' }])
    expect(replacement.closes).toEqual([])
    expect(replacement.frames.at(-1)?.type).toBe('hello.ack')
    await gateway.webSocketError(old as unknown as WebSocket)
    expect(replacement.closes).toEqual([])
  })

  it('does not let new connections postpone an earlier heartbeat alarm', async () => {
    vi.useFakeTimers()
    const pending = new Socket({ state: 'awaiting_hello', helloDeadline: Date.now() + 5000 })
    const f = fixture([peer(HOST, 'host'), pending])
    await f.storage.setAlarm(Date.now() + 1000)
    const gateway = f.wake()
    await f.message(gateway, pending, 'hello', { deviceId: CLIENT, role: 'client', accessToken: 'test',
      protocols: [1], capabilities: CAPS })
    await (gateway as unknown as { alarmScheduling: Promise<void> }).alarmScheduling
    expect(f.alarm()).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('restores link ownership when a close event itself wakes the object', async () => {
    const f = fixture()
    let gateway = f.wake()
    const id = await openLink(f, gateway)
    await readyLink(f, gateway, id)
    f.sockets[0]!.readyState = Socket.CLOSED
    gateway = f.wake()
    await gateway.webSocketClose(f.sockets[0]! as unknown as WebSocket, 1006, '')
    expect(f.sockets[1]!.frames.at(-1)).toMatchObject({ type: 'error', payload: { code: 'CONNECTION_FAILED', connectionId: id } })
    expect(f.sockets[1]!.deserializeAttachment().link).toBeUndefined()
  })

  it('preserves the ICE budget and pending-link expiry after wake', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let gateway = f.wake()
    const id = await openLink(f, gateway)
    await acceptLink(f, gateway, id)
    for (let i = 0; i < 256; i++) {
      await f.message(gateway, f.sockets[1]!, 'signal.ice', { connectionId: id, targetDeviceId: HOST, candidate: { candidate: `ice-${i}` } })
    }
    gateway = f.wake()
    await f.message(gateway, f.sockets[1]!, 'signal.ice', { connectionId: id, targetDeviceId: HOST, candidate: { candidate: 'one-too-many' } })
    expect(f.sockets[1]!.frames.at(-1)?.payload.code).toBe('INVALID_MESSAGE')
    const nextId = await openLink(f, gateway)
    vi.setSystemTime(Date.now() + 30_001)
    await f.wake().alarm()
    expect(f.sockets[1]!.frames.at(-1)).toMatchObject({ type: 'error', payload: { connectionId: nextId, code: 'CONNECTION_FAILED' } })
    expect(f.sockets[1]!.deserializeAttachment().link).toBeUndefined()
  })

  it('continues heartbeats during connection churn instead of timing out a healthy host', async () => {
    vi.useFakeTimers()
    const f = fixture([peer(HOST, 'host', { nextPingAt: Date.now() + 25_000 })])
    let gateway = f.wake()
    await gateway.alarm()
    for (let i = 0; i < 20; i++) {
      vi.setSystemTime(Date.now() + 5000)
      f.sockets.push(new Socket({ state: 'awaiting_hello', helloDeadline: Date.now() + 5000 }))
      gateway = f.wake()
      await gateway.alarm()
      const last = f.sockets[0]!.frames.at(-1)
      if (last?.type === 'ping') await f.message(gateway, f.sockets[0]!, 'pong', { nonce: last.payload.nonce })
      expect(f.sockets[0]!.closes).toEqual([])
    }
    expect(f.sockets[0]!.frames.filter(frame => frame.type === 'ping')).toHaveLength(4)
  })

  it('expires unauthenticated sockets instead of leaking the connection quota', async () => {
    const pending = new Socket({ state: 'awaiting_hello', helloDeadline: Date.now() - 1 })
    const f = fixture([pending])
    await f.wake().alarm()
    expect(pending.closes).toHaveLength(1)
    expect(pending.closes[0]!.code).toBe(4001)
    expect(pending.deserializeAttachment().state).not.toBe('awaiting_hello')
  })
})
