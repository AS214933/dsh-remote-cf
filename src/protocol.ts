/**
 * Wire protocol for the DSH Remote server, ported for Cloudflare Workers.
 *
 * This mirrors `@dsh-remote/protocol` for the subset this server actually needs:
 * the control frames it routes and the limits it enforces. The source package
 * pulls in Zod for full validation; here the frames are hand-validated because
 * Workers CPU time is billed and the shapes are small and fixed.
 *
 * Frames the server only forwards (signal.*, transport.selected, secure.handshake,
 * relay) are validated for routing fields, not for payload semantics — the server
 * never interprets their contents.
 */

export const PROTOCOL_VERSION = 1 as const

/** Per-frame ceiling for control frames. */
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024
/** Per-frame ceiling for relay frames. Verified against Workers: 2 MiB passes. */
export const MAX_RELAY_FRAME_BYTES = 1024 * 1024

/** Frame budget per connection, mirroring the reference implementation. */
export const FRAME_BUDGET = { windowMs: 1000, frames: 512, bytes: 16 * MAX_RELAY_FRAME_BYTES } as const

export const MAX_ICE_CANDIDATES_PER_CONNECTION = 256

/** Close code the reference server uses when shutting a peer down. */
export const SERVER_SHUTDOWN_CLOSE_CODE = 4001
export const SERVER_SHUTDOWN_CLOSE_REASON = 'CONNECTION_FAILED'

/** Control frame types the server understands. */
export const CONTROL_FRAME_TYPES = [
  'hello', 'hello.ack', 'connect.request', 'connect.incoming',
  'connect.accepted', 'connect.rejected', 'secure.handshake', 'relay',
  'signal.offer', 'signal.answer', 'signal.ice', 'transport.selected',
  'connection.lease.request', 'connection.lease.ack', 'connection.lease.close',
  'ping', 'pong', 'error',
] as const

export type ControlFrameType = (typeof CONTROL_FRAME_TYPES)[number]

export interface ControlFrame<T = Record<string, unknown>> {
  v: typeof PROTOCOL_VERSION
  id: string
  type: ControlFrameType
  timestamp: number
  payload: T
}

/** Transport names the server negotiates, in preference order. */
export const TRANSPORT_NAMES = ['lan', 'p2p', 'turn', 'relay'] as const
export type TransportName = (typeof TRANSPORT_NAMES)[number]

const CAPABILITIES: Record<TransportName, string> = {
  lan: 'transport.lan', p2p: 'transport.p2p', turn: 'transport.turn', relay: 'transport.relay',
}

export function capabilityFor(transport: TransportName): string { return CAPABILITIES[transport] }

const KNOWN_TYPES = new Set<string>(CONTROL_FRAME_TYPES)

/** ULID or UUID, matching the reference `deviceIdSchema`. */
const DEVICE_ID = /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
/** base64url, canonical (no padding). */
const BASE64URL = /^[A-Za-z0-9_-]+$/
/** Identity keys are 32-byte Ed25519/X25519 public keys in base64url. */
const IDENTITY_KEY = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/

export class ProtocolError extends Error {
  constructor(readonly code: string) { super(code) }
}

function fail(code: string): never { throw new ProtocolError(code) }

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('INVALID_MESSAGE')
  return value as Record<string, unknown>
}

function str(value: unknown, code = 'INVALID_MESSAGE'): string {
  if (typeof value !== 'string' || value.length === 0) fail(code)
  return value
}

function boundedStr(value: unknown, max: number, code = 'INVALID_MESSAGE'): string {
  const result = str(value, code)
  if (result.length > max) fail(code)
  return result
}

function base64url(value: unknown, max = MAX_RELAY_FRAME_BYTES): string {
  const result = str(value)
  if (result.length > max || !BASE64URL.test(result)) fail('INVALID_MESSAGE')
  return result
}

