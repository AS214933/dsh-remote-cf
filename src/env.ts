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
  /**
   * Comma-separated origins allowed to call the API from a browser, e.g. the
   * workbench UI. Empty means same-origin only. A trailing slash is tolerated.
   */
  readonly DSH_SERVER_ALLOWED_ORIGINS?: string
  /** `assets` serves the SPA at `/`; anything else answers 418 at the root. */
  readonly DSH_SERVER_ROOT_PAGE?: string
  /**
   * `1` lets one Host serve several clients regardless of its reported version. Needed
   * for Hosts whose version string sorts below the concurrent-client threshold, such as
   * a prerelease build.
   */
  readonly DSH_SERVER_ALLOW_CONCURRENT_HOSTS?: string
  /**
   * `disabled` turns the password form off, leaving OIDC as the only way in. Anything
   * else (including unset) keeps it enabled.
   */
  readonly DSH_SERVER_PASSWORD_LOGIN?: string
  /** Signs web session cookies. A secret, at least 16 characters. */
  readonly SESSION_SECRET: string

  /** Static assets (the SPA). */
  readonly ASSETS: Fetcher
  /** The one Gateway instance holding every WebSocket. */
  readonly GATEWAY: DurableObjectNamespace<import('./gateway.js').Gateway>

  // --- Logto (optional; password login works without it) ---
  /** Tenant endpoint, e.g. https://auth.example.com (no /oidc suffix). */
  readonly LOGTO_ENDPOINT?: string
  readonly LOGTO_CLIENT_ID?: string
  /** A secret: `wrangler secret put LOGTO_CLIENT_SECRET`. */
  readonly LOGTO_CLIENT_SECRET?: string
  /** API resource the access token is minted for. Optional. */
  readonly LOGTO_API_RESOURCE?: string
  /** Extra scopes beyond `openid profile email`, comma separated. */
  readonly LOGTO_SCOPES?: string

  // --- OAuth (optional; password login works without it) ---
  /**
   * JSON array of OAuth providers. A plain var, not a secret: each entry names the
   * environment binding that holds its client secret, so nothing confidential is here.
   */
  readonly OAUTH_PROVIDERS?: string
  /** Comma-separated accounts allowed to sign in via OAuth. Defaults to DSH_SERVER_ACCOUNT. */
  readonly OAUTH_ALLOWED_ACCOUNTS?: string
  /** `application` trusts successful verified-email authentication to this OIDC app; default is explicit email allowlist. */
  readonly DSH_SERVER_OIDC_ADMISSION?: 'application' | 'allowlist'
  /** Optional bound-user cap: unset/empty/0 means unlimited; positive safe integer sets a cap. Resource ceilings still apply. */
  readonly DSH_SERVER_MAX_TENANTS?: string
  /** Explicit stable OIDC identity allowed to bind the reserved legacy owner partition. Never inferred from email. */
  readonly DSH_SERVER_LEGACY_OWNER_SUBJECT?: string
  readonly DSH_SERVER_LEGACY_OWNER_ISSUER?: string
  /** Temporary identity-only enrollment gate. Secret capability; never grants legacy devices or a session. */
  readonly DSH_SERVER_IDENTITY_PROBE_KEY?: string
  /** Independent operator-only evidence signing Secret. Never included in enrollment URLs. */
  readonly DSH_SERVER_IDENTITY_EVIDENCE_KEY?: string
  /** During owner enrollment, reject normal new OIDC sessions while existing device credentials continue. */
  readonly DSH_SERVER_IDENTITY_ENROLLMENT_ONLY?: string

  // --- Cloudflare Realtime TURN (optional; Relay works without it) ---
  readonly TURN_KEY_ID?: string
  readonly TURN_KEY_API_TOKEN?: string
  readonly TURN_CREDENTIAL_TTL_SECONDS?: string

  /**
   * Provider client secrets, named `OAUTH_<PROVIDER_ID>_CLIENT_SECRET` (upper-cased).
   * Read through this index signature because the name depends on the provider list.
   */
  readonly [binding: `OAUTH_${string}_CLIENT_SECRET`]: string | undefined

  // --- Timing (all optional, bounded) ---
  readonly DSH_SERVER_HELLO_TIMEOUT_MS?: string
  readonly DSH_SERVER_HEARTBEAT_INTERVAL_MS?: string
  readonly DSH_SERVER_HEARTBEAT_DISCONNECT_MS?: string
}
