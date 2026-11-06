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

/** STUN-only list, used when TURN is unavailable but STUN is worth advertising. */
export const STUN_ONLY: IceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }]
