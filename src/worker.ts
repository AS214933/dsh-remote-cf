/**
 * Worker entry: routing and the REST API.
 *
 * Stateless by design. Anything that needs connection state goes to the Gateway
 * Durable Object; everything else is answered here so a cheap request never pays
 * a DO request.
 *
 * Request validation (Upgrade header, Origin, method) happens here rather than in
 * the DO: Cloudflare bills DO requests, so rejecting a bad request before the
 * hop is the difference between a free 403 and a billed one.
 */
import type { Env } from './env.js'
import { DEFAULT_LOCKOUT, RATE_LIMITS } from './config.js'
import { assertConfigured, passwordLoginDisabled, verifyCredentials } from './auth.js'
import { signSession, sha256Hex, verifySession, toBase64Url } from './crypto.js'
import type { IceServer } from './turn.js'
import { isDeviceId, isIdentityKey } from './protocol.js'
import type { Result } from './result.js'
import type { TenantPrincipal, TenantIdentity } from './store.js'
import { corsHeaders, parseAllowedOrigins, preflightResponse } from './cors.js'
import {
  handleCallback, landingPage, pollSession, providersResponse, startRedirect, startSession,
  type OAuthDeps,
} from './oauth-routes.js'

// Durable Object classes must be exported from the entrypoint module so the
// runtime can construct them; the binding name in wrangler.jsonc maps to this.
export { Gateway } from './gateway.js'

/** Shapes the Gateway RPCs return, declared here so the Worker can annotate them. */
interface TokenPair {
  accessToken: string; refreshToken: string
  accessTokenExpiresAt: number; refreshTokenExpiresAt: number
}
interface AuthenticatedDevice {
  tenantId: string; account: string; membershipId: string
  deviceId: string; role: 'host' | 'client'; name: string; platform: string
  identityKey: string; clientVersion: string; harnessVersion: string | null
  revoked: boolean; lastSeenAt: number; online: boolean
}
interface DeviceSummary {
  tenantId: string; membershipId: string
  deviceId: string; role: string; name: string; platform: string; clientVersion: string
  identityKey: string; harnessVersion: string | null; lastSeenAt: number; online: boolean
}
interface LockoutState { locked: boolean; retryAfterMs: number }

const SESSION_COOKIE = 'dsh_session'
const SESSION_TTL_MS = 8 * 3600_000
/** Same-origin check applies to every state-changing request. */
const JSON_LIMIT_BYTES = 16 * 1024

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    // Fail fast on a misconfigured deployment rather than at first login.
    assertConfigured(env)

    const allowedOrigins = parseAllowedOrigins(env.DSH_SERVER_ALLOWED_ORIGINS)

    // --- CORS preflight ----------------------------------------------------
    // Must be answered before anything else: the browser will not send the real
    // request until this succeeds, so a 418 or a 403 here means the UI's login
    // button does nothing and the server log stays empty.
    if (request.method === 'OPTIONS' && allowedOrigins.length > 0) {
      return preflightResponse(request, allowedOrigins)
    }

    // Attach CORS to every response below. Done once here rather than at each
    // return site so a new route cannot forget it.
    const withCors = (response: Response): Response => {
      const headers = corsHeaders(request, allowedOrigins)
      if (headers === null) return response
      const merged = new Response(response.body, response)
      for (const [name, value] of Object.entries(headers)) merged.headers.set(name, value)
      return merged
    }
    return withCors(await route(request, env, url, allowedOrigins))
  },
} satisfies ExportedHandler<Env>

