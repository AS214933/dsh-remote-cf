/**
 * Logto sign-in built on the official SDK.
 *
 * `@logto/js` is used for the parts that are pure protocol — discovery, the authorize
 * URL, PKCE, and the code exchange — because those are where a hand-written client
 * drifts from the spec. It is deliberately *not* used for id_token validation: its
 * `decodeIdToken` only parses the payload and checks field types, with no signature
 * check at all. That is a reasonable choice for a browser SDK (TLS and a userinfo call
 * carry the trust) but not for a server that is deciding who may log in, so the
 * signature is verified here against the tenant's JWKS.
 */
import {
  discoveryPath, fetchOidcConfig, fetchTokenByAuthorizationCode, generateSignInUri, Prompt,
  type IdTokenClaims, type OidcConfigResponse, type Requester,
} from '@logto/js'
import type { Env } from './env.js'
import { fromBase64Url, toBase64Url } from './crypto.js'

const encoder = new TextEncoder()

/** Workers' `fetch` satisfies the SDK's requester shape directly. */
/**
 * The SDK's requester must return **parsed JSON**, not a `Response`.
 *
 * `fetchOidcConfig` does `camelcaseKeys(await requester(endpoint))`, so handing it a
 * `Response` yields an object with every field undefined — discovery silently produces
 * `issuer: undefined` and verification then fails with no clue why.
 */
const requester: Requester = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const response = await fetch(input, init)
  if (!response.ok) throw new Error(`provider responded ${response.status}`)
  return response.json()
}) as Requester

export interface LogtoConfig {
  endpoint: string
  clientId: string
  clientSecret: string
  /** API resource the access token is minted for. Optional for plain sign-in. */
  resource?: string
  /** Extra scopes beyond `openid profile email`. */
  scopes: string[]
}

/**
 * Read the Logto settings.
 *
 * Returns null when unconfigured, which keeps the password form as the only option —
 * the behaviour this deployment has today.
 */
export function logtoConfig(env: Env): LogtoConfig | null {
  const endpoint = env.LOGTO_ENDPOINT?.trim().replace(/\/$/, '')
  const clientId = env.LOGTO_CLIENT_ID?.trim()
  const clientSecret = env.LOGTO_CLIENT_SECRET?.trim()
  if (!endpoint || !clientId || !clientSecret) return null
  const resource = env.LOGTO_API_RESOURCE?.trim()
  const extraScopes = env.LOGTO_SCOPES?.split(',').map(s => s.trim()).filter(s => s !== '') ?? []
  return {
    endpoint,
    clientId,
    clientSecret,
    ...(resource ? { resource } : {}),
    scopes: ['openid', 'profile', 'email', ...extraScopes],
  }
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

/**
 * OIDC discovery, cached per isolate.
 *
 * The document changes only when the tenant is reconfigured, and it is fetched on
 * every sign-in start otherwise — a needless round trip in front of the redirect.
 */
let cachedConfig: { issuer: string; config: OidcConfigResponse; expiresAt: number } | null = null

/**
 * Drop the discovery and JWKS caches.
 *
 * Exists for tests: both caches are module-level so they survive between cases, and a
 * stale entry would silently answer for a different tenant.
 */
export function resetLogtoCache(): void {
  cachedConfig = null
  cachedJwks = null
}

export async function oidcConfig(config: LogtoConfig): Promise<OidcConfigResponse | null> {
  if (cachedConfig !== null && cachedConfig.issuer === config.endpoint && cachedConfig.expiresAt > Date.now()) {
    return cachedConfig.config
  }
  try {
    const document = await fetchOidcConfig(`${config.endpoint}${discoveryPath}`, requester)
    cachedConfig = { issuer: config.endpoint, config: document, expiresAt: Date.now() + 600_000 }
    return document
  } catch (error) {
    return null
  }
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export interface Pkce { verifier: string; challenge: string }

/**
 * PKCE pair.
 *
 * The SDK's `generateSignInUri` requires a challenge but does not create one, and the
 * verifier has to survive until the callback — so it is stored with the flow row rather
 * than in a cookie, because a phone scanning a code and a desktop browser finishing the
 * flow are different browsers.
 */
export async function createPkce(): Promise<Pkce> {
  const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier))
  return { verifier, challenge: toBase64Url(digest) }
}

// ---------------------------------------------------------------------------
// authorize url
// ---------------------------------------------------------------------------

export async function buildSignInUrl(
  config: LogtoConfig, input: { redirectUri: string; state: string; challenge: string },
): Promise<string | null> {
  const document = await oidcConfig(config)
  if (document === null) return null
  return generateSignInUri({
    authorizationEndpoint: document.authorizationEndpoint,
    clientId: config.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.challenge,
    state: input.state,
    scopes: config.scopes,
    ...(config.resource === undefined ? {} : { resources: [config.resource] }),
    // Always show the picker: this deployment allows a specific account, and a silent
    // SSO could otherwise land on a different Logto session than the user expects.
    prompt: Prompt.Consent,
  })
}

// ---------------------------------------------------------------------------
// code exchange
// ---------------------------------------------------------------------------

export interface LogtoTokens {
  accessToken: string
  idToken?: string
  refreshToken?: string
  expiresIn: number
}

