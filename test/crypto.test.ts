/**
 * Crypto and configuration tests.
 *
 * The session cookie is the only thing standing between a request and the account
 * API, so its verification is pinned here: tampering, expiry, and the exact byte
 * comparison all matter.
 */
import { describe, expect, it } from 'vitest'
import {
  coturnCredential, randomToken, sha256Hex, signSession, timingSafeEqualBytes,
  verifySession, fromBase64Url, toBase64Url,
} from '../src/crypto.js'
import { DEFAULT_LOCKOUT, RATE_LIMITS, resolveTiming, resolveTurn } from '../src/config.js'
import type { Env } from '../src/env.js'

const SECRET = 'test-session-secret'

function env(overrides: Partial<Env> = {}): Env {
  return {
    DSH_SERVER_ACCOUNT: 'owner@example.com',
    DSH_SERVER_PUBLIC_URL: 'https://example.com',
    ...overrides,
  } as Env
}

describe('sha256Hex', () => {
  it('matches the known digest', async () => {
    // Well-known vector: sha256("abc").
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('is stable across calls', async () => {
    expect(await sha256Hex('token')).toBe(await sha256Hex('token'))
  })
})

describe('randomToken', () => {
  it('produces 32 bytes of base64url', () => {
    const token = randomToken()
    // 32 bytes -> 43 base64url chars with the padding stripped.
    expect(token).toHaveLength(43)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 100 }, () => randomToken()))
    expect(seen.size).toBe(100)
  })
})

describe('base64url round trip', () => {
  it('preserves bytes', () => {
    const bytes = new Uint8Array([0, 1, 254, 255, 128, 64])
    expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes))
  })

  it('does not emit padding or url-unsafe characters', () => {
    const encoded = toBase64Url(new Uint8Array([251, 255, 190]))
    expect(encoded).not.toContain('=')
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
  })
})

describe('timingSafeEqualBytes', () => {
  it('compares equal and unequal inputs', () => {
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true)
    expect(timingSafeEqualBytes(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false)
  })

  it('rejects different lengths without throwing', () => {
    expect(timingSafeEqualBytes(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false)
  })
})

describe('session cookie', () => {
  it('round-trips a payload', async () => {
    const payload = { account: 'a@b.com', expiresAt: Date.now() + 60_000 }
    const cookie = await signSession(SECRET, payload)
    expect(await verifySession(SECRET, cookie)).toEqual(payload)
  })

  it('rejects a payload signed with another secret', async () => {
    const cookie = await signSession('other-secret', { account: 'a@b.com', expiresAt: Date.now() + 60_000 })
    expect(await verifySession(SECRET, cookie)).toBeNull()
  })

  it('rejects a tampered body', async () => {
    const cookie = await signSession(SECRET, { account: 'a@b.com', expiresAt: Date.now() + 60_000 })
    const [body, signature] = cookie.split('.')
    const forged = toBase64Url(new TextEncoder().encode(JSON.stringify({ account: 'x@y.com', expiresAt: Date.now() + 60_000 })))
    expect(await verifySession(SECRET, `${forged}.${signature}`)).toBeNull()
    // And the original body with the original signature still verifies, proving the
    // rejection above came from the signature and not from a malformed cookie.
    expect(await verifySession(SECRET, `${body}.${signature}`)).not.toBeNull()
  })

  it('rejects an expired session', async () => {
    const cookie = await signSession(SECRET, { account: 'a@b.com', expiresAt: Date.now() - 1 })
    expect(await verifySession(SECRET, cookie)).toBeNull()
  })

  it('rejects malformed cookies without throwing', async () => {
    for (const bad of ['', '.', 'no-dot', 'a.b', '.sig']) {
      expect(await verifySession(SECRET, bad)).toBeNull()
    }
  })
})

describe('coturnCredential', () => {
  it('matches the coturn REST API algorithm', async () => {
    // base64(HMAC-SHA1(secret, username)), the scheme coturn's use-auth-secret uses.
    const credential = await coturnCredential('secret', '1700000000:device')
    expect(credential).toMatch(/^[A-Za-z0-9+/]+=*$/)
    // A different secret must not produce the same credential.
    expect(await coturnCredential('other', '1700000000:device')).not.toBe(credential)
  })
})

describe('resolveTiming', () => {
  it('uses documented defaults when unset', () => {
    const timing = resolveTiming(env())
    expect(timing.helloTimeoutMs).toBe(5000)
    expect(timing.heartbeatIntervalMs).toBe(25_000)
    expect(timing.heartbeatDisconnectMs).toBe(75_000)
  })

  it('accepts in-range values', () => {
    const timing = resolveTiming(env({ DSH_SERVER_HEARTBEAT_INTERVAL_MS: '10000' }))
    expect(timing.heartbeatIntervalMs).toBe(10_000)
    // The disconnect threshold must stay at least twice the interval.
    expect(timing.heartbeatDisconnectMs).toBeGreaterThanOrEqual(20_000)
  })

  it('falls back when a value is out of range or not an integer', () => {
    expect(resolveTiming(env({ DSH_SERVER_HEARTBEAT_INTERVAL_MS: '1' })).heartbeatIntervalMs).toBe(25_000)
    expect(resolveTiming(env({ DSH_SERVER_HEARTBEAT_INTERVAL_MS: 'abc' })).heartbeatIntervalMs).toBe(25_000)
    expect(resolveTiming(env({ DSH_SERVER_HELLO_TIMEOUT_MS: '999999' })).helloTimeoutMs).toBe(5000)
  })

  it('rejects a disconnect threshold below twice the interval', () => {
    // 25s interval, so anything under 50s is unusable.
    const timing = resolveTiming(env({
      DSH_SERVER_HEARTBEAT_INTERVAL_MS: '25000',
      DSH_SERVER_HEARTBEAT_DISCONNECT_MS: '30000',
    }))
    expect(timing.heartbeatDisconnectMs).toBe(75_000)
  })
})

describe('resolveTurn', () => {
  it('is disabled without a key or token', () => {
    expect(resolveTurn(env())).toBeNull()
    expect(resolveTurn(env({ TURN_KEY_ID: 'k' }))).toBeNull()
    expect(resolveTurn(env({ TURN_KEY_API_TOKEN: 't' }))).toBeNull()
  })

  it('defaults the TTL to 24 h and clamps out-of-range values', () => {
    const configured = resolveTurn(env({ TURN_KEY_ID: 'k', TURN_KEY_API_TOKEN: 't' }))
    expect(configured?.ttlSeconds).toBe(86_400)
    // Cloudflare allows at most 48 h.
    expect(resolveTurn(env({ TURN_KEY_ID: 'k', TURN_KEY_API_TOKEN: 't', TURN_CREDENTIAL_TTL_SECONDS: '999999' }))?.ttlSeconds)
      .toBe(86_400)
    expect(resolveTurn(env({ TURN_KEY_ID: 'k', TURN_KEY_API_TOKEN: 't', TURN_CREDENTIAL_TTL_SECONDS: '10' }))?.ttlSeconds)
      .toBe(86_400)
  })
})

describe('limit layering', () => {
  it('keeps the lockout threshold above the per-address login limit', () => {
    // If the lockout fired first it would make the documented per-address budget
    // unreachable, quietly redefining the limit instead of adding to it.
    expect(DEFAULT_LOCKOUT.threshold).toBeGreaterThan(RATE_LIMITS.login.max)
  })

  it('keeps the per-account budget above the per-address one', () => {
    expect(RATE_LIMITS.loginAccount.max).toBeGreaterThan(RATE_LIMITS.login.max)
  })
})
