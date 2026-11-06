/**
 * The Gateway Durable Object: one instance holds every WebSocket for the account.
 *
 * Single-account means peers and links are ordinary in-memory maps — the same
 * shape as the reference implementation's single process. Per-connection state
 * that must survive hibernation goes in `serializeAttachment`, because the
 * constructor runs again after the object is evicted.
 *
 * Frames are only ever interpreted in `awaiting_hello` or `authenticated`;
 * `closing` exists so a hello that loses the race against the handshake deadline
 * can never authenticate or replace a healthy socket.
 */
import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env.js'
import { resolveTiming, resolveTurn, type TimingConfig, type TurnConfig } from './config.js'
import { Store, StoreError } from './store.js'
import { err, fromThrown, ok, type Result } from './result.js'
import { sha256Hex, randomToken } from './crypto.js'
import {
  FRAME_BUDGET, MAX_CONTROL_FRAME_BYTES, MAX_ICE_CANDIDATES_PER_CONNECTION, MAX_RELAY_FRAME_BYTES,
  SERVER_SHUTDOWN_CLOSE_CODE, SERVER_SHUTDOWN_CLOSE_REASON, TRANSPORT_NAMES,
  capabilityFor, createControlFrame, decodeControlFrame, encodeFrame, modernHost,
  parseConnectRequest, parseHello, parsePingPong, parseRelay, parseSecureHandshake,
  parseTarget, parseTransportSelected, ProtocolError, type ControlFrame, type TransportName,
} from './protocol.js'

type ConnectionState = 'awaiting_hello' | 'authenticated' | 'closing' | 'closed'

/** Per-socket state, persisted through hibernation. Must stay under 16 KB. */
interface Attachment {
  state: ConnectionState
  deviceId?: string
  role?: 'host' | 'client'
  capabilities?: string[]
  version?: string
  lastPong?: number
  nonce?: string | undefined
  /** Frame budget window, reset per second. */
  windowStart?: number
  frames?: number
  bytes?: number
}

interface Link {
  id: string
  host: string
  client: string
  stage: 'pending' | 'accepted' | 'handshake' | 'ready'
  created: number
  /** Highest relay counter seen from each side, to reject replay/rewind. */
  counters: Map<string, number>
  preferredTransports: TransportName[]
  iceCandidates: number
}

const WEBRTC_FALLBACK_TIMEOUT_MS = 12_000
const MAX_PEERS = 512
const MAX_LINKS = 512
/** Drop a slow consumer past this much in flight, mirroring `bufferedAmount > 4 MiB`. */
const MAX_BUFFERED_BYTES = 4 * MAX_RELAY_FRAME_BYTES
const LINK_PENDING_TIMEOUT_MS = 30_000
const SERVER_VERSION = 'cf/0.1.0'

export class Gateway extends DurableObject<Env> {
  private readonly timing: TimingConfig
  private readonly turn: TurnConfig | null
  private readonly store: Store