export async function exchange(
  config: LogtoConfig, input: { code: string; redirectUri: string; verifier: string },
): Promise<LogtoTokens | null> {
  const document = await oidcConfig(config)
  if (document === null) return null
  try {
    const response = await fetchTokenByAuthorizationCode({
      clientId: config.clientId,
      tokenEndpoint: document.tokenEndpoint,
      redirectUri: input.redirectUri,
      codeVerifier: input.verifier,
      code: input.code,
      ...(config.resource === undefined ? {} : { resource: config.resource }),
    }, requester)
    if (typeof response.accessToken !== 'string' || response.accessToken === '') return null
    return {
      accessToken: response.accessToken,
      expiresIn: typeof response.expiresIn === 'number' ? response.expiresIn : 3600,
      ...(typeof response.idToken === 'string' ? { idToken: response.idToken } : {}),
      ...(typeof response.refreshToken === 'string' ? { refreshToken: response.refreshToken } : {}),
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// id_token verification
// ---------------------------------------------------------------------------

interface Jwk {
  kid?: string
  kty: string
  n?: string
  e?: string
  alg?: string
  use?: string
}

let cachedJwks: { uri: string; keys: Jwk[]; expiresAt: number } | null = null

async function jwks(uri: string): Promise<Jwk[] | null> {
  if (cachedJwks !== null && cachedJwks.uri === uri && cachedJwks.expiresAt > Date.now()) {
    return cachedJwks.keys
  }
  try {
    const response = await fetch(uri, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return null
    const body = await response.json() as { keys?: unknown }
    if (!Array.isArray(body.keys)) return null
    const keys = body.keys.filter((key): key is Jwk =>
      typeof key === 'object' && key !== null && typeof (key as Jwk).kty === 'string')
    cachedJwks = { uri, keys, expiresAt: Date.now() + 600_000 }
    return keys
  } catch {
    return null
  }
}

function base64UrlToBytes(value: string): Uint8Array { return fromBase64Url(value) }

/**
 * Verify an id_token and return its claims.
 *
 * Steps that must all pass, in this order:
 *   1. the token has three parts and a known `alg` (never `none`)
 *   2. the signature verifies against the tenant's JWKS, using the matching `kid`
 *   3. `iss` equals the discovered issuer
 *   4. `aud` contains this client id
 *   5. `exp` is in the future and `iat` is not in the future
 *
 * Returns null on any failure. Nothing here trusts the token's contents before the
 * signature has been checked — decoding first and validating later is how
 * "verification" gets skipped by accident.
 */
export async function verifyIdToken(
  config: LogtoConfig, idToken: string, now = Date.now(),
): Promise<IdTokenClaims | null> {
  const parts = idToken.split('.')
  if (parts.length !== 3) return null
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string]

  let header: { alg?: unknown; kid?: unknown }
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedHeader))) as typeof header
  } catch { return null }
  // `none` would mean "no signature"; RS256 is what Logto signs with.
  if (header.alg !== 'RS256') return null

  const document = await oidcConfig(config)
  if (document === null) return null
  const keys = await jwks(document.jwksUri)
  if (keys === null) return null

  const candidate = typeof header.kid === 'string'
    ? keys.find(key => key.kid === header.kid)
    : keys[0]
  if (candidate === undefined || candidate.n === undefined || candidate.e === undefined) return null

  let verified = false
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: candidate.n, e: candidate.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      base64UrlToBytes(encodedSignature),
      encoder.encode(`${encodedHeader}.${encodedPayload}`),
    )
  } catch {
    return null
  }
  if (!verified) return null

  // Only now is the payload worth reading.
  //
  // Decoded by hand rather than through the SDK's `decodeIdToken`, which asserts `aud`
  // is a string: the OIDC spec allows an array, and rejecting those would refuse valid
  // tokens from providers that emit one. The signature above is what makes this safe.
  let claims: IdTokenClaims
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encodedPayload))) as IdTokenClaims
  } catch { return null }
  if (typeof claims !== 'object' || claims === null) return null
  if (typeof claims.iss !== 'string' || typeof claims.sub !== 'string') return null
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') return null
  if (typeof claims.aud !== 'string' && !Array.isArray(claims.aud)) return null

  if (claims.iss !== document.issuer) return null
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audience.includes(config.clientId)) return null
  if (claims.exp * 1000 <= now) return null
  // A token issued in the future is either clock skew or forged; allow a small window.
  if (claims.iat * 1000 > now + 120_000) return null
  return claims
}

/** The account identifier taken from verified claims. */
export function accountFromClaims(claims: IdTokenClaims): string | null {
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : ''
  return email === '' ? null : email
}

/** Accounts allowed to sign in. Defaults to the single configured account. */
export function allowedAccounts(env: Env): string[] {
  const raw = env.OAUTH_ALLOWED_ACCOUNTS?.trim()
  if (!raw) return [env.DSH_SERVER_ACCOUNT.trim().toLowerCase()]
  return raw.split(',').map((entry: string) => entry.trim().toLowerCase()).filter((entry: string) => entry !== '')
}

export function callbackUrl(env: Env): string {
  return `${env.DSH_SERVER_PUBLIC_URL}/api/v1/auth/oauth/logto/callback`
}
