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
import { assertConfigured, verifyCredentials } from './auth.js'
import { signSession, sha256Hex, verifySession, toBase64Url } from './crypto.js'
import { turnIceServers } from './turn.js'
import { isDeviceId, isIdentityKey } from './protocol.js'
import type { Result } from './result.js'

// Durable Object classes must be exported from the entrypoint module so the
// runtime can construct them; the binding name in wrangler.jsonc maps to this.
export { Gateway } from './gateway.js'

/** Shapes the Gateway RPCs return, declared here so the Worker can annotate them. */
interface TokenPair {
  accessToken: string; refreshToken: string
  accessTokenExpiresAt: number; refreshTokenExpiresAt: number
}
interface AuthenticatedDevice {
  deviceId: string; role: 'host' | 'client'; name: string; platform: string
  identityKey: string; clientVersion: string; harnessVersion: string | null
  revoked: boolean; lastSeenAt: number
}
interface DeviceSummary {
  deviceId: string; role: string; name: string; platform: string; clientVersion: string
  harnessVersion: string | null; lastSeenAt: number; online: boolean
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

    // --- WebSocket: validate cheaply here, then hand to the DO --------------
    // Validation happens in the Worker on purpose: Cloudflare bills Durable Object
    // requests, so rejecting a bad upgrade before the hop is the difference between
    // a free 403 and a billed one.
    if (url.pathname === '/ws/v1/connect') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return errorResponse('INVALID_MESSAGE', 426)
      }
      // Origin must match the public URL. A non-browser client (the Host plugin via
      // Node's WebSocket) sends no Origin at all, which is fine: the access token in
      // the hello frame is what authenticates it.
      const origin = request.headers.get('Origin')
      if (origin !== null && origin !== env.DSH_SERVER_PUBLIC_URL) {
        return errorResponse('AUTH_INVALID', 403)
      }
      // Credentials travel in the hello frame, never in the URL.
      if (url.search !== '') return errorResponse('INVALID_MESSAGE', 403)
      return env.GATEWAY.getByName('gateway').fetch(request)
    }

    if (url.pathname === '/healthz' || url.pathname === '/health' || url.pathname === '/ready') {
      return Response.json({ status: 'ok' })
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
  },
} satisfies ExportedHandler<Env>

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

  // Cross-site requests are rejected before anything else, matching the reference
  // server's Origin guard.
  const origin = request.headers.get('Origin')
  if (origin !== null && origin !== env.DSH_SERVER_PUBLIC_URL) {
    throw new ApiError('AUTH_INVALID', 403)
  }
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') {
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
    })
  }

  if (method === 'POST' && path === '/api/v1/auth/logout') {
    return Response.json({ status: 'ok' }, {
      headers: { 'Set-Cookie': cookieHeader(env, '', 0) },
    })
  }

  if (method === 'POST' && path === '/api/v1/devices/register') {
    await requireSession(request, env)
    return registerDevice(request, env)
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
    await callGateway<void>(env, 'revokeDevice', [device.deviceId])
    return Response.json({ status: 'revoked' })
  }

  if (method === 'GET' && path === '/api/v1/me') {
    const device = await requireDevice(request, env)
    return Response.json(descriptor(device))
  }

  if (method === 'GET' && path === '/api/v1/account/devices') {
    await requireSession(request, env)
    const devices = await callGateway<DeviceSummary[]>(env, 'listDevices', [])
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
        membershipId: membershipId(env),
      })),
      serverUrl: env.DSH_SERVER_PUBLIC_URL,
      transport: 'webrtc',
    })
  }

  if (method === 'GET' && path === '/api/v1/devices') {
    const device = await requireDevice(request, env)
    if (device.role !== 'client') throw new ApiError('MEMBERSHIP_REQUIRED', 403)
    const devices = await callGateway<DeviceSummary[]>(env, 'listDevices', [])
    return Response.json({
      items: devices
        .filter(entry => entry.role === 'host')
        .map(entry => ({
          deviceId: entry.deviceId,
          name: entry.name,
          role: entry.role,
          platform: entry.platform,
          clientVersion: entry.clientVersion,
          harnessVersion: entry.harnessVersion,
          online: entry.online,
          lastSeenAt: entry.lastSeenAt,
          membershipId: membershipId(env),
        })),
      nextCursor: null,
    })
  }

  if (method === 'GET' && path === '/api/v1/turn/credentials') {
    const device = await requireDevice(request, env)
    const connectionId = url.searchParams.get('connection_id') ?? ''
    if (connectionId === '' || connectionId.length > 128) throw new ApiError('INVALID_MESSAGE', 400)
    // Only the two ends of a link still being established may obtain credentials.
    const allowed = await callGateway<boolean>(env, 'authorizeTurn', [device.deviceId, connectionId])
    if (!allowed) throw new ApiError('CONNECTION_NOT_FOUND', 404)
    const iceServers = await turnIceServers(env, device.deviceId)
    return Response.json({ iceServers: iceServers ?? [] })
  }

  const renameMatch = /^\/api\/v1\/devices\/([^/]+)\/name$/.exec(path)
  if (method === 'POST' && renameMatch !== null) {
    await requireSession(request, env)
    const body = await readJson(request)
    const name = requireString(body, 'name', 80).trim()
    if (name === '') throw new ApiError('INVALID_MESSAGE', 400)
    await callGateway<void>(env, 'renameDevice', [renameMatch[1]!, name])
    const device = await callGateway<DeviceSummary | null>(env, 'getDevice', [renameMatch[1]!])
    if (device === null) throw new ApiError('DEVICE_NOT_FOUND', 404)
    return Response.json(descriptor(device))
  }

  const deviceMatch = /^\/api\/v1\/devices\/([^/]+)(\/presence)?$/.exec(path)
  if (method === 'GET' && deviceMatch !== null) {
    const source = await requireDevice(request, env)
    const target = await callGateway<DeviceSummary | null>(env, 'getDevice', [deviceMatch[1]!])
    // A device that does not exist and one that belongs to another account are
    // reported identically: any difference is an existence oracle. (Single-account
    // makes the second case impossible today, but the shape must not regress.)
    if (target === null) throw new ApiError('DEVICE_NOT_FOUND', 404)
    if (source.role === target.role) throw new ApiError('MEMBERSHIP_REQUIRED', 403)
    const full = descriptor(target)
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

  // The session is a signed cookie, so validating it never reaches the DO.
  const expiresAt = Date.now() + SESSION_TTL_MS
  const token = await signSession(sessionSecret(env), { account: outcome.account, expiresAt })

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

async function requireSession(request: Request, env: Env): Promise<{ account: string }> {
  // A device bearer is not a session: mixing the two authorities would let a
  // paired device manage the whole account.
  const token = sessionCookie(request) ?? bearer(request)
  if (token === null) throw new ApiError('ACCOUNT_AUTH_REQUIRED', 401)
  const session = await verifySession(sessionSecret(env), token)
  if (session === null) throw new ApiError('ACCOUNT_AUTH_REQUIRED', 401)
  return { account: session.account }
}

async function requireDevice(request: Request, env: Env): Promise<{
  deviceId: string; role: 'host' | 'client'; name: string; platform: string
  identityKey: string; clientVersion: string; harnessVersion: string | null
  online: boolean; lastSeenAt: number
}> {
  const token = bearer(request)
  if (token === null) throw new ApiError('AUTH_REQUIRED', 401)
  const result = await callGateway<Result<AuthenticatedDevice>>(env, 'authenticateDevice', [token])
  if (!result.ok) throw new ApiError(result.code, result.status)
  const device = result.value
  const online = await callGateway<DeviceSummary | null>(env, 'getDevice', [device.deviceId])
    .then(entry => entry?.online ?? false)
  return { ...device, online }
}

function cookieHeader(env: Env, value: string, maxAgeSeconds: number): string {
  const secure = env.DSH_SERVER_PUBLIC_URL.startsWith('https:') ? '; Secure' : ''
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`
}

// ---------------------------------------------------------------------------
// devices
// ---------------------------------------------------------------------------

async function registerDevice(request: Request, env: Env): Promise<Response> {
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

  const issued = await callGateway<Result<TokenPair>>(env, 'registerDevice', [{
    deviceId, role, name, platform, identityKey, clientVersion,
    ...(typeof harnessVersion === 'string' ? { harnessVersion } : {}),
  }])
  if (!issued.ok) throw new ApiError(issued.code, issued.status)
  return Response.json(issued.value)
}

function descriptor(device: {
  deviceId: string; role: string; name: string; platform: string; clientVersion: string
  harnessVersion?: string | null; online?: boolean; lastSeenAt?: number
}): Record<string, unknown> {
  return {
    deviceId: device.deviceId,
    name: device.name,
    role: device.role,
    platform: device.platform,
    clientVersion: device.clientVersion,
    ...(device.harnessVersion != null ? { harnessVersion: device.harnessVersion } : {}),
    ...(device.online !== undefined ? { online: device.online } : {}),
    ...(device.lastSeenAt !== undefined ? { lastSeenAt: device.lastSeenAt } : {}),
  }
}

/** Stable account handle the clients show in the device list. */
function membershipId(env: Env): string {
  // Not a security boundary: it is a display id. Derived from the account name so
  // it stays stable across restarts without a database read.
  let hashValue = 0
  const source = `account:${env.DSH_SERVER_ACCOUNT}`
  for (let i = 0; i < source.length; i += 1) {
    hashValue = (Math.imul(hashValue, 31) + source.charCodeAt(i)) >>> 0
  }
  return `account:${hashValue.toString(16).padStart(8, '0')}`
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