/**
 * Decode one control frame.
 *
 * `raw` must be the text exactly as received: re-serialising changes bytes, and a
 * duplicate-key payload must not be silently collapsed. Duplicate keys are
 * rejected here for the same reason the reference implementation guards them —
 * JSON parsers keep the last one, so a payload could mean two things.
 */
export function decodeControlFrame(raw: string): ControlFrame {
  if (raw.length > MAX_RELAY_FRAME_BYTES) fail('FRAME_TOO_LARGE')
  if (hasDuplicateKeys(raw)) fail('INVALID_MESSAGE')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { fail('INVALID_MESSAGE') }
  const envelope = record(parsed)
  if (envelope.v !== PROTOCOL_VERSION) fail('UNSUPPORTED_VERSION')
  const type = str(envelope.type, 'INVALID_MESSAGE')
  if (!KNOWN_TYPES.has(type)) fail('INVALID_MESSAGE')
  const id = str(envelope.id)
  const timestamp = envelope.timestamp
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) fail('INVALID_MESSAGE')
  const payload = record(envelope.payload)
  return { v: PROTOCOL_VERSION, id, type: type as ControlFrameType, timestamp, payload }
}

/**
 * Detect duplicate keys in a JSON object/array document.
 *
 * A hand-rolled scanner rather than a parse-then-compare, because the duplicate
 * is gone after parsing. Only quoted strings at key positions count, so string
 * values containing `{` are not mistaken for structure.
 */
export function hasDuplicateKeys(raw: string): boolean {
  const stack: Set<string>[] = []
  let index = 0
  let expectKey = false

  while (index < raw.length) {
    const char = raw[index]
    if (char === '"') {
      // Read the whole string literal, honouring escapes.
      let end = index + 1
      let escaped = false
      while (end < raw.length) {
        const c = raw[end]
        if (escaped) { escaped = false; end += 1; continue }
        if (c === '\\') { escaped = true; end += 1; continue }
        if (c === '"') break
        end += 1
      }
      const literal = raw.slice(index, end + 1)
      // A key position is right after '{' or ','.
      if (expectKey && stack.length > 0) {
        const keys = stack[stack.length - 1]!
        if (keys.has(literal)) return true
        keys.add(literal)
      }
      expectKey = false
      index = end + 1
      continue
    }
    if (char === '{') { stack.push(new Set()); expectKey = true; index += 1; continue }
    if (char === '[') { stack.push(new Set()); expectKey = false; index += 1; continue }
    if (char === '}' || char === ']') { stack.pop(); expectKey = false; index += 1; continue }
    if (char === ',') { expectKey = true; index += 1; continue }
    if (char === ':') { expectKey = false; index += 1; continue }
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') { index += 1; continue }
    // Any other token (number, true, false, null) ends a key position.
    expectKey = false
    index += 1
  }
  return false
}

export function createControlFrame<T>(type: ControlFrameType, payload: T): ControlFrame<T> {
  return {
    v: PROTOCOL_VERSION,
    id: cryptoRandomId(),
    type,
    timestamp: Date.now(),
    payload,
  }
}

/** Short random id, same shape as the reference implementation's. */
export function cryptoRandomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

export function encodeFrame(frame: ControlFrame): string { return JSON.stringify(frame) }

// ---------------------------------------------------------------------------
// Payload accessors. The server only looks at routing fields; everything else
// is passed through untouched so a newer client is not broken by an older server.
// ---------------------------------------------------------------------------

export interface HelloPayload {
  role: 'host' | 'client'
  deviceId: string
  accessToken: string
  protocols: number[]
  capabilities: string[]
  clientVersion?: string
  harnessVersion?: string
}