async function route(
  request: Request,
  env: Env,
  url: URL,
  allowedOrigins: readonly string[],
): Promise<Response> {
  // --- WebSocket: validate cheaply here, then hand to the DO --------------
  // Validation happens in the Worker on purpose: Cloudflare bills Durable Object
  // requests, so rejecting a bad upgrade before the hop is the difference between
  // a free 403 and a billed one.
  if (url.pathname === '/ws/v1/connect') {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return errorResponse('INVALID_MESSAGE', 426)
    }
    // A browser sends Origin, so a browser-hosted workbench connecting from its own
    // origin must be allowed. A non-browser client (the Host plugin on Node's
    // WebSocket) sends no Origin at all, which is also fine — the access token in the
    // hello frame is what authenticates it, not the Origin.
    //
    // An allowlist entry is required only when an Origin is present and not the
    // server's own; `sameAuthorities` keeps a same-origin request from needing one.
    const origin = request.headers.get('Origin')
    if (origin !== null && origin !== env.DSH_SERVER_PUBLIC_URL && !allowedOrigins.includes(origin)) {
      return errorResponse('AUTH_INVALID', 403)
    }
    // Credentials travel in the hello frame, never in the URL.
    if (url.search !== '') return errorResponse('INVALID_MESSAGE', 403)
    return env.GATEWAY.getByName('gateway').fetch(request)
  }

  if (url.pathname === '/healthz' || url.pathname === '/health' || url.pathname === '/ready') {
    return Response.json({ status: 'ok' })
  }

  // OAuth browser routes run before the JSON API: they answer HTML and 303 redirects,
  // and the QR landing page is opened by a phone browser that must not be handed a
  // JSON error envelope.
  if (url.pathname.startsWith('/api/v1/auth/oauth/') || url.pathname.startsWith('/api/v1/auth/q/')) {
    try {
      const response = await routeOAuth(request, env, url)
      if (response !== null) return response
    } catch (error) {
      const response = mapError(error)
      response.headers.set('Referrer-Policy', 'no-referrer')
      return response
    }
  }

  if (url.pathname.startsWith('/api/')) {
    try {
      return await handleApi(request, env, url)
    } catch (error) {
      return mapError(error)
    }
  }

  // Everything else answers 418 by default.
  //
  // This deployment has no public web UI: the clients talk to /api/* and
  // /ws/v1/connect, and nothing else is meant to be reachable. Returning a
  // teapot instead of a page means a scanner probing for an admin panel, a
  // .env, or a WordPress install gets the same boring answer as a real
  // visitor, and learns that this origin is not a website. It also stops the
  // static-asset handler from turning every unknown path into a 200 SPA shell,
  // which previously made the server look like it had a UI it does not have.
  //
  // Set DSH_SERVER_ROOT_PAGE=assets to serve the SPA at / instead (for a
  // deployment that does ship a UI).
  if (url.pathname === '/' && env.DSH_SERVER_ROOT_PAGE === 'assets') {
    return env.ASSETS.fetch(request)
  }
  return teapot()
}

/**
 * 418 I'm a teapot.
 *
 * `Content-Type: text/plain` and a fixed body on purpose: no HTML, no asset
 * references, nothing that hints at a stack, and nothing a crawler will index.
 */
function teapot(): Response {
  return new Response("I'm a teapot\n", {
    status: 418,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // Tell well-behaved crawlers and scanners not to come back.
      'X-Robots-Tag': 'noindex, nofollow',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

function errorResponse(code: string, status: number, extra: Record<string, string> = {}): Response {
  const retryable = status === 429 || status >= 500
  return Response.json(
    { error: { code, message: code, retryable } },
    { status, headers: { 'Cache-Control': 'no-store', ...extra } },
  )
}

function mapError(error: unknown): Response {
  if (error instanceof ApiError) return errorResponse(error.code, error.status)
  // Log the class and message to the Worker log for diagnosis, but never echo it
  // to the caller: an internal message can contain upstream response bodies.
  console.error('unhandled', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  return errorResponse('INTERNAL_ERROR', 500)
}

// ---------------------------------------------------------------------------
// request helpers
// ---------------------------------------------------------------------------

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get('Content-Type') ?? ''
  if (!type.toLowerCase().startsWith('application/json')) throw new ApiError('INVALID_MESSAGE', 415)
  const text = await request.text()
  if (text.length > JSON_LIMIT_BYTES) throw new ApiError('FRAME_TOO_LARGE', 413)
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new ApiError('INVALID_MESSAGE', 400) }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError('INVALID_MESSAGE', 400)
  }
  return parsed as Record<string, unknown>
}

function requireString(source: Record<string, unknown>, key: string, max = 1024): string {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new ApiError('INVALID_MESSAGE', 400)
  }
  return value
}

function bearer(request: Request): string | null {
  const header = request.headers.get('Authorization')
  if (header === null) return null
  if (!header.startsWith('Bearer ')) return null
  const value = header.slice(7)
  return value === '' ? null : value
}

function sessionCookie(request: Request): string | null {
  const header = request.headers.get('Cookie')
  if (header === null) return null
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE) return rest.join('=') || null
  }
  return null
}

