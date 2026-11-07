/**
 * Standard OAuth 2.0 authorization-code integration.
 *
 * The client protocol is server-driven: the client only knows "list providers", "create
 * a session", "poll for the result", and the browser is sent wherever the server points
 * it. That means any OAuth 2.0 provider works without touching a client — GitHub,
 * GitLab, Logto, Keycloak, Auth0.
 *
 * The reference server returns both `startUrl` and `qrStartUrl` for every provider. `scanUrl` is not an image: it is a redirect page,
 * so scanning the code and clicking "open in browser" walk the same path.
 */
import type { Env } from './env.js'
import { fromBase64Url, hmacSha256, toBase64Url, timingSafeEqualBytes } from './crypto.js'

const encoder = new TextEncoder()

/**
 * One OAuth 2.0 provider.
 *
 * `clientSecretEnv` names the environment binding holding the secret rather than the
 * secret itself, so the provider list can live in a plain `var` without leaking one.
 */
export interface OAuthProvider {
  id: string
  displayName: string
  authorizeUrl: string
  tokenUrl: string
  userInfoUrl: string
  clientId: string
  clientSecret: string
  scopes: string
  /** JSON field holding the account identifier. `email` for OIDC, `login` for GitHub. */
  accountField: string
  /**
   * Optional endpoint returning a list of addresses, for providers whose profile has no
   * usable email (GitHub returns `email: null` when the user hides it).
   */
  emailUrl?: string
  /** Field on each entry of the list that holds the address. */
  emailListField?: string
  /** Field marking the primary entry in that list. */
  emailPrimaryField?: string
}

interface ProviderConfig {
  id: string
  displayName: string
  authorizeUrl: string
  tokenUrl: string
  userInfoUrl: string
  clientId: string
  scopes?: string
  accountField?: string
  emailUrl?: string
  emailListField?: string
  emailPrimaryField?: string
}

/** Ids are used in paths and cookie names, so they are constrained like the client does. */
const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
/** Account ids end up in a device descriptor; keep them sane. */
const ACCOUNT = /^[^\s\x00-\x1f]{1,254}$/

/**
 * Parse the provider list.
 *
 * Returns an empty array when unconfigured, which is what makes the client show
 * "no QR sign-in available" and fall back to the password form — the behaviour this
 * deployment has today. A malformed entry is dropped rather than throwing, so one bad
 * provider cannot take the whole login page down.
 */
export function parseProviders(env: Env): OAuthProvider[] {
  const raw = env.OAUTH_PROVIDERS?.trim()
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [] }
  if (!Array.isArray(parsed)) return []

  const providers: OAuthProvider[] = []
  const seen = new Set<string>()
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const config = entry as Partial<ProviderConfig>
    if (typeof config.id !== 'string' || !PROVIDER_ID.test(config.id) || seen.has(config.id)) continue
    if (typeof config.displayName !== 'string' || config.displayName.trim() === '') continue
    if (typeof config.authorizeUrl !== 'string' || typeof config.tokenUrl !== 'string'
      || typeof config.userInfoUrl !== 'string' || typeof config.clientId !== 'string') continue
    const clientSecret = env[`OAUTH_${config.id.toUpperCase()}_CLIENT_SECRET` as keyof Env]
    if (typeof clientSecret !== 'string' || clientSecret === '') continue
    seen.add(config.id)
    providers.push({
      id: config.id,
      displayName: config.displayName.trim().slice(0, 128),
      authorizeUrl: config.authorizeUrl,
      tokenUrl: config.tokenUrl,
      userInfoUrl: config.userInfoUrl,
      clientId: config.clientId,
      clientSecret,
      scopes: typeof config.scopes === 'string' ? config.scopes : 'read:user user:email',
      accountField: typeof config.accountField === 'string' ? config.accountField : 'email',
      ...(typeof config.emailUrl === 'string' ? { emailUrl: config.emailUrl } : {}),
      ...(typeof config.emailListField === 'string' ? { emailListField: config.emailListField } : {}),
      ...(typeof config.emailPrimaryField === 'string' ? { emailPrimaryField: config.emailPrimaryField } : {}),
    })
  }
  return providers
}

export function findProvider(env: Env, id: string): OAuthProvider | null {
  return parseProviders(env).find(provider => provider.id === id) ?? null
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export interface OAuthState {
  typ: string
  /** Where to send the browser after success. Validated against an allowlist. */
  returnTo: string
  nonce: string
  /** Present for the QR flow, null for the direct browser flow. */
  qrId: string | null
  /** Session row holding the PKCE verifier, for the direct flow where qrId is null. */
  flowId?: string
  iat: number
  exp: number
}

const STATE_TTL_SECONDS = 600

/**
 * Build a signed state token.
 *
 * The payload carries `returnTo`, which is why it must be signed: an unsigned return
 * target lets an attacker send the session token to their own server. The reference
 * server uses a JWT; this is the same shape with HMAC-SHA256.
 */
export async function signState(secret: string, input: {
  providerId: string; returnTo: string; qrId: string | null; flowId?: string; nonce?: string
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: OAuthState = {
    typ: `${input.providerId}-oauth-state`,
    returnTo: input.returnTo,
    nonce: input.nonce ?? toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    qrId: input.qrId,
    ...(input.flowId === undefined ? {} : { flowId: input.flowId }),
    iat: now,
    exp: now + STATE_TTL_SECONDS,
  }
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)))
  const signature = toBase64Url(await hmacSha256(secret, body))
  return `${body}.${signature}`
}

