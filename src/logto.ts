/**
 * Logto authorization-code sign-in. The official SDK handles discovery, PKCE
 * parameters and token exchange. JOSE verifies signatures and OIDC claims using
 * the tenant's public JWKS (including its ES384 signing keys).
 */
import {
  discoveryPath, fetchOidcConfig, fetchTokenByAuthorizationCode, generateSignInUri, Prompt,
  type IdTokenClaims, type OidcConfigResponse, type Requester,
} from '@logto/js'
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from 'jose'
import type { Env } from './env.js'
import { sha256Hex, toBase64Url } from './crypto.js'
import type { TenantIdentity } from './store.js'

const encoder = new TextEncoder()

/** SDK requesters return parsed JSON, not Response. Do not follow token redirects. */
const requester: Requester = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const response = await fetch(input, { ...init, redirect: 'manual', signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error(`provider responded ${response.status}`)
  return response.json()
}) as Requester

export interface LogtoConfig {
  endpoint: string
  clientId: string
  clientSecret: string
  resource?: string
  scopes: string[]
}

export function logtoConfig(env: Env): LogtoConfig | null {
  const endpoint = env.LOGTO_ENDPOINT?.trim().replace(/\/$/, '')
  const clientId = env.LOGTO_CLIENT_ID?.trim()
  const clientSecret = env.LOGTO_CLIENT_SECRET?.trim()
  if (!endpoint || !clientId || !clientSecret) return null
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null
  } catch { return null }
  const resource = env.LOGTO_API_RESOURCE?.trim()
  const extraScopes = env.LOGTO_SCOPES?.split(',').map(s => s.trim()).filter(s => s !== '') ?? []
  return { endpoint, clientId, clientSecret, ...(resource ? { resource } : {}), scopes: ['openid', 'profile', 'email', ...extraScopes] }
}

let cachedConfig: { endpoint: string; config: OidcConfigResponse; expiresAt: number } | null = null
let cachedJwks: { uri: string; resolve: ReturnType<typeof createLocalJWKSet>; expiresAt: number } | null = null
export function resetLogtoCache(): void { cachedConfig = null; cachedJwks = null }

export async function oidcConfig(config: LogtoConfig): Promise<OidcConfigResponse | null> {
  if (cachedConfig?.endpoint === config.endpoint && cachedConfig.expiresAt > Date.now()) return cachedConfig.config
  try {
    const document = await fetchOidcConfig(`${config.endpoint}${discoveryPath}`, requester)
    // Discovery is trusted only for the configured tenant. In particular, never
    // send the client secret to an arbitrary token endpoint named in a document.
    if (document.issuer !== `${config.endpoint}/oidc`) return null
    for (const value of [document.authorizationEndpoint, document.tokenEndpoint, document.jwksUri]) {
      const url = new URL(value)
      if (url.origin !== config.endpoint || url.protocol !== 'https:' || url.username || url.password) return null
    }
    cachedConfig = { endpoint: config.endpoint, config: document, expiresAt: Date.now() + 600_000 }
    return document
  } catch { return null }
}

export interface Pkce { verifier: string; challenge: string }
export async function createPkce(): Promise<Pkce> {
  const verifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  return { verifier, challenge: toBase64Url(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))) }
}

export async function buildSignInUrl(
  config: LogtoConfig, input: { redirectUri: string; state: string; challenge: string; nonce: string },
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
    includeReservedScopes: false, // no unnecessary offline_access/refresh token
    extraParams: { nonce: input.nonce },
    ...(config.resource === undefined ? {} : { resources: [config.resource] }),
    prompt: Prompt.Consent,
  })
}

export interface LogtoTokens { accessToken: string; idToken?: string; expiresIn: number }