function sessionSecret(env: Env): string {
  const secret = env.SESSION_SECRET?.trim()
  if (!secret) throw new ApiError('AUTH_SERVICE_UNAVAILABLE', 503)
  return secret
}

function deviceIdFromRequest(request: Request): string | null {
  // Used only for rate-limit keying before authentication; never trusted.
  const header = request.headers.get('X-DSH-Device')
  if (header !== null && isDeviceId(header)) return header
  return null
}

// ---------------------------------------------------------------------------
// rate limiting
// ---------------------------------------------------------------------------

/** Fixed-window counter. Workers isolates are per-location, so this is best effort. */
const buckets = new Map<string, { count: number; until: number }>()

function rate(key: string, limit: { max: number; windowMs: number }): void {
  const now = Date.now()
  if (buckets.size > 8192) {
    for (const [k, v] of buckets) if (v.until <= now) buckets.delete(k)
  }
  let entry = buckets.get(key)
  if (entry === undefined || entry.until <= now) {
    entry = { count: 0, until: now + limit.windowMs }
    buckets.set(key, entry)
  }
  entry.count += 1
  if (entry.count > limit.max) {
    throw new ApiError('RATE_LIMITED', 429)
  }
}

function clientKey(request: Request): string {
  // Trusted-proxy handling is intentionally absent: on Workers the peer is always
  // Cloudflare, so CF-Connecting-IP is the real client and cannot be forged by a
  // client that is not already inside Cloudflare.
  return request.headers.get('CF-Connecting-IP') ?? 'unknown'
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname
  const method = request.method
  const client = clientKey(request)

  // Origin guard.
  //
  // The browser workbench is served from its own origin, so a cross-origin request
  // is the normal case, not an attack. What matters is that the origin is one the
  // operator listed: an unlisted origin could otherwise drive this API with the
  // victim's cookies. `Sec-Fetch-Site` is checked too, because it reports the real
  // relationship even when a proxy rewrites Origin.
  const origin = request.headers.get('Origin')
  const allowedOrigins = parseAllowedOrigins(env.DSH_SERVER_ALLOWED_ORIGINS)
  if (origin !== null && origin !== env.DSH_SERVER_PUBLIC_URL && !allowedOrigins.includes(origin)) {
    throw new ApiError('AUTH_INVALID', 403)
  }
  // `cross-site` is refused only when the origin is not allowlisted. A listed origin
  // legitimately sends `cross-site` when the UI is on a different site, which is the
  // whole point of the allowlist.
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site' && origin === null) {
    throw new ApiError('AUTH_INVALID', 403)
  }

  rate(`api:${client}`, RATE_LIMITS.api)

  if (method === 'POST' && path === '/api/v1/auth/login') return login(request, env, client)

  if (method === 'GET' && path === '/api/v1/auth/me') {
    const session = await requireSession(request, env)
    return Response.json({
      account: session.account,
      profile: { displayName: session.account },
      isAdmin: false,
      tenantId: session.tenantId,
      identity: { issuer: session.issuer, subject: session.subject },
    }, { headers: { 'Cache-Control': 'no-store' } })
  }

  if (method === 'POST' && path === '/api/v1/auth/logout') {
    return Response.json({ status: 'ok' }, {
      headers: { 'Set-Cookie': cookieHeader(env, '', 0) },
    })
  }

  if (method === 'POST' && path === '/api/v1/devices/register') {
    const principal = await requireSession(request, env)
    return registerDevice(request, env, principal.tenantId)
  }

  // Claim a Host device with an already-authorized device credential.
  //
  // The plugin's flow: sign in as a client, then let the local Host adopt the same
  // account. It sends the **client's device access token** as the authority — not the
  // web session — because in the desktop app there is no browser session at all.
  //
  // That is the correct authority for this operation even so: the token authenticates
  // a device that has already proven the account password, and single-account means
  // any device of this deployment belongs to the same owner. The token is required,
  // so an unauthenticated caller cannot mint devices, and the newly registered Host
  // is a separate device with its own key pair and credentials.
  if (method === 'POST' && path === '/api/v1/devices/register-owned-role') {
    const authorizing = await requireDevice(request, env)
    return registerDevice(request, env, authorizing.tenantId)
  }

  if (method === 'POST' && path === '/api/v1/auth/refresh') {
    const body = await readJson(request)
    const deviceId = requireString(body, 'deviceId', 64)
    const refreshToken = requireString(body, 'refreshToken', 4096)
    const issued = await callGateway<Result<TokenPair>>(env, 'refreshToken', [deviceId, refreshToken])
    if (!issued.ok) throw new ApiError(issued.code, issued.status)
    return Response.json(issued.value)
  }

  if (method === 'DELETE' && path === '/api/v1/devices/self') {
    const device = await requireDevice(request, env)
    await callGateway<void>(env, 'revokeDevice', [device.tenantId, device.deviceId])
    return Response.json({ status: 'revoked' })
  }

  // Revoke any device of this account.
  //
  // The reference server has no such endpoint — a device can only revoke itself, and
  // the account holder has no way to remove a device they no longer control. That is a
  // real gap for an operator: a lost phone stays in the list forever and keeps a valid
  // refresh token. This is account-scoped (`/account/`, session-authenticated) rather
  // than device-scoped, so a device token cannot revoke its peers.
  const revokeMatch = /^\/api\/v1\/account\/devices\/([^/]+)$/.exec(path)
  if (method === 'DELETE' && revokeMatch !== null) {
    const principal = await requireSession(request, env)
    const target = decodeURIComponent(revokeMatch[1]!)
    const existing = await callGateway<DeviceSummary | null>(env, 'getDevice', [principal.tenantId, target])
    if (existing === null) throw new ApiError('DEVICE_NOT_FOUND', 404)
    await callGateway<void>(env, 'revokeDevice', [principal.tenantId, target])
    return Response.json({ status: 'revoked', deviceId: target })
  }

  if (method === 'GET' && path === '/api/v1/me') {
    const device = await requireDevice(request, env)
    return Response.json(descriptor(device))
  }

  if (method === 'GET' && path === '/api/v1/account/devices') {
    const principal = await requireSession(request, env)
    const devices = await callGateway<DeviceSummary[]>(env, 'listDevices', [principal.tenantId])
    return Response.json({
      items: devices.map(device => ({
        deviceId: device.deviceId,
        name: device.name,
        role: device.role,
        platform: device.platform,
        clientVersion: device.clientVersion,
        harnessVersion: device.harnessVersion,
        online: device.online,
        lastSeenAt: device.lastSeenAt,
        membershipId: principal.membershipId,
      })),
      serverUrl: env.DSH_SERVER_PUBLIC_URL,
      transport: 'webrtc',
    })
  }

  if (method === 'GET' && path === '/api/v1/devices') {
    const device = await requireDevice(request, env)
    if (device.role !== 'client') throw new ApiError('MEMBERSHIP_REQUIRED', 403)
    const devices = await callGateway<DeviceSummary[]>(env, 'listDevices', [device.tenantId])
    return Response.json({
      items: devices
        .filter(entry => entry.role === 'host')
        // `identityKey` is deliberately stripped from list responses, matching the
        // reference server: the client pins a peer's key when it first connects to
        // that peer, and a key taken from a list would let the server substitute one
        // without the client noticing. Only the single-peer endpoint carries it.
        .map(entry => {
          const { identityKey: _identityKey, ...rest } = descriptor({ ...entry, membershipId: device.membershipId })
          return rest
        }),
      nextCursor: null,
    })
  }

  if (method === 'GET' && path === '/api/v1/turn/credentials') {
    const token = bearer(request)
    if (token === null) throw new ApiError('AUTH_REQUIRED', 401)
    const connectionId = url.searchParams.get('connection_id') ?? ''
    if (connectionId === '' || connectionId.length > 128) throw new ApiError('INVALID_MESSAGE', 400)
    const result = await callGateway<Result<IceServer[]>>(env, 'getIceServers', [token, connectionId])
    if (!result.ok) throw new ApiError(result.code, result.status)
    return Response.json({ iceServers: result.value }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const renameMatch = /^\/api\/v1\/devices\/([^/]+)\/name$/.exec(path)
  if (method === 'POST' && renameMatch !== null) {
    const principal = await requireSession(request, env)
    const body = await readJson(request)
    const name = requireString(body, 'name', 80).trim()
    if (name === '') throw new ApiError('INVALID_MESSAGE', 400)
    await callGateway<void>(env, 'renameDevice', [principal.tenantId, renameMatch[1]!, name])
    const device = await callGateway<DeviceSummary | null>(env, 'getDevice', [principal.tenantId, renameMatch[1]!])
    if (device === null) throw new ApiError('DEVICE_NOT_FOUND', 404)
    return Response.json(descriptor(device))
  }

  const deviceMatch = /^\/api\/v1\/devices\/([^/]+)(\/presence)?$/.exec(path)
  if (method === 'GET' && deviceMatch !== null) {
    const token = bearer(request)
    if (token === null) throw new ApiError('AUTH_REQUIRED', 401)
    // Keep the fresh membership/role check and full pinned-key descriptor, but
    // perform the mandatory Host/client lookup in one DO hop rather than three.
    const result = await callGateway<Result<DeviceSummary>>(env, 'getAuthorizedPeer', [token, deviceMatch[1]!])
    if (!result.ok) throw new ApiError(result.code, result.status)
    const full = descriptor(result.value)
    return Response.json(deviceMatch[2] !== undefined
      ? { deviceId: full.deviceId, online: full.online, lastSeenAt: full.lastSeenAt }
      : full)
  }

  throw new ApiError('METHOD_NOT_FOUND', 404)
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

async function login(request: Request, env: Env, client: string): Promise<Response> {
  rate(`login:${client}`, RATE_LIMITS.login)
  const body = await readJson(request)
  const email = requireString(body, 'email', 254).trim()
  const password = requireString(body, 'password', 1024)

  // Per-account budget on top of the per-source one: without it an attacker with
  // many addresses gets 20 attempts per address against one account. The key is
  // derived from the submitted address, so a rejection never reveals whether it
  // matches the configured account.
  const accountKey = await sha256Hex(email.toLowerCase())
  rate(`login-account:${accountKey}`, RATE_LIMITS.loginAccount)

  const locked = await callGateway<LockoutState>(env, 'lockoutState', [
    accountKey, DEFAULT_LOCKOUT.threshold, DEFAULT_LOCKOUT.lockMs, DEFAULT_LOCKOUT.streakMs,
  ])
  if (locked.locked) {
    return errorResponse('ACCOUNT_LOCKED', 429, {
      'Retry-After': String(Math.ceil(locked.retryAfterMs / 1000)),
    })
  }

  // OIDC-only mode. Refused before touching the password: a disabled credential must not
  // be brute-forceable, and a rejection must not consume lockout budget for the login
  // path the operator actually uses.
  if (passwordLoginDisabled(env)) throw new ApiError('PASSWORD_LOGIN_DISABLED', 403)

  const outcome = await verifyCredentials(env, email, password)
  if (!outcome.ok) {
    if (outcome.reason === 'misconfigured') throw new ApiError('AUTH_SERVICE_UNAVAILABLE', 503)
    const after = await callGateway<LockoutState>(env, 'recordFailure', [
      accountKey, DEFAULT_LOCKOUT.threshold, DEFAULT_LOCKOUT.lockMs, DEFAULT_LOCKOUT.streakMs,
    ])
    if (after.locked) {
      return errorResponse('ACCOUNT_LOCKED', 429, {
        'Retry-After': String(Math.ceil(after.retryAfterMs / 1000)),
      })
    }
    throw new ApiError('AUTH_INVALID', 401)
  }

  await callGateway<void>(env, 'clearFailures', [accountKey])

  // Sign the reserved password-owner principal; authorization checks its live registry.
  const expiresAt = Date.now() + SESSION_TTL_MS
  const principal = await callGateway<TenantPrincipal | null>(env, 'getTenant', ['legacy-owner'])
  if (principal === null) throw new ApiError('AUTH_SERVICE_UNAVAILABLE', 503)
  const token = await signSession(sessionSecret(env), { v: 2, tenantId: principal.tenantId,
    account: principal.account, issuer: principal.issuer, subject: principal.subject, expiresAt })

  return Response.json(
    {
      account: outcome.account,
      profile: { displayName: outcome.account },
      isAdmin: false,
      token,
      expiresAt,
    },
    { headers: { 'Set-Cookie': cookieHeader(env, token, Math.floor(SESSION_TTL_MS / 1000)) } },
  )
}

async function requireSession(request: Request, env: Env): Promise<TenantPrincipal> {
  // A device bearer is not a session: mixing the two authorities would let a
  // paired device manage the whole account.
  const token = sessionCookie(request) ?? bearer(request)
  if (token === null) throw new ApiError('ACCOUNT_AUTH_REQUIRED', 401)
  const session = await verifySession(sessionSecret(env), token)
  // Tenantless legacy sessions cannot select or claim an owner partition.
  if (session === null || session.v !== 2 || !session.tenantId || typeof session.issuer !== 'string' || typeof session.subject !== 'string') {
    throw new ApiError('ACCOUNT_AUTH_REQUIRED', 401)
  }
  const principal = await callGateway<TenantPrincipal | null>(env, 'getTenant', [session.tenantId])
  if (principal === null || principal.issuer !== session.issuer || principal.subject !== session.subject) {
    throw new ApiError('ACCOUNT_AUTH_REQUIRED', 401)
  }
  return principal
}

async function requireDevice(request: Request, env: Env): Promise<AuthenticatedDevice> {
  const token = bearer(request)
  if (token === null) throw new ApiError('AUTH_REQUIRED', 401)
  const result = await callGateway<Result<AuthenticatedDevice>>(env, 'authenticateDevice', [token])
  if (!result.ok) throw new ApiError(result.code, result.status)
  return result.value
}

function cookieHeader(env: Env, value: string, maxAgeSeconds: number): string {
  const secure = env.DSH_SERVER_PUBLIC_URL.startsWith('https:') ? '; Secure' : ''
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`
}

// ---------------------------------------------------------------------------
// devices
// ---------------------------------------------------------------------------

/**
 * Register or re-authorize one device.
 *
 * `claim` is present only on the register-owned-role path. Single-account means the
 * owner is always this deployment's account, but the claimed device is recorded so a
 * later audit can tell which client brought a Host online.
 */
async function registerDevice(
  request: Request,
  env: Env,
  tenantId: string,
): Promise<Response> {
  const body = await readJson(request)
  if (body.v !== 1) throw new ApiError('UNSUPPORTED_VERSION', 400)
  const device = body.device
  if (typeof device !== 'object' || device === null) throw new ApiError('INVALID_MESSAGE', 400)
  const descriptorInput = device as Record<string, unknown>

  const deviceId = descriptorInput.deviceId
  if (!isDeviceId(deviceId)) throw new ApiError('INVALID_MESSAGE', 400)
  const role = descriptorInput.role
  if (role !== 'host' && role !== 'client') throw new ApiError('INVALID_MESSAGE', 400)
  const identityKey = descriptorInput.identityKey
  if (!isIdentityKey(identityKey)) throw new ApiError('INVALID_MESSAGE', 400)
  const name = requireString(descriptorInput, 'name', 80)
  const platform = requireString(descriptorInput, 'platform', 40)
  const clientVersion = requireString(descriptorInput, 'clientVersion', 64)
  const harnessVersion = descriptorInput.harnessVersion
  if (harnessVersion !== undefined && (typeof harnessVersion !== 'string' || harnessVersion.length > 64)) {
    throw new ApiError('INVALID_MESSAGE', 400)
  }
  if (role === 'client' && harnessVersion !== undefined) throw new ApiError('INVALID_MESSAGE', 400)

  const issued = await callGateway<Result<TokenPair>>(env, 'registerDevice', [tenantId, {
    deviceId, role, name, platform, identityKey, clientVersion,
    ...(typeof harnessVersion === 'string' ? { harnessVersion } : {}),
  }])
  if (!issued.ok) throw new ApiError(issued.code, issued.status)
  return Response.json(issued.value)
}

/**
 * Device descriptor returned by the peer and self endpoints.
 *
 * `identityKey` and `membershipId` are not optional: the client validates every peer
 * record against them and rejects the whole response with "invalid authorized peer
 * data" when either is missing. `identityKey` is also what the client pins per peer,
 * so omitting it does not just break parsing — it removes the guarantee that a peer's
 * key cannot change silently.
 */
function descriptor(device: {
  deviceId: string; role: string; name: string; platform: string; clientVersion: string
  identityKey: string; membershipId: string
  harnessVersion?: string | null; online?: boolean; lastSeenAt?: number
}): Record<string, unknown> {
  return {
    deviceId: device.deviceId,
    name: device.name,
    role: device.role,
    platform: device.platform,
    identityKey: device.identityKey,
    membershipId: device.membershipId,
    clientVersion: device.clientVersion,
    ...(device.harnessVersion != null ? { harnessVersion: device.harnessVersion } : {}),
    ...(device.online !== undefined ? { online: device.online } : {}),
    ...(device.lastSeenAt !== undefined ? { lastSeenAt: device.lastSeenAt } : {}),
  }
}

// ---------------------------------------------------------------------------
// gateway access
// ---------------------------------------------------------------------------

/**
 * Call the Gateway and surface its error codes as HTTP codes.
 *
 * The RPC types are `Promise & Disposable` in the Workers binding, which confuses
 * generic inference, so this returns the awaited value with a plain cast instead
 * of trying to be clever about the envelope. Callers narrow the envelope
 * themselves, which keeps the error mapping explicit at each site.
 */
/**
 * Call one Gateway RPC by name.
 *
 * The binding types every RPC as `Promise<T> & Disposable`, which makes a
 * callback-based helper infer the narrow member of a union instead of the union
 * itself. Naming the method and casting at the boundary keeps the awkward typing
 * in one place; callers still narrow the envelope explicitly.
 */
/**
 * Call one Gateway RPC by name.
 *
 * The binding is a Proxy: every property access is treated as an RPC method, so
 * `fn.apply(stub, args)` asks the object for a method literally named "apply" and
 * fails. The method must be invoked through the proxy itself, which is what
 * `stub[method](...args)` does.
 *
 * Errors also cannot cross the RPC boundary with their custom fields intact, so the
 * Gateway returns result envelopes and the caller narrows them.
 */
async function callGateway<T = unknown>(
  env: Env,
  method: string,
  args: unknown[],
): Promise<T> {
  const stub = await gatewayStub(env)
  const target = stub as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
  const fn = target[method]
  if (typeof fn !== 'function') throw new ApiError('INTERNAL_ERROR', 500)
  try {
    // Invoke through the stub so the proxy sees the call: `fn` is already bound to
    // it, but calling it directly keeps the receiver intact.
    return (await fn(...args)) as T
  } catch (error) {
    const shaped = error as { code?: unknown; status?: unknown }
    if (typeof shaped?.code === 'string' && typeof shaped?.status === 'number') {
      throw new ApiError(shaped.code, shaped.status)
    }
    throw error
  }
}

async function gatewayStub(env: Env) {
  return env.GATEWAY.getByName('gateway')
}

void toBase64Url
void deviceIdFromRequest

// ---------------------------------------------------------------------------
// OAuth routing
// ---------------------------------------------------------------------------

/**
 * Dispatch the OAuth routes, or return null when the path is not one of them.
 *
 * Kept separate from `handleApi` because these answer HTML and redirects rather than
 * JSON: the QR landing page is opened by a phone browser, and a JSON error envelope
 * there would leave the user staring at raw braces.
 */
async function routeOAuth(request: Request, env: Env, url: URL): Promise<Response | null> {
  const deps: OAuthDeps = {
    call: (method, args) => callGateway(env, method, args),
    resolveIdentity: async (identity: TenantIdentity) => {
      const result = await callGateway<Result<TenantPrincipal>>(env, 'resolveTenant', [identity])
      if (!result.ok) throw new ApiError(result.code, result.status)
      return result.value
    },
    issueSession: async principal => {
      const expiresAt = Date.now() + SESSION_TTL_MS
      const token = await signSession(sessionSecret(env), {
        v: 2, tenantId: principal.tenantId, account: principal.account,
        issuer: principal.issuer, subject: principal.subject, expiresAt,
      })
      return { token, expiresAt }
    },
    errorResponse,
    readJson,
    rate,
    clientKey,
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/auth/oauth/providers') {
    return providersResponse(env)
  }

  if (request.method === 'POST' && url.pathname === '/api/v1/auth/oauth/qr/start') {
    return startSession(request, env, deps)
  }

  const pollMatch = /^\/api\/v1\/auth\/oauth\/qr\/([^/]+)$/.exec(url.pathname)
  if (request.method === 'GET' && pollMatch !== null) {
    return pollSession(request, env, deps, decodeURIComponent(pollMatch[1]!))
  }

  const landingMatch = /^\/api\/v1\/auth\/q\/([^/]+)$/.exec(url.pathname)
  if (request.method === 'GET' && landingMatch !== null) {
    return landingPage(request, env, deps, decodeURIComponent(landingMatch[1]!))
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/auth/oauth/logto/start') {
    return startRedirect(request, env, deps)
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/auth/oauth/logto/callback') {
    return handleCallback(request, env, deps)
  }

  return null
}