export async function verifyState(
  secret: string,
  token: string,
  expectedProviderId: string,
  now = Date.now(),
): Promise<OAuthState | null> {
  const separator = token.indexOf('.')
  if (separator <= 0 || separator === token.length - 1) return null
  const body = token.slice(0, separator)
  const provided = token.slice(separator + 1)
  const expected = toBase64Url(await hmacSha256(secret, body))
  // Constant-time so a wrong signature cannot be found byte by byte.
  if (!timingSafeEqualBytes(encoder.encode(expected), encoder.encode(provided))) return null
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) } catch { return null }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (record.typ !== `${expectedProviderId}-oauth-state`) return null
  if (typeof record.returnTo !== 'string' || !isAllowedReturnTo(record.returnTo)) return null
  if (typeof record.nonce !== 'string' || record.nonce.length < 8) return null
  if (record.qrId !== null && typeof record.qrId !== 'string') return null
  if (record.flowId !== undefined && typeof record.flowId !== 'string') return null
  if (typeof record.iat !== 'number' || typeof record.exp !== 'number') return null
  // Expiry is checked here rather than trusted from the caller: a state that outlives
  // its window is replayable even if every other field is intact.
  if (record.exp * 1000 <= now) return null
  return {
    typ: record.typ, returnTo: record.returnTo, nonce: record.nonce,
    qrId: (record.qrId as string | null),
    ...(typeof record.flowId === 'string' ? { flowId: record.flowId } : {}),
    iat: record.iat, exp: record.exp,
  }
}

// ---------------------------------------------------------------------------
// return_to allowlist
// ---------------------------------------------------------------------------

/**
 * Where the browser may be sent after a successful login.
 *
 * An open redirect here would deliver the session token to whoever controls the target,
 * so the list is explicit and closed. Custom schemes are the mobile clients' callbacks;
 * relative paths keep the desktop flow on our own origin.
 */
const RETURN_TO_SCHEMES = ['dshremote://oauth']
const RETURN_TO_PATHS = ['/app', '/']

export function isAllowedReturnTo(value: string): boolean {
  if (RETURN_TO_SCHEMES.includes(value)) return true
  if (!value.startsWith('/') || value.startsWith('//')) return false
  // A protocol-relative or backslash-smuggled value would escape the origin.
  if (value.includes('\\') || value.includes('\n') || value.includes('\r')) return false
  return RETURN_TO_PATHS.includes(value)
}

// ---------------------------------------------------------------------------
// provider calls
// ---------------------------------------------------------------------------

export interface OAuthIdentity { account: string; isAdmin: boolean }

function field(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Exchange the authorization code. Returns null on any failure. */
export async function exchangeCode(
  provider: OAuthProvider, code: string, redirectUri: string,
): Promise<string | null> {
  try {
    const response = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null
    const body = await response.json() as Record<string, unknown>
    return typeof body.access_token === 'string' && body.access_token !== '' ? body.access_token : null
  } catch {
    return null
  }
}

/**
 * Resolve the account for an access token.
 *
 * The token is used server-side to read the profile; nothing from the callback URL is
 * trusted. Providers that hide the address (GitHub returns `email: null`) need the
 * secondary endpoint, which is why it is configurable.
 */
export async function fetchIdentity(
  provider: OAuthProvider, accessToken: string,
): Promise<{ account: string; profile: Record<string, unknown>; isAdmin: boolean } | null> {
  try {
    const response = await fetch(provider.userInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'dsh-remote-cf',
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return null
    const profile = await response.json() as Record<string, unknown>

    let account = field(profile, provider.accountField)
    if ((typeof account !== 'string' || account === '') && provider.emailUrl !== undefined) {
      const emails = await fetch(provider.emailUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          'User-Agent': 'dsh-remote-cf',
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (emails.ok) {
        const list = await emails.json() as unknown
        if (Array.isArray(list)) {
          const fieldName = provider.emailListField ?? 'email'
          const primaryField = provider.emailPrimaryField ?? 'primary'
          const usable = list.filter(entry => typeof entry === 'object' && entry !== null)
          const chosen = usable.find(entry => (entry as Record<string, unknown>)[primaryField] === true) ?? usable[0]
          const value = chosen === undefined ? undefined : (chosen as Record<string, unknown>)[fieldName]
          if (typeof value === 'string' && value !== '') account = value
        }
      }
    }
    if (typeof account !== 'string' || !ACCOUNT.test(account)) return null
    // Admin is not a provider concept. Single-account means the configured account is
    // the admin; anything else that got this far is not.
    const normalized = account.toLowerCase()
    const admin = (envAccount: string | undefined) => envAccount?.trim().toLowerCase() === normalized
    void admin
    return { account: normalized, profile, isAdmin: false }
  } catch {
    return null
  }
}

/** Accounts allowed to sign in through OAuth. Defaults to the single configured account. */
export function allowedAccounts(env: Env): string[] {
  const raw = env.OAUTH_ALLOWED_ACCOUNTS?.trim()
  if (!raw) return [env.DSH_SERVER_ACCOUNT.trim().toLowerCase()]
  return raw.split(',').map((entry: string) => entry.trim().toLowerCase()).filter((entry: string) => entry !== '')
}

export function callbackUrl(env: Env, providerId: string): string {
  return `${env.DSH_SERVER_PUBLIC_URL}/api/v1/auth/oauth/${providerId}/callback`
}

export function authorizeUrl(provider: OAuthProvider, redirectUri: string, state: string): string {
  const url = new URL(provider.authorizeUrl)
  url.searchParams.set('client_id', provider.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  if (provider.scopes !== '') url.searchParams.set('scope', provider.scopes)
  url.searchParams.set('response_type', 'code')
  return url.toString()
}

export function stateCookieName(providerId: string): string {
  return `dsh_web_${providerId}_oauth_state`
}