  /** deviceId -> socket. In memory; rebuilt from attachments after a restart. */
  private readonly peers = new Map<string, WebSocket>()
  private readonly links = new Map<string, Link>()
  /** Bytes queued but not yet flushed per socket, standing in for `bufferedAmount`. */
  private readonly pending = new WeakMap<WebSocket, number>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.timing = resolveTiming(env)
    this.turn = resolveTurn(env)
    // The schema statements run once per object instance. The DO is a singleton,
    // so this happens once per cold start, not per request — re-running them on
    // every access was a needless source of SQLite lock contention.
    this.store = new Store(ctx.storage)
  }

  // -------------------------------------------------------------------------
  // WebSocket entry
  // -------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 })
    }
    if (this.ctx.getWebSockets().length >= MAX_PEERS) {
      return new Response('Too many connections', { status: 503 })
    }

    const pair = new WebSocketPair()
    // Both ends always exist; the index access needs the assertion because
    // noUncheckedIndexedAccess treats every array read as possibly undefined.
    const client = pair[0] as unknown as WebSocket
    const server = pair[1] as unknown as WebSocket

    // Hibernation API: the DO may be evicted while sockets stay connected, so all
    // per-connection state lives in the attachment.
    this.ctx.acceptWebSocket(server)
    const now = Date.now()
    server.serializeAttachment({
      state: 'awaiting_hello', windowStart: now, frames: 0, bytes: 0,
    } satisfies Attachment)

    // The hello deadline is enforced by an alarm rather than setTimeout: timers
    // block hibernation and do not survive eviction. Not awaited — a storage hiccup
    // must not fail the upgrade.
    void this.scheduleAlarm()

    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = (ws.deserializeAttachment() ?? { state: 'awaiting_hello' }) as Attachment
    if (attachment.state === 'closing' || attachment.state === 'closed') return
    if (typeof raw !== 'string') {
      // The protocol is text-only; a binary frame is a peer bug or an attack.
      this.fail(ws, 'INVALID_MESSAGE')
      return
    }
    if (raw.length > MAX_RELAY_FRAME_BYTES) {
      this.fail(ws, 'FRAME_TOO_LARGE')
      return
    }

    // Frame budget: cheap DoS guard, per connection.
    const now = Date.now()
    if (now - (attachment.windowStart ?? 0) >= FRAME_BUDGET.windowMs) {
      attachment.windowStart = now
      attachment.frames = 0
      attachment.bytes = 0
    }
    attachment.frames = (attachment.frames ?? 0) + 1
    attachment.bytes = (attachment.bytes ?? 0) + raw.length
    if (attachment.frames > FRAME_BUDGET.frames || attachment.bytes > FRAME_BUDGET.bytes) {
      this.fail(ws, 'RATE_LIMITED')
      return
    }

    let frame: ControlFrame
    try {
      frame = decodeControlFrame(raw)
    } catch (error) {
      this.fail(ws, error instanceof ProtocolError ? error.code : 'INVALID_MESSAGE')
      return
    }

    if (attachment.state === 'awaiting_hello') {
      await this.handleHello(ws, attachment, frame)
      return
    }

    // Authenticated. Re-validate that this socket is still the registered peer:
    // a replaced connection must not keep acting on the old identity.
    const peer = attachment.deviceId === undefined ? undefined : this.peers.get(attachment.deviceId)
    if (attachment.deviceId === undefined || peer !== ws) {
      this.fail(ws, 'AUTH_INVALID')
      return
    }
    const device = this.store.getDevice(attachment.deviceId)
    if (device === null || device.revoked !== 0) {
      this.fail(ws, 'AUTH_INVALID')
      return
    }

    try {
      this.handleAuthenticated(ws, attachment as Required<Pick<Attachment, 'deviceId' | 'role' | 'capabilities' | 'version'>> & Attachment, frame)
    } catch (error) {
      const code = error instanceof ProtocolError || error instanceof StoreError ? error.code : 'INVALID_MESSAGE'
      this.failLinkOrPeer(ws, attachment, frame, code)
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = (ws.deserializeAttachment() ?? {}) as Attachment
    if (attachment.deviceId !== undefined && this.peers.get(attachment.deviceId) === ws) {
      this.dropPeer(attachment.deviceId, 'CONNECTION_FAILED')
    }
    // The runtime completes the close handshake on its own (compat date >= 2026-04-07).
    void code
    void reason
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const attachment = (ws.deserializeAttachment() ?? {}) as Attachment
    if (attachment.deviceId !== undefined) this.dropPeer(attachment.deviceId, 'CONNECTION_FAILED')
    else this.fail(ws, 'CONNECTION_FAILED')
  }

  // -------------------------------------------------------------------------
  // hello
  // -------------------------------------------------------------------------

  private async handleHello(ws: WebSocket, attachment: Attachment, frame: ControlFrame): Promise<void> {
    if (frame.type !== 'hello') {
      this.fail(ws, 'AUTH_REQUIRED')
      return
    }
    let hello
    try {
      hello = parseHello(frame.payload)
    } catch {
      this.fail(ws, 'INVALID_MESSAGE')
      return
    }
    if (!hello.protocols.includes(1)) {
      this.fail(ws, 'UNSUPPORTED_VERSION')
      return
    }

    // Authenticate the access token. The digest is SHA-256 over the raw token,
    // matching the reference implementation.
    const digest = await sha256Hex(hello.accessToken)
    const token = this.store.findToken(digest)
    if (token === null || token.kind !== 'access') { this.fail(ws, 'AUTH_INVALID'); return }
    if (token.expires_at <= Date.now()) { this.fail(ws, 'TOKEN_EXPIRED'); return }
    if (token.device_id !== hello.deviceId) { this.fail(ws, 'AUTH_INVALID'); return }

    const device = this.store.getDevice(hello.deviceId)
    if (device === null) { this.fail(ws, 'AUTH_INVALID'); return }
    if (device.revoked !== 0) { this.fail(ws, 'DEVICE_REVOKED'); return }
    if (device.role !== hello.role) { this.fail(ws, 'AUTH_INVALID'); return }

    // The hello may have raced the deadline; if the state moved on, drop it.
    if (attachment.state !== 'awaiting_hello') return

    // Replace an existing connection for this device.
    const previous = this.peers.get(hello.deviceId)
    if (previous !== undefined && previous !== ws) this.disconnect(hello.deviceId, 'CONNECTION_REPLACED')

    attachment.state = 'authenticated'
    attachment.deviceId = hello.deviceId
    attachment.role = hello.role
    attachment.capabilities = this.negotiatedCapabilities(hello.capabilities)
    attachment.version = hello.clientVersion ?? device.client_version
    attachment.lastPong = Date.now()
    ws.serializeAttachment(attachment)

    this.peers.set(hello.deviceId, ws)
    this.store.touchDevice(hello.deviceId, hello.clientVersion, hello.harnessVersion)

    this.send(ws, createControlFrame('hello.ack', {
      protocol: 1,
      serverVersion: SERVER_VERSION,
      connectionSessionId: crypto.randomUUID(),
      heartbeatIntervalMs: this.timing.heartbeatIntervalMs,
      maxControlFrameBytes: MAX_CONTROL_FRAME_BYTES,
      maxRelayFrameBytes: MAX_RELAY_FRAME_BYTES,
      capabilities: attachment.capabilities,
      webrtcEnabled: true,
      webrtcFallbackTimeoutMs: WEBRTC_FALLBACK_TIMEOUT_MS,
    }))

    void this.scheduleAlarm()
  }

  private negotiatedCapabilities(offered: readonly string[]): string[] {
    if (!this.turnEnabled) return offered.filter(capability => capability !== 'transport.turn')
    return [...offered]
  }

  private get turnEnabled(): boolean { return this.turn !== null }

  // -------------------------------------------------------------------------
  // authenticated frames
  // -------------------------------------------------------------------------

  private handleAuthenticated(
    ws: WebSocket,
    attachment: Attachment & { deviceId: string; role: 'host' | 'client'; capabilities: string[]; version: string },
    frame: ControlFrame,
  ): void {
    if (frame.type === 'hello') throw new ProtocolError('INVALID_MESSAGE')

    if (frame.type === 'ping') {
      const { nonce } = parsePingPong(frame.payload)
      this.send(ws, createControlFrame('pong', { nonce }))
      return
    }
    if (frame.type === 'pong') {
      const { nonce } = parsePingPong(frame.payload)
      if (attachment.nonce !== undefined && nonce === attachment.nonce) {
        attachment.lastPong = Date.now()
        attachment.nonce = undefined
        ws.serializeAttachment(attachment)
      }
      return
    }

    if (frame.type === 'connect.request') { this.handleConnectRequest(ws, attachment, frame); return }

    // `connect.accepted` / `connect.rejected` answer a specific connection and carry
    // only `connectionId` — unlike every other link frame they have no
    // `targetDeviceId`, because the recipient is implied by who was asked. Handling
    // them before `parseTarget` is required, not a shortcut.
    if (frame.type === 'connect.accepted' || frame.type === 'connect.rejected') {
      this.handleConnectAnswer(attachment, frame)
      return
    }

    // Everything below is scoped to one existing link.
    const target = parseTarget(frame.payload)
    const link = this.links.get(target.connectionId)
    if (link === undefined) throw new ProtocolError('CONNECTION_NOT_FOUND')
    if (attachment.deviceId !== link.host && attachment.deviceId !== link.client) {
      throw new ProtocolError('CONNECTION_NOT_FOUND')
    }
    const otherId = attachment.deviceId === link.host ? link.client : link.host
    const other = this.peers.get(otherId)
    if (other === undefined) throw new ProtocolError('CONNECTION_FAILED')
    if (target.targetDeviceId !== otherId) throw new ProtocolError('INVALID_MESSAGE')

    if (link.stage === 'pending') throw new ProtocolError('CONNECTION_NOT_FOUND')

    if (frame.type === 'signal.offer' || frame.type === 'signal.answer' || frame.type === 'signal.ice') {
      this.forwardSignal(link, attachment, other, frame)
      return
    }
    if (frame.type === 'transport.selected') {
      parseTransportSelected(frame.payload)
      this.send(other, frame)
      return
    }
    if (frame.type === 'secure.handshake') {
      const { step } = parseSecureHandshake(frame.payload)
      if (step === 1 && attachment.deviceId === link.client && link.stage === 'accepted') link.stage = 'handshake'
      else if (step === 2 && attachment.deviceId === link.host && link.stage === 'handshake') link.stage = 'ready'
      else throw new ProtocolError('INVALID_MESSAGE')
      this.send(other, frame)
      return
    }
    if (frame.type === 'relay') {
      const { counter } = parseRelay(frame.payload)
      if (link.stage !== 'ready') throw new ProtocolError('INVALID_MESSAGE')
      const last = link.counters.get(attachment.deviceId) ?? -1
      // Reject a rewound or replayed counter: the clients rely on this ordering.
      if (counter <= last) throw new ProtocolError('INVALID_MESSAGE')
      link.counters.set(attachment.deviceId, counter)
      this.send(other, frame)
      return
    }
    if (frame.type === 'connection.lease.request' || frame.type === 'connection.lease.ack' || frame.type === 'connection.lease.close') {
      this.send(other, frame)
      return
    }
    throw new ProtocolError('INVALID_MESSAGE')
  }

  /**
   * Host's answer to a connect.request.
   *
   * Only the host may answer, and only while the link is still pending — otherwise
   * a client could accept its own request, or a stale answer could revive a link the
   * server already dropped.
   */
  private handleConnectAnswer(
    attachment: Attachment & { deviceId: string; role: 'host' | 'client' },
    frame: ControlFrame,
  ): void {
    const connectionId = frame.payload.connectionId
    if (typeof connectionId !== 'string' || connectionId === '') throw new ProtocolError('INVALID_MESSAGE')
    const link = this.links.get(connectionId)
    if (link === undefined) throw new ProtocolError('CONNECTION_NOT_FOUND')
    if (attachment.deviceId !== link.host) throw new ProtocolError('INVALID_MESSAGE')
    if (link.stage !== 'pending') throw new ProtocolError('INVALID_MESSAGE')

    const clientSocket = this.peers.get(link.client)
    if (frame.type === 'connect.rejected') {
      this.links.delete(link.id)
      if (clientSocket !== undefined) this.send(clientSocket, frame)
      return
    }
    link.stage = 'accepted'
    if (clientSocket !== undefined) this.send(clientSocket, frame)
  }

  private handleConnectRequest(
    ws: WebSocket,
    attachment: Attachment & { deviceId: string; role: 'host' | 'client'; capabilities: string[]; version: string },
    frame: ControlFrame,
  ): void {
    if (attachment.role !== 'client') throw new ProtocolError('MEMBERSHIP_REQUIRED')
    const request = parseConnectRequest(frame.payload)

    const hostSocket = this.peers.get(request.hostDeviceId)
    const hostDevice = this.store.getDevice(request.hostDeviceId)
    if (hostSocket === undefined || hostDevice === null || hostDevice.role !== 'host' || hostDevice.revoked !== 0) {
      this.send(ws, createControlFrame('error', { code: 'HOST_OFFLINE', message: 'Host is offline.', retryable: true }))
      return
    }
    const hostAttachment = (hostSocket.deserializeAttachment() ?? {}) as Attachment
    const hostCapabilities = hostAttachment.capabilities ?? []

    // Relay is the floor: without it there is no data path at all.
    if (!request.preferredTransports.includes('relay')
      || !attachment.capabilities.includes(capabilityFor('relay'))
      || !hostCapabilities.includes(capabilityFor('relay'))) {
      throw new ProtocolError('CAPABILITY_NOT_SUPPORTED')
    }

    // Coordinate only transports both peers actually advertised, so a Host never
    // sees a transport the server did not offer it.
    const preferredTransports = request.preferredTransports.filter(transport =>
      attachment.capabilities.includes(capabilityFor(transport))
      && hostCapabilities.includes(capabilityFor(transport)))
    if (preferredTransports.length === 0) throw new ProtocolError('CAPABILITY_NOT_SUPPORTED')

    // One link per client, and for older hosts one per host too.
    const hostVersion = hostAttachment.version ?? hostDevice.client_version
    for (const old of [...this.links.values()]) {
      if (old.client === attachment.deviceId || (old.host === request.hostDeviceId && !modernHost(hostVersion))) {
        this.dropLink(old, 'CONNECTION_REPLACED')
      }
    }
    if (this.links.size >= MAX_LINKS) throw new ProtocolError('RATE_LIMITED')

    const link: Link = {
      id: crypto.randomUUID(),
      host: request.hostDeviceId,
      client: attachment.deviceId,
      stage: 'pending',
      created: Date.now(),
      counters: new Map(),
      preferredTransports,
      iceCandidates: 0,
    }
    this.links.set(link.id, link)

    this.send(hostSocket, createControlFrame('connect.incoming', {
      connectionId: link.id,
      clientDeviceId: attachment.deviceId,
      clientIdentityKey: this.store.getDevice(attachment.deviceId)?.identity_key,
      authorization: 'account',
      preferredTransports: link.preferredTransports,
    }))
  }

  /**
   * Forward WebRTC signaling only while the link is still being established and
   * only for a negotiated non-relay transport. A relay-only link has no data plane
   * to coordinate, and a Host treats unsolicited signaling as a protocol
   * violation, so such frames are dropped for the client to time out and fall back.
   */
  private forwardSignal(
    link: Link, sender: Attachment & { deviceId: string }, other: WebSocket, frame: ControlFrame,
  ): void {
    if (link.stage === 'ready') return
    if (!link.preferredTransports.some(transport => transport !== 'relay')) return

    if (frame.type === 'signal.offer') {
      if (sender.deviceId !== link.client) throw new ProtocolError('INVALID_MESSAGE')
    } else if (frame.type === 'signal.answer') {
      if (sender.deviceId !== link.host) throw new ProtocolError('INVALID_MESSAGE')
    } else {
      if (++link.iceCandidates > MAX_ICE_CANDIDATES_PER_CONNECTION) throw new ProtocolError('INVALID_MESSAGE')
    }
    this.send(other, frame)
  }

  // -------------------------------------------------------------------------
  // alarms: heartbeat + link cleanup. One chain drives everything.
  // -------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    const now = Date.now()
    const { heartbeatDisconnectMs, heartbeatIntervalMs } = this.timing
    // Nothing in this method may touch SQLite. The alarm and an in-flight request
    // would otherwise contend for the same database handle, and a busy timeout
    // during a login is an outage.

    // Rebuild the peer map from attachments. After eviction the maps are empty but
    // the sockets are alive, so this is how the object finds them again.
    this.peers.clear()
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = (socket.deserializeAttachment() ?? {}) as Attachment
      if (attachment.state === 'authenticated' && attachment.deviceId !== undefined) {
        this.peers.set(attachment.deviceId, socket)
      }
    }

    for (const [deviceId, socket] of this.peers) {
      const attachment = (socket.deserializeAttachment() ?? {}) as Attachment
      const lastPong = attachment.lastPong ?? 0
      if (now - lastPong > heartbeatDisconnectMs) {
        this.dropPeer(deviceId, 'CONNECTION_FAILED')
        continue
      }
      attachment.nonce = crypto.randomUUID()
      socket.serializeAttachment(attachment)
      this.send(socket, createControlFrame('ping', { nonce: attachment.nonce }))
    }

    for (const link of [...this.links.values()]) {
      if (link.stage !== 'ready' && now - link.created > LINK_PENDING_TIMEOUT_MS) {
        this.dropLink(link, 'CONNECTION_FAILED')
      }
    }

    await this.scheduleAlarm(now + heartbeatIntervalMs)
  }

  /**
   * Keep exactly one alarm pending.
   *
   * `setAlarm` replaces any existing alarm, so there is no need to read first — and
   * reading added an extra storage round trip that could fail independently. The
   * returned promise is deliberately not awaited by the callers that fire it from
   * the request path: a login must not fail because the heartbeat could not be
   * rescheduled.
   */
  private async scheduleAlarm(at?: number): Promise<void> {
    const target = at ?? Date.now() + this.timing.heartbeatIntervalMs
    try {
      await this.ctx.storage.setAlarm(target)
    } catch {
      // A failed reschedule is not fatal: the next event retries.
    }
  }

  // -------------------------------------------------------------------------
  // teardown helpers
  // -------------------------------------------------------------------------

  private dropPeer(deviceId: string, code: string): void {
    const socket = this.peers.get(deviceId)
    this.peers.delete(deviceId)
    for (const link of [...this.links.values()]) {
      if (link.host === deviceId || link.client === deviceId) this.dropLink(link, code)
    }
    if (socket !== undefined) this.closeQuietly(socket, code)
  }

  private disconnect(deviceId: string, code: string): void { this.dropPeer(deviceId, code) }

  private dropLink(link: Link, code: string): void {
    this.links.delete(link.id)
    for (const id of [link.host, link.client]) {
      const socket = this.peers.get(id)
      if (socket === undefined) continue
      const attachment = (socket.deserializeAttachment() ?? {}) as Attachment
      // Old hosts predate the connection-scoped error frame; only send it to
      // clients and modern hosts.
      if (attachment.role === 'client' || modernHost(attachment.version ?? '')) {
        this.send(socket, createControlFrame('error', { code, message: code, connectionId: link.id, retryable: true }))
      }
    }
  }

  private fail(ws: WebSocket, code: string): void {
    this.closeQuietly(ws, code, createControlFrame('error', { code, message: code, retryable: false }))
  }

  /**
   * A connection-scoped failure must not take down the host's other clients: if
   * the frame names a link this peer participates in, drop just that link.
   */
  private failLinkOrPeer(ws: WebSocket, attachment: Attachment, frame: ControlFrame, code: string): void {
    const connectionId = (frame.payload as { connectionId?: unknown }).connectionId
    if (typeof connectionId === 'string' && code !== 'RATE_LIMITED') {
      const link = this.links.get(connectionId)
      if (link !== undefined && (link.host === attachment.deviceId || link.client === attachment.deviceId)) {
        this.dropLink(link, code)
        return
      }
      this.send(ws, createControlFrame('error', { code, message: code, connectionId, retryable: false }))
      return
    }
    this.fail(ws, code)
  }

  private closeQuietly(ws: WebSocket, code: string, frame?: ControlFrame): void {
    try {
      if (frame !== undefined) this.send(ws, frame)
      ws.close(SERVER_SHUTDOWN_CLOSE_CODE, SERVER_SHUTDOWN_CLOSE_REASON)
    } catch {
      // Already closing; the runtime reaps it.
    }
    void code
  }

  /** Send with a bounded in-flight budget, standing in for `bufferedAmount`. */
  private send(ws: WebSocket, frame: ControlFrame): void {
    if (ws.readyState !== WebSocket.OPEN) return
    const payload = encodeFrame(frame)
    const queued = this.pending.get(ws) ?? 0
    if (queued + payload.length > MAX_BUFFERED_BYTES) {
      const attachment = (ws.deserializeAttachment() ?? {}) as Attachment
      if (attachment.deviceId !== undefined) this.dropPeer(attachment.deviceId, 'SLOW_CONSUMER')
      return
    }
    try {
      ws.send(payload)
      this.pending.set(ws, queued + payload.length)
      // Reset once the write is observed as flushed. Workers has no completion
      // callback per send, so the budget decays on a short timer instead.
      setTimeout(() => {
        const remaining = Math.max(0, (this.pending.get(ws) ?? payload.length) - payload.length)
        this.pending.set(ws, remaining)
      }, 100)
    } catch {
      const attachment = (ws.deserializeAttachment() ?? {}) as Attachment
      if (attachment.deviceId !== undefined) this.dropPeer(attachment.deviceId, 'CONNECTION_FAILED')
    }
  }

  // -------------------------------------------------------------------------
  // RPC surface for the Worker (HTTP API lives outside, state lives here)
  // -------------------------------------------------------------------------

  /** Register a device and issue its first credential pair. */
  async registerDevice(input: {
    deviceId: string; role: 'host' | 'client'; name: string; platform: string
    identityKey: string; clientVersion: string; harnessVersion?: string
  }): Promise<Result<{ accessToken: string; refreshToken: string; accessTokenExpiresAt: number; refreshTokenExpiresAt: number }>> {
    try {
      this.store.purgeExpiredTokens()
      const { created } = this.store.upsertDevice({
        device_id: input.deviceId,
        role: input.role,
        name: input.name,
        platform: input.platform,
        identity_key: input.identityKey,
        client_version: input.clientVersion,
        harness_version: input.harnessVersion ?? null,
      })
      // Re-registering a device invalidates its old tokens, so a revoked credential
      // cannot be resurrected by re-registering.
      this.store.deleteTokensFor(input.deviceId)
      if (created) this.store.touchDevice(input.deviceId)
      return ok(await this.issueTokens(input.deviceId))
    } catch (error) { return fromThrown(error) }
  }

  /** Issue a fresh token pair, computing digests off the synchronous SQL path. */
  async issueTokens(deviceId: string): Promise<{
    accessToken: string; refreshToken: string; accessTokenExpiresAt: number; refreshTokenExpiresAt: number
  }> {
    const { LIMITS } = await import('./store.js')
    this.store.purgeExpiredTokens()
    if (this.store.countTokens() >= LIMITS.tokens) throw new StoreError('RATE_LIMITED', 429)
    const accessToken = randomToken()
    const refreshToken = randomToken()
    const accessTokenExpiresAt = Date.now() + LIMITS.accessTokenMs
    const refreshTokenExpiresAt = Date.now() + LIMITS.refreshTokenMs
    this.store.insertToken(await sha256Hex(accessToken), deviceId, 'access', accessTokenExpiresAt)
    this.store.insertToken(await sha256Hex(refreshToken), deviceId, 'refresh', refreshTokenExpiresAt)
    return { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt }
  }

  /** Rotate a refresh token, detecting reuse. */
  async refreshToken(deviceId: string, refreshToken: string): Promise<Result<{
    accessToken: string; refreshToken: string; accessTokenExpiresAt: number; refreshTokenExpiresAt: number
  }>> {
    try {
      const device = this.store.getDevice(deviceId)
      if (device === null) return err('DEVICE_NOT_FOUND', 404)
      if (device.revoked !== 0) return err('DEVICE_REVOKED', 403)
      const digest = await sha256Hex(refreshToken)
      const record = this.store.findToken(digest)
      if (record === null || record.kind !== 'refresh' || record.device_id !== deviceId) {
        return err('AUTH_INVALID', 401)
      }
      if (record.expires_at <= Date.now()) return err('TOKEN_EXPIRED', 401)
      if (record.used !== 0) {
        // A reused refresh token means the previous response was intercepted or
        // replayed. Revoke the whole device rather than hand out a new pair.
        this.store.revokeDevice(deviceId)
        this.dropPeer(deviceId, 'AUTH_INVALID')
        return err('AUTH_INVALID', 401)
      }
      this.store.markTokenUsed(digest)
      this.store.deleteTokensFor(deviceId)
      return ok(await this.issueTokens(deviceId))
    } catch (error) { return fromThrown(error) }
  }

  /** Validate a device access token; used by both the WS hello and the REST API. */
  async authenticateDevice(accessToken: string): Promise<Result<{
    deviceId: string; role: 'host' | 'client'; name: string; platform: string
    identityKey: string; clientVersion: string; harnessVersion: string | null
    revoked: boolean; lastSeenAt: number
  }>> {
    try {
      const digest = await sha256Hex(accessToken)
      const record = this.store.findToken(digest)
      if (record === null || record.kind !== 'access') return err('AUTH_INVALID', 401)
      if (record.expires_at <= Date.now()) return err('TOKEN_EXPIRED', 401)
      const device = this.store.getDevice(record.device_id)
      if (device === null) return err('DEVICE_NOT_FOUND', 404)
      if (device.revoked !== 0) return err('DEVICE_REVOKED', 403)
      return ok({
        deviceId: device.device_id, role: device.role, name: device.name, platform: device.platform,
        identityKey: device.identity_key, clientVersion: device.client_version,
        harnessVersion: device.harness_version, revoked: false, lastSeenAt: device.last_seen_at,
      })
    } catch (error) { return fromThrown(error) }
  }

  async listDevices(): Promise<Array<{
    deviceId: string; role: string; name: string; platform: string; clientVersion: string
    harnessVersion: string | null; lastSeenAt: number; online: boolean
  }>> {
    return this.store.listDevices().map(device => ({
      deviceId: device.device_id,
      role: device.role,
      name: device.name,
      platform: device.platform,
      clientVersion: device.client_version,
      harnessVersion: device.harness_version,
      lastSeenAt: device.last_seen_at,
      online: this.peers.has(device.device_id),
    }))
  }

  async getDevice(deviceId: string): Promise<{
    deviceId: string; role: string; name: string; platform: string; identityKey: string
    clientVersion: string; harnessVersion: string | null; lastSeenAt: number; online: boolean
  } | null> {
    const device = this.store.getDevice(deviceId)
    if (device === null || device.revoked !== 0) return null
    return {
      deviceId: device.device_id, role: device.role, name: device.name, platform: device.platform,
      identityKey: device.identity_key, clientVersion: device.client_version,
      harnessVersion: device.harness_version, lastSeenAt: device.last_seen_at,
      online: this.peers.has(device.device_id),
    }
  }

  async revokeDevice(deviceId: string): Promise<void> {
    this.store.revokeDevice(deviceId)
    this.dropPeer(deviceId, 'AUTH_INVALID')
  }

  async renameDevice(deviceId: string, name: string): Promise<void> {
    this.store.renameDevice(deviceId, name)
  }

  /** True while both ends of the link are connected, used to authorize TURN. */
  async authorizeTurn(deviceId: string, connectionId: string): Promise<boolean> {
    const link = this.links.get(connectionId)
    if (link === undefined) return false
    if (link.host !== deviceId && link.client !== deviceId) return false
    if (link.stage !== 'accepted' && link.stage !== 'handshake') return false
    return this.peers.has(link.host) && this.peers.has(link.client)
  }

  // --- lockout (kept here because SQLite is the only durable store) ---------

  async lockoutState(key: string, threshold: number, lockMs: number, streakMs: number): Promise<{
    locked: boolean; retryAfterMs: number
  }> {
    const now = Date.now()
    this.store.purgeExpiredLockouts(now, streakMs)
    const row = this.store.getLockout(key)
    if (row === null) return { locked: false, retryAfterMs: 0 }
    if (row.lockedUntil !== null) {
      return row.lockedUntil > now
        ? { locked: true, retryAfterMs: row.lockedUntil - now }
        : { locked: false, retryAfterMs: 0 }
    }
    // A streak older than the window is forgotten rather than resumed.
    if (now - row.firstFailureAt > streakMs) return { locked: false, retryAfterMs: 0 }
    void threshold
    void lockMs
    return { locked: false, retryAfterMs: 0 }
  }

  async recordFailure(
    key: string, threshold: number, lockMs: number, streakMs: number,
  ): Promise<{ locked: boolean; retryAfterMs: number }> {
    return this.store.recordFailure(key, Date.now(), threshold, lockMs, streakMs)
  }

  async clearFailures(key: string): Promise<void> { this.store.clearFailures(key) }
}