export async function exchange(
  config: LogtoConfig, input: { code: string; redirectUri: string; verifier: string },
): Promise<LogtoTokens | null> {
  const document = await oidcConfig(config)
  if (document === null) return null
  try {
    // @logto/js intentionally has no clientSecret parameter (browser-friendly).
    // Supply confidential-client authentication only on this token requester.
    const tokenRequester: Requester = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) !== document.tokenEndpoint) throw new Error('unexpected token endpoint')
      const basic = btoa(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`)
      const headers = new Headers(init?.headers)
      headers.set('Authorization', `Basic ${basic}`)
      return requester(url, { ...init, headers })
    }) as Requester
    const response = await fetchTokenByAuthorizationCode({
      clientId: config.clientId, tokenEndpoint: document.tokenEndpoint, redirectUri: input.redirectUri,
      codeVerifier: input.verifier, code: input.code,
      ...(config.resource === undefined ? {} : { resource: config.resource }),
    }, tokenRequester)
    if (typeof response.accessToken !== 'string' || response.accessToken === '') return null
    return { accessToken: response.accessToken,
      expiresIn: typeof response.expiresIn === 'number' ? response.expiresIn : 3600,
      ...(typeof response.idToken === 'string' ? { idToken: response.idToken } : {}),
    }
  } catch { return null }
}

async function jwks(uri: string, force = false) {
  if (!force && cachedJwks?.uri === uri && cachedJwks.expiresAt > Date.now()) return cachedJwks.resolve
  try {
    const response = await fetch(uri, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    if (!response.ok) return null
    const body = await response.json() as JSONWebKeySet
    if (!Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > 32) return null
    const resolve = createLocalJWKSet(body)
    cachedJwks = { uri, resolve, expiresAt: Date.now() + 600_000 }
    return resolve
  } catch { return null }
}

/** Verify signature, issuer, audience, time and the nonce bound to this flow. */
export async function verifyIdToken(
  config: LogtoConfig, idToken: string, expectedNonce: string, now = Date.now(),
): Promise<IdTokenClaims | null> {
  if (idToken.length > 32768 || expectedNonce.length < 8) return null
  const document = await oidcConfig(config)
  if (document === null) return null
  for (let attempt = 0; attempt < 2; attempt++) {
    const resolve = await jwks(document.jwksUri, attempt === 1)
    if (resolve === null) return null
    try {
      const { payload } = await jwtVerify(idToken, resolve, {
        issuer: document.issuer, audience: config.clientId,
        algorithms: ['ES384', 'ES256', 'RS256'], currentDate: new Date(now),
        requiredClaims: ['iss', 'sub', 'aud', 'iat', 'exp', 'nonce'],
      })
      if (!payload.sub || typeof payload.iat !== 'number' || !Number.isFinite(payload.iat)
        || payload.iat * 1000 > now + 120_000 || payload.nonce !== expectedNonce) return null
      const audiences = typeof payload.aud === 'string' ? [payload.aud] : payload.aud
      if (!audiences || audiences.some(a => typeof a !== 'string')) return null
      if ((audiences.length > 1 && payload.azp !== config.clientId)
        || (payload.azp !== undefined && payload.azp !== config.clientId)) return null
      return payload as unknown as IdTokenClaims
    } catch (error) {
      // A rotating tenant key may be absent from a cached set. One refresh is
      // enough; never retry bad signatures/claims or downgrade verification.
      if (attempt === 0 && (error as { code?: string }).code === 'ERR_JWKS_NO_MATCHING_KEY') continue
      return null
    }
  }
  return null
}

/** Only an explicitly verified email is eligible for the deployment allowlist. */
export function accountFromClaims(claims: IdTokenClaims): string | null {
  if (claims.email_verified !== true) return null
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : ''
  return /^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/.test(email) ? email : null
}

/**
 * Derive tenant identity only after verifyIdToken has authenticated the claims.
 * Email is mutable display/admission data; the namespace must depend on the exact
 * issuer + subject pair, never on an email address or a request parameter.
 */
export async function identityFromClaims(claims: IdTokenClaims): Promise<TenantIdentity | null> {
  const account = accountFromClaims(claims)
  if (account === null || typeof claims.iss !== 'string' || typeof claims.sub !== 'string'
    || claims.iss === '' || claims.sub.trim() === '' || /[\u0000-\u001f\u007f]/.test(claims.sub)) return null
  try {
    const issuerUrl = new URL(claims.iss)
    if (issuerUrl.protocol !== 'https:' || issuerUrl.username || issuerUrl.password
      || issuerUrl.search || issuerUrl.hash) return null
  } catch { return null }
  return {
    tenantId: await sha256Hex(JSON.stringify(['oidc-v1', claims.iss, claims.sub])),
    account,
    issuer: claims.iss,
    subject: claims.sub,
  }
}

export function allowedAccounts(env: Env): string[] {
  const raw = env.OAUTH_ALLOWED_ACCOUNTS?.trim()
  return raw ? raw.split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean) : [env.DSH_SERVER_ACCOUNT.trim().toLowerCase()]
}
export function callbackUrl(env: Env): string { return `${env.DSH_SERVER_PUBLIC_URL}/api/v1/auth/oauth/logto/callback` }