export function parseHello(payload: Record<string, unknown>): HelloPayload {
  const role = payload.role
  if (role !== 'host' && role !== 'client') fail('INVALID_MESSAGE')
  const deviceId = str(payload.deviceId)
  if (!DEVICE_ID.test(deviceId)) fail('INVALID_MESSAGE')
  const accessToken = boundedStr(payload.accessToken, 4096)
  const protocols = payload.protocols
  if (!Array.isArray(protocols) || protocols.length === 0 || protocols.length > 16) fail('INVALID_MESSAGE')
  if (!protocols.every(p => typeof p === 'number' && Number.isInteger(p) && p >= 0)) fail('INVALID_MESSAGE')
  const capabilities = payload.capabilities
  if (!Array.isArray(capabilities) || capabilities.length > 64) fail('INVALID_MESSAGE')
  if (!capabilities.every(c => typeof c === 'string' && c.length > 0)) fail('INVALID_MESSAGE')
  const clientVersion = payload.clientVersion
  const harnessVersion = payload.harnessVersion
  return {
    role, deviceId, accessToken,
    protocols: protocols as number[],
    capabilities: capabilities as string[],
    ...(typeof clientVersion === 'string' ? { clientVersion: boundedStr(clientVersion, 128) } : {}),
    ...(typeof harnessVersion === 'string' ? { harnessVersion: boundedStr(harnessVersion, 128) } : {}),
  }
}

export interface ConnectRequestPayload { hostDeviceId: string; preferredTransports: TransportName[] }

export function parseConnectRequest(payload: Record<string, unknown>): ConnectRequestPayload {
  const hostDeviceId = str(payload.hostDeviceId)
  if (!DEVICE_ID.test(hostDeviceId)) fail('INVALID_MESSAGE')
  const raw = payload.preferredTransports
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > TRANSPORT_NAMES.length) fail('INVALID_MESSAGE')
  const preferredTransports: TransportName[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') fail('INVALID_MESSAGE')
    if (!(TRANSPORT_NAMES as readonly string[]).includes(entry)) fail('INVALID_MESSAGE')
    if (!preferredTransports.includes(entry as TransportName)) preferredTransports.push(entry as TransportName)
  }
  return { hostDeviceId, preferredTransports }
}

/** Routing fields shared by every frame that names a target. */
export function parseTarget(payload: Record<string, unknown>): { connectionId: string; targetDeviceId: string } {
  return {
    connectionId: boundedStr(payload.connectionId, 128),
    targetDeviceId: boundedStr(payload.targetDeviceId, 128),
  }
}

export function parseRelay(payload: Record<string, unknown>): { connectionId: string; targetDeviceId: string; counter: number } {
  const target = parseTarget(payload)
  const counter = payload.counter
  if (typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 0) fail('INVALID_MESSAGE')
  base64url(payload.ciphertext)
  return { ...target, counter }
}

export function parseSecureHandshake(payload: Record<string, unknown>): { connectionId: string; targetDeviceId: string; step: 1 | 2 } {
  const target = parseTarget(payload)
  const step = payload.step
  if (step !== 1 && step !== 2) fail('INVALID_MESSAGE')
  base64url(payload.data)
  return { ...target, step }
}

export function parseTransportSelected(payload: Record<string, unknown>): { connectionId: string; targetDeviceId: string; transport: TransportName } {
  const target = parseTarget(payload)
  const transport = payload.transport
  if (typeof transport !== 'string' || !(TRANSPORT_NAMES as readonly string[]).includes(transport)) fail('INVALID_MESSAGE')
  return { ...target, transport: transport as TransportName }
}

export function parsePingPong(payload: Record<string, unknown>): { nonce: string } {
  return { nonce: boundedStr(payload.nonce, 512) }
}

/** Validate an identity key, used by device registration. */
export function isIdentityKey(value: unknown): value is string {
  return typeof value === 'string' && IDENTITY_KEY.test(value)
}

export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_ID.test(value)
}

/**
 * `modernHost` gate from the reference implementation: hosts at or above
 * 0.2.15 support concurrent clients, so the server must not drop their older
 * links when a new one is requested.
 */
export function modernHost(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/.exec(version)
  if (!match) return false
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number]
  return major > 0 || minor > 2 || (minor === 2 && patch >= 15)
}
