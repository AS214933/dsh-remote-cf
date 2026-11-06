import type { Env } from './env.js'

/**
 * Runtime configuration, read from env with the same bounds as the reference
 * server. Every timing value is range-checked and falls back to a documented
 * default rather than reaching a scheduler as NaN.
 */

export interface TimingConfig {
  helloTimeoutMs: number
  heartbeatIntervalMs: number
  heartbeatDisconnectMs: number
}

const HELLO_TIMEOUT = { min: 1000, max: 60_000, fallback: 5000 } as const
const HEARTBEAT_INTERVAL = { min: 5000, max: 120_000, fallback: 25_000 } as const
const HEARTBEAT_DISCONNECT_MAX = 600_000
const HEARTBEAT_DISCONNECT_FLOOR = 75_000
const HEARTBEAT_DISCONNECT_FACTOR = 3
const DISCONNECT_MIN_FACTOR = 2

function normalize(value: unknown, range: { min: number; max: number; fallback: number }): number {
  const candidate = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(candidate) || !Number.isInteger(candidate) || candidate < range.min || candidate > range.max) {
    return range.fallback
  }
  return candidate
}

export function resolveTiming(env: Env): TimingConfig {
  const heartbeatIntervalMs = normalize(env.DSH_SERVER_HEARTBEAT_INTERVAL_MS, HEARTBEAT_INTERVAL)
  const minimum = heartbeatIntervalMs * DISCONNECT_MIN_FACTOR
  const fallback = Math.min(
    HEARTBEAT_DISCONNECT_MAX,
    Math.max(HEARTBEAT_DISCONNECT_FLOOR, heartbeatIntervalMs * HEARTBEAT_DISCONNECT_FACTOR),
  )
  const raw = env.DSH_SERVER_HEARTBEAT_DISCONNECT_MS
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  const heartbeatDisconnectMs = Number.isInteger(parsed) && parsed >= minimum && parsed <= HEARTBEAT_DISCONNECT_MAX
    ? parsed
    : fallback
  return {
    helloTimeoutMs: normalize(env.DSH_SERVER_HELLO_TIMEOUT_MS, HELLO_TIMEOUT),
    heartbeatIntervalMs,
    heartbeatDisconnectMs,
  }
}

/** TURN configuration. Absent means the Relay-only path is advertised. */
export interface TurnConfig {
  readonly keyId: string
  readonly apiToken: string
  readonly ttlSeconds: number
}

export function resolveTurn(env: Env): TurnConfig | null {
  const keyId = env.TURN_KEY_ID?.trim()
  const apiToken = env.TURN_KEY_API_TOKEN?.trim()
  if (!keyId || !apiToken) return null
  const raw = Number(env.TURN_CREDENTIAL_TTL_SECONDS ?? '86400')
  // Cloudflare allows up to 48 h; below 60 s a credential can expire mid-handshake.
  const ttlSeconds = Number.isFinite(raw) && raw >= 60 && raw <= 172_800 ? Math.floor(raw) : 86_400
  return { keyId, apiToken, ttlSeconds }
}

export interface LoginLockoutConfig {
  readonly threshold: number
  readonly lockMs: number
  readonly streakMs: number
}

/**
 * Threshold sits above the per-address rate limit on purpose: the address limit
 * is what stops a single source, and this only has to catch a source rotating
 * addresses. Setting it lower would make the address limit unreachable.
 */
export const DEFAULT_LOCKOUT: LoginLockoutConfig = { threshold: 25, lockMs: 5 * 60_000, streakMs: 15 * 60_000 }

/** Fixed-window budgets, mirroring the reference server. */
export const RATE_LIMITS = {
  api: { max: 240, windowMs: 60_000 },
  login: { max: 20, windowMs: 60_000 },
  loginAccount: { max: 60, windowMs: 60_000 },
} as const
