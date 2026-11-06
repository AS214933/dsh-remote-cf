/**
 * Environment bindings for the Worker and its Durable Object.
 *
 * Single-account by design, matching the self-hosted reference server: one account
 * from the environment, no user table, no identity provider.
 *
 * The password and session secret must be set with `wrangler secret put` — plain
 * vars are readable in the dashboard and echoed by `wrangler deploy`.
 */
export interface Env {
  /** The one account this deployment serves. Required. */
  readonly DSH_SERVER_ACCOUNT: string
  /** Its password. Required, at least 12 characters. A secret, never a var. */
  readonly DSH_SERVER_PASSWORD: string
  /** Public origin, used for Origin validation. No trailing slash, no path. */
  readonly DSH_SERVER_PUBLIC_URL: string
  /** Signs web session cookies. A secret, at least 16 characters. */
  readonly SESSION_SECRET: string

  /** Static assets (the SPA). */
  readonly ASSETS: Fetcher
  /** The one Gateway instance holding every WebSocket. */
  readonly GATEWAY: DurableObjectNamespace<import('./gateway.js').Gateway>

  // --- Cloudflare Realtime TURN (optional; Relay works without it) ---
  readonly TURN_KEY_ID?: string
  readonly TURN_KEY_API_TOKEN?: string
  readonly TURN_CREDENTIAL_TTL_SECONDS?: string

  // --- Timing (all optional, bounded) ---
  readonly DSH_SERVER_HELLO_TIMEOUT_MS?: string
  readonly DSH_SERVER_HEARTBEAT_INTERVAL_MS?: string
  readonly DSH_SERVER_HEARTBEAT_DISCONNECT_MS?: string
}
