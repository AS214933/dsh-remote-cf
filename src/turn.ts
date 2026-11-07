/**
 * TURN credentials.
 *
 * Cloudflare Realtime TURN issues its own short-lived credentials through an API
 * call; the response shape (`iceServers` with `urls` / `username` / `credential`)
 * matches what the clients already parse, so it is passed through unchanged.
 *
 * The TURN key API token is a long-lived secret that can mint unlimited
 * credentials — it must never reach a client, and it must be treated like the
 * Logto M2M secret (a `wrangler secret`, never a plain var).
 */
import type { Env } from './env.js'
import { resolveTurn, type TurnConfig } from './config.js'

export interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

const CF_TURN_ENDPOINT = 'https://rtc.live.cloudflare.com/v1/turn/keys'

/**
 * Fetch credentials for one connection.
 *
 * Returns null when TURN is not configured, in which case the caller advertises
 * the Relay-only path and clients fall back automatically.
 */
export async function turnIceServers(env: Env, deviceId: string): Promise<IceServer[] | null> {
  const cfg: TurnConfig | null = resolveTurn(env)
  if (cfg === null) return null

  try {
    const response = await fetch(`${CF_TURN_ENDPOINT}/${cfg.keyId}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: cfg.ttlSeconds }),
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return null
    const body = await response.json() as { iceServers?: unknown }
    if (!Array.isArray(body.iceServers)) return null

    // Filter to the shape the clients expect; unknown extra fields are dropped so
    // a protocol change upstream cannot confuse an older client.
    const servers: IceServer[] = []
    for (const entry of body.iceServers) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      const urls = record.urls
      if (typeof urls !== 'string' && !Array.isArray(urls)) continue
      const server: IceServer = { urls: urls as string | string[] }
      if (typeof record.username === 'string') server.username = record.username
      if (typeof record.credential === 'string') server.credential = record.credential
      servers.push(server)
    }
    void deviceId
    return servers.length > 0 ? servers : null
  } catch {
    // A TURN outage must not break login or connection setup: the Relay path
    // still works, so degrade rather than fail.
    return null
  }
}

/**
 * Best-effort, per-device credential reuse in one Gateway instance. Nothing is
 * persisted: hibernation or deployment simply makes the next lookup cold.
 * Credentials are not connection-bound by the provider; every caller must still
 * authorize its current link before AND after awaiting this cache.
 */
export class TurnCredentialCache {
  private readonly entries = new Map<string, { result: Promise<IceServer[] | null>; validUntil: number; settled: boolean }>()
  private activeFetches = 0

  constructor(private readonly env: Env) {}

  get(deviceId: string): Promise<IceServer[] | null> {
    const cfg = resolveTurn(this.env)
    if (cfg === null) return Promise.resolve(null)
    const now = Date.now()
    for (const [id, entry] of this.entries) {
      if (entry.settled && entry.validUntil <= now) this.entries.delete(id)
    }
    const cached = this.entries.get(deviceId)
    if (cached !== undefined) {
      console.info('turn credential lookup', { source: cached.settled ? 'cache' : 'inflight' })
      return cached.result
    }
    // Bound both retained entries and *all* flights, including ones invalidated
    // during revocation. Invalidation cannot create an unbounded off-map pile.
    if (this.entries.size >= 64 || this.activeFetches >= 64) return Promise.resolve(null)
    // Anchor before the fetch, retain a 60 s handshake margin, cap reuse at five
    // minutes. At minimum TTL a fresh result still works, but is not reused.
    const validUntil = now + Math.min(300_000, Math.max(0, cfg.ttlSeconds - 60) * 1000)
    const entry = { result: Promise.resolve<IceServer[] | null>(null), validUntil, settled: false }
    this.activeFetches++
    entry.result = turnIceServers(this.env, deviceId).then(servers => {
      entry.settled = true
      this.activeFetches--
      console.info('turn credential mint', { durationMs: Date.now() - now, success: servers !== null })
      if (this.entries.get(deviceId) === entry && (servers === null || Date.now() >= validUntil)) {
        this.entries.delete(deviceId)
      }
      // No rejected promise or negative result is retained. A stale invalidated
      // flight never writes an entry back, nor removes its newer replacement.
      return Date.now() < now + cfg.ttlSeconds * 1000 ? servers : null
    })
    this.entries.set(deviceId, entry)
    return entry.result
  }

  forget(deviceId: string): void { this.entries.delete(deviceId) }
}

/** STUN-only list, used when TURN is unavailable but STUN is worth advertising. */
export const STUN_ONLY: IceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }]
