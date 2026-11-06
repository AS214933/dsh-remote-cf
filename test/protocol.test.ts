/**
 * Protocol tests.
 *
 * These pin the wire contract the clients depend on: frame decoding, the limits
 * the server enforces, and the duplicate-key guard that stops one payload from
 * meaning two things.
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_CONTROL_FRAME_BYTES, MAX_RELAY_FRAME_BYTES, PROTOCOL_VERSION,
  createControlFrame, decodeControlFrame, hasDuplicateKeys, isDeviceId, isIdentityKey,
  modernHost, parseConnectRequest, parseHello, parseRelay, parseTransportSelected,
  ProtocolError,
} from '../src/protocol.js'

const DEVICE = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const IDENTITY = 'a'.repeat(42) + 'A'

function frame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1, id: 'f1', type: 'ping', timestamp: 1, payload: { nonce: 'n' }, ...overrides,
  })
}

describe('decodeControlFrame', () => {
  it('decodes a well-formed frame', () => {
    const decoded = decodeControlFrame(frame())
    expect(decoded.v).toBe(PROTOCOL_VERSION)
    expect(decoded.type).toBe('ping')
    expect(decoded.payload).toEqual({ nonce: 'n' })
  })

  it('rejects a wrong protocol version', () => {
    expect(() => decodeControlFrame(frame({ v: 2 }))).toThrow(/UNSUPPORTED_VERSION/)
  })

  it('rejects an unknown frame type', () => {
    expect(() => decodeControlFrame(frame({ type: 'not.a.frame' }))).toThrow(/INVALID_MESSAGE/)
  })

  it('rejects malformed JSON and non-object payloads', () => {
    expect(() => decodeControlFrame('not json')).toThrow(ProtocolError)
    expect(() => decodeControlFrame(frame({ payload: [] }))).toThrow(/INVALID_MESSAGE/)
  })

  it('rejects a frame over the relay frame ceiling', () => {
    const huge = JSON.stringify({ v: 1, id: 'x', type: 'ping', timestamp: 1, payload: { nonce: 'x'.repeat(MAX_RELAY_FRAME_BYTES) } })
    expect(() => decodeControlFrame(huge)).toThrow(/FRAME_TOO_LARGE/)
  })

  it('rejects duplicate keys so one payload cannot mean two things', () => {
    const duplicated = '{"v":1,"id":"a","type":"ping","timestamp":1,"payload":{"nonce":"x","nonce":"y"}}'
    expect(hasDuplicateKeys(duplicated)).toBe(true)
    expect(() => decodeControlFrame(duplicated)).toThrow(/INVALID_MESSAGE/)
  })

  it('does not mistake a brace inside a string for structure', () => {
    expect(hasDuplicateKeys(JSON.stringify({ a: '{not a key}', b: 1 }))).toBe(false)
  })
})

describe('parseHello', () => {
  const valid = {
    role: 'host', deviceId: DEVICE, accessToken: 'token', protocols: [1],
    capabilities: ['transport.relay'], clientVersion: '0.4.15',
  }

  it('accepts a valid hello', () => {
    expect(parseHello(valid)).toMatchObject({ role: 'host', deviceId: DEVICE })
  })

  it('rejects a bad role, device id or empty protocol list', () => {
    expect(() => parseHello({ ...valid, role: 'peer' })).toThrow(/INVALID_MESSAGE/)
    expect(() => parseHello({ ...valid, deviceId: 'nope' })).toThrow(/INVALID_MESSAGE/)
    expect(() => parseHello({ ...valid, protocols: [] })).toThrow(/INVALID_MESSAGE/)
  })

  it('rejects non-string capabilities', () => {
    expect(() => parseHello({ ...valid, capabilities: [1] })).toThrow(/INVALID_MESSAGE/)
  })
})

describe('parseConnectRequest', () => {
  it('deduplicates preferred transports and keeps order', () => {
    const parsed = parseConnectRequest({ hostDeviceId: DEVICE, preferredTransports: ['relay', 'p2p', 'relay'] })
    expect(parsed.preferredTransports).toEqual(['relay', 'p2p'])
  })

  it('rejects an unknown transport and an empty list', () => {
    expect(() => parseConnectRequest({ hostDeviceId: DEVICE, preferredTransports: ['carrier-pigeon'] })).toThrow(/INVALID_MESSAGE/)
    expect(() => parseConnectRequest({ hostDeviceId: DEVICE, preferredTransports: [] })).toThrow(/INVALID_MESSAGE/)
  })
})

describe('parseRelay', () => {
  const base = { connectionId: 'c1', targetDeviceId: DEVICE, counter: 1, ciphertext: 'AAAA' }

  it('accepts a valid relay payload', () => {
    expect(parseRelay(base)).toMatchObject({ connectionId: 'c1', counter: 1 })
  })

  it('rejects a negative or non-integer counter', () => {
    expect(() => parseRelay({ ...base, counter: -1 })).toThrow(/INVALID_MESSAGE/)
    expect(() => parseRelay({ ...base, counter: 1.5 })).toThrow(/INVALID_MESSAGE/)
  })

  it('rejects a non-base64url ciphertext', () => {
    expect(() => parseRelay({ ...base, ciphertext: 'not base64!' })).toThrow(/INVALID_MESSAGE/)
  })
})

describe('parseTransportSelected', () => {
  it('accepts lan as a first-class transport', () => {
    expect(parseTransportSelected({ connectionId: 'c', targetDeviceId: DEVICE, transport: 'lan' }))
      .toMatchObject({ transport: 'lan' })
  })

  it('rejects an unknown transport', () => {
    expect(() => parseTransportSelected({ connectionId: 'c', targetDeviceId: DEVICE, transport: 'quic' }))
      .toThrow(/INVALID_MESSAGE/)
  })
})

describe('identifiers', () => {
  it('accepts ULID and UUID device ids and rejects others', () => {
    expect(isDeviceId(DEVICE)).toBe(true)
    expect(isDeviceId('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true)
    expect(isDeviceId('short')).toBe(false)
    expect(isDeviceId('')).toBe(false)
  })

  it('accepts a canonical identity key and rejects a wrong length', () => {
    expect(isIdentityKey(IDENTITY)).toBe(true)
    // The trailing character of a 32-byte base64url key is constrained: only the
    // values whose low bits are zero are canonical, so 'B' is not acceptable there.
    expect(isIdentityKey('a'.repeat(42) + 'B')).toBe(false)
    expect(isIdentityKey('a'.repeat(42) + 'I')).toBe(true)
    expect(isIdentityKey('a'.repeat(41))).toBe(false)
  })
})

describe('modernHost', () => {
  it('treats 0.2.15 and above as modern', () => {
    expect(modernHost('0.2.15')).toBe(true)
    expect(modernHost('0.3.0')).toBe(true)
    expect(modernHost('1.0.0')).toBe(true)
  })

  it('treats older and unparseable versions as legacy', () => {
    expect(modernHost('0.2.14')).toBe(false)
    expect(modernHost('garbage')).toBe(false)
  })
})

describe('createControlFrame', () => {
  it('stamps the protocol version and a timestamp', () => {
    const created = createControlFrame('pong', { nonce: 'n' })
    expect(created.v).toBe(PROTOCOL_VERSION)
    expect(created.type).toBe('pong')
    expect(typeof created.timestamp).toBe('number')
    expect(created.id.length).toBeGreaterThan(0)
  })
})

describe('frame ceilings', () => {
  it('control frames are smaller than relay frames', () => {
    expect(MAX_CONTROL_FRAME_BYTES).toBeLessThan(MAX_RELAY_FRAME_BYTES)
  })
})
