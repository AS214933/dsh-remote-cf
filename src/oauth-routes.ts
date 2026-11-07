/**
 * OAuth HTTP endpoints, backed by Logto.
 *
 * The routes match what the clients expect (verified against the reference server):
 *
 *   GET  /api/v1/auth/oauth/providers            discovery
 *   POST /api/v1/auth/oauth/qr/start             create a session
 *   GET  /api/v1/auth/oauth/qr/{qrId}            poll
 *   GET  /api/v1/auth/q/{qrId}                   QR landing page -> redirect to Logto
 *   GET  /api/v1/auth/oauth/logto/start          direct browser entry
 *   GET  /api/v1/auth/oauth/logto/callback       Logto callback
 *
 * `scanUrl` is not an image: it is the landing page, which redirects. Scanning the code
 * and clicking "open in browser" therefore walk the same path, which is how one
 * implementation serves both the desktop client and a phone.
 */
import type { Env } from './env.js'
import {
  allowedAccounts, buildSignInUrl, callbackUrl, createPkce, exchange,
  identityFromClaims, logtoConfig, verifyIdToken,
} from './logto.js'
import { signState, verifyState, isAllowedReturnTo, stateCookieName } from './oauth.js'
import { toBase64Url, timingSafeEqualString } from './crypto.js'
import type { TenantIdentity, TenantPrincipal } from './store.js'

/** Long enough to scan and authorise, short enough that a leaked code ages out. */
const SESSION_TTL_SECONDS = 600
const PROVIDER_ID = 'logto'
const PROVIDER_LABEL = 'Logto'
const OAUTH_RESPONSE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
}

function jsonResponse(body: unknown): Response {
  return Response.json(body, { headers: OAUTH_RESPONSE_HEADERS })
}

/** Native clients omit Origin; browsers must match the configured public origin. */
function allowedStartOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin')
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false
  if (origin === null) return true
  try { return origin === new URL(env.DSH_SERVER_PUBLIC_URL).origin } catch { return false }
}

export interface OAuthDeps {
  call<T>(method: string, args: unknown[]): Promise<T>
  resolveIdentity(identity: TenantIdentity): Promise<TenantPrincipal>
  issueSession(principal: TenantPrincipal): Promise<{ token: string; expiresAt: number }>
  errorResponse(code: string, status: number, extra?: Record<string, string>): Response
  readJson(request: Request): Promise<Record<string, unknown>>
  rate(key: string, limit: { max: number; windowMs: number }): void
  clientKey(request: Request): string
}

function qrId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
}

/** 303 so the browser follows with GET; 302 would let a POST callback re-POST. */
function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { ...OAUTH_RESPONSE_HEADERS, Location: location, ...headers } })
}

function htmlPage(title: string, body: string, status = 200, headers: Record<string, string> = {}): Response {
  const document = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark}
body{font:16px/1.6 system-ui,-apple-system,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem}
h1{font-size:1.25rem;margin:0 0 .75rem}
p{margin:.5rem 0;opacity:.85}
</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`
  return new Response(document, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // A login page must never be cached or framed.
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      ...headers,
    },
  })
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char
  ))
}

export function oauthConfigured(env: Env): boolean {
  return logtoConfig(env) !== null
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

export function providersResponse(env: Env): Response {
  // An empty list is the correct answer when unconfigured: the client then shows only
  // the password form, which is exactly what this deployment did before.
  if (!oauthConfigured(env)) return jsonResponse({ items: [] })
  return jsonResponse({
    items: [{
      id: PROVIDER_ID,
      displayName: PROVIDER_LABEL,
      startUrl: `/api/v1/auth/oauth/${PROVIDER_ID}/start`,
      qrStartUrl: `/api/v1/auth/oauth/qr/start?provider=${PROVIDER_ID}`,
    }],
  })
}

// ---------------------------------------------------------------------------
// session creation
// ---------------------------------------------------------------------------

export async function startSession(
  request: Request, env: Env, deps: OAuthDeps,
): Promise<Response> {
  if (!allowedStartOrigin(request, env)) {
    return deps.errorResponse('AUTH_INVALID', 403, OAUTH_RESPONSE_HEADERS)
  }
  deps.rate(`oauth-start:${deps.clientKey(request)}`, { max: 30, windowMs: 60_000 })
  if (!oauthConfigured(env)) return deps.errorResponse('OAUTH_PROVIDER_UNAVAILABLE', 404, OAUTH_RESPONSE_HEADERS)

  const url = new URL(request.url)
  const requested = url.searchParams.get('provider') ?? PROVIDER_ID
  if (requested !== PROVIDER_ID) return deps.errorResponse('OAUTH_PROVIDER_UNAVAILABLE', 404, OAUTH_RESPONSE_HEADERS)

  const id = qrId()
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000
  await deps.call<void>('createOAuthSession', [{ qrId: id, provider: PROVIDER_ID, expiresAt }])

  return jsonResponse({
    qrId: id,
    // The client requires this to start with the server origin; it is our landing page.
    scanUrl: `${env.DSH_SERVER_PUBLIC_URL}/api/v1/auth/q/${id}`,
    expiresIn: SESSION_TTL_SECONDS,
    provider: PROVIDER_ID,
  })
}

export async function pollSession(
  request: Request, env: Env, deps: OAuthDeps, qrIdValue: string,
): Promise<Response> {
  deps.rate(`oauth-poll:${deps.clientKey(request)}`, { max: 240, windowMs: 60_000 })
  const session = await deps.call<{
    qrId: string; provider: string; status: string
    account: string | null; isAdmin: number | null; token: string | null; expiresAt: number
  } | null>('getOAuthSession', [qrIdValue])

  // Expiry wins in every phase, including a completed flow not yet collected.
  if (session === null || session.provider !== PROVIDER_ID || session.expiresAt <= Date.now()) {
    return jsonResponse({ status: 'expired' })
  }
  if (session.status === 'pending' || session.status === 'exchanging') {
    return jsonResponse({ status: 'pending' })
  }
  if (session.status !== 'complete') return jsonResponse({ status: 'expired' })

  const taken = await deps.call<{ account: string; isAdmin: boolean; token: string } | null>(
    'takeOAuthToken', [qrIdValue],
  )
  // A completed session whose token was already collected reports expired: the token is
  // single-use, and re-serving it would defeat that.
  if (taken === null) return jsonResponse({ status: 'expired' })
  return jsonResponse({ status: 'complete', token: taken.token })
}

// ---------------------------------------------------------------------------
// browser entries
// ---------------------------------------------------------------------------

/**
 * Landing page for a scanned code.
 *
 * `state` carries the qr id, so the callback knows to complete that session instead of
 * handing a token to a browser.
 */
export async function landingPage(
  request: Request, env: Env, deps: OAuthDeps, qrIdValue: string,
): Promise<Response> {
  const config = logtoConfig(env)
  if (config === null) return htmlPage('登录不可用', '<p>尚未配置登录方式。</p>', 503)

  const session = await deps.call<{
    qrId: string; provider: string; status: string; expiresAt: number
  } | null>('getOAuthSession', [qrIdValue])

  if (session === null || session.provider !== PROVIDER_ID || session.expiresAt <= Date.now()) {
    return htmlPage('登录已过期', '<p>这个二维码已失效，请在客户端重新发起登录。</p>', 410)
  }
  if (session.status === 'complete') {
    return htmlPage('已登录', '<p>授权已完成，可以关闭此页面。</p>')
  }
  if (session.status === 'exchanging') {
    return htmlPage('正在登录', '<p>授权正在处理，请回到客户端等待。</p>')
  }
  if (session.status !== 'pending') {
    return htmlPage('登录已过期', '<p>这个二维码已失效，请在客户端重新发起登录。</p>', 410)
  }

  const pkce = await createPkce()
  // The verifier is stored with the flow, not in a cookie: a phone scans the code while
  // the desktop client polls, so the two are different browsers with different jars.
  const prepared = await deps.call<boolean>('setOAuthPkce', [qrIdValue, pkce.verifier])
  if (!prepared) {
    return htmlPage('登录已开始', '<p>此二维码已被打开或已失效，请完成原页面的授权，或在客户端重新发起登录。</p>', 409)
  }

  const nonce = qrId()
  const state = await signState(env.SESSION_SECRET, {
    providerId: PROVIDER_ID, returnTo: '/app', qrId: qrIdValue, nonce,
  })
  const target = await buildSignInUrl(config, {
    redirectUri: callbackUrl(env), state, challenge: pkce.challenge, nonce,
  })
  if (target === null) return htmlPage('登录不可用', '<p>无法连接认证服务。</p>', 502)
  return redirect(target, { 'Set-Cookie': stateCookie(env, state) })
}

/**
 * Direct browser entry: `/api/v1/auth/oauth/logto/start`.
 *
 * Used by clients that open a URL instead of showing a code. `return_to` decides where
 * the browser ends up; it is validated here and again from the signed state.
 */
export async function startRedirect(
  request: Request, env: Env, deps: OAuthDeps,
): Promise<Response> {
  deps.rate(`oauth-start:${deps.clientKey(request)}`, { max: 30, windowMs: 60_000 })
  const config = logtoConfig(env)
  if (config === null) return htmlPage('登录不可用', '<p>尚未配置登录方式。</p>', 503)

  const url = new URL(request.url)
  const requestedProbe = url.searchParams.get('identity_probe')
  const identityProbe = requestedProbe !== null
  if (identityProbe && (!env.DSH_SERVER_IDENTITY_PROBE_KEY || !env.DSH_SERVER_IDENTITY_EVIDENCE_KEY
    || env.DSH_SERVER_IDENTITY_PROBE_KEY === env.DSH_SERVER_IDENTITY_EVIDENCE_KEY
    || !(await timingSafeEqualString(env.SESSION_SECRET, requestedProbe, env.DSH_SERVER_IDENTITY_PROBE_KEY)))) {
    return htmlPage('身份核验不可用', '<p>核验入口无效或已关闭。</p>', 403)
  }
  const requested = identityProbe ? '/app' : url.searchParams.get('return_to') ?? '/app'
  // Refuse before issuing a state token: an unchecked target would carry the session
  // token to whoever controls it.
  if (!isAllowedReturnTo(requested)) {
    return htmlPage('无效的返回地址', '<p>return_to 不在允许列表内。</p>', 400)
  }

  const pkce = await createPkce()
  const id = qrId()
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000
  // Reuse the session row so the verifier has somewhere to live and the flow stays
  // visible in one table, even though no client is polling for this one.
  await deps.call<void>('createOAuthSession', [{ qrId: id, provider: PROVIDER_ID, expiresAt }])
  const prepared = await deps.call<boolean>('setOAuthPkce', [id, pkce.verifier])
  if (!prepared) return htmlPage('登录已过期', '<p>登录会话已失效，请重新发起。</p>', 410)

  const nonce = qrId()
  const state = await signState(env.SESSION_SECRET, {
    providerId: PROVIDER_ID, returnTo: requested, qrId: null, flowId: id, nonce,
    ...(identityProbe ? { identityProbe: true } : {}),
  })
  const target = await buildSignInUrl(config, {
    redirectUri: callbackUrl(env), state, challenge: pkce.challenge, nonce,
  })
  if (target === null) return htmlPage('登录不可用', '<p>无法连接认证服务。</p>', 502)
  return redirect(target, { 'Set-Cookie': stateCookie(env, state) })
}

function clearStateCookie(env: Env): string {
  return stateCookie(env, '').replace(`Max-Age=${SESSION_TTL_SECONDS}`, 'Max-Age=0')
}

function stateCookie(env: Env, value: string): string {
  return [
    `${stateCookieName(PROVIDER_ID)}=${value}`,
    'Path=/api/v1/auth',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
    ...(env.DSH_SERVER_PUBLIC_URL.startsWith('https:') ? ['Secure'] : []),
  ].join('; ')
}

// ---------------------------------------------------------------------------
// callback
// ---------------------------------------------------------------------------

export async function handleCallback(
  request: Request, env: Env, deps: OAuthDeps,
): Promise<Response> {
  const config = logtoConfig(env)
  if (config === null) return htmlPage('登录不可用', '<p>尚未配置登录方式。</p>', 503)

  const url = new URL(request.url)
  const error = url.searchParams.get('error')
  if (error !== null) {
    const description = url.searchParams.get('error_description') ?? ''
    return htmlPage('授权被拒绝',
      `<p>认证服务返回：<code>${escapeHtml(error)}</code></p>${description === '' ? '' : `<p>${escapeHtml(description)}</p>`}`,
      400)
  }

  const code = url.searchParams.get('code') ?? ''
  const stateToken = url.searchParams.get('state') ?? ''
  if (code === '' || stateToken === '') return htmlPage('授权失败', '<p>回调缺少 code 或 state。</p>', 400)

  const state = await verifyState(env.SESSION_SECRET, stateToken, PROVIDER_ID)
  if (state === null || !isAllowedReturnTo(state.returnTo)) {
    return htmlPage('授权失败', '<p>state 无效或已过期，请重新登录。</p>', 400)
  }

  // Both copies must match. The state travels through the provider and can leak via a
  // referrer; the cookie proves this browser started the flow.
  const cookieState = cookieValue(request, stateCookieName(PROVIDER_ID))
  if (cookieState === null || cookieState !== stateToken) {
    return htmlPage('授权失败', '<p>state 与浏览器会话不匹配，请重新登录。</p>', 400)
  }

  // The verifier lives with the flow row. For the QR path that is the qr id; for the
  // direct path it is the flow id carried in the state.
  const flowId = state.qrId ?? state.flowId ?? ''
  if (flowId === '') return htmlPage('授权失败', '<p>登录会话标识缺失。</p>', 400)
  const verifier = await deps.call<string | null>('takeOAuthPkce', [flowId])
  if (verifier === null) return htmlPage('登录已过期', '<p>登录会话已失效，请重新发起。</p>', 410)

  const tokens = await exchange(config, {
    code, redirectUri: callbackUrl(env), verifier,
  })
  if (tokens === null) return htmlPage('授权失败', '<p>无法用授权码换取令牌。</p>', 502)

  // A verified id_token is the only thing trusted here. Without one there is nothing to
  // check the signature against, so the flow stops rather than falling back to userinfo.
  if (tokens.idToken === undefined) {
    return htmlPage('授权失败', '<p>认证服务未返回 id_token，无法验证身份。</p>', 502)
  }
  const claims = await verifyIdToken(config, tokens.idToken, state.nonce)
  if (claims === null) {
    return htmlPage('授权失败', '<p>身份令牌校验未通过。</p>', 502)
  }

  const identity = await identityFromClaims(claims)
  if (identity === null) {
    return htmlPage('授权失败', '<p>身份令牌缺少已验证邮箱或有效的身份标识，请检查 Logto 的配置。</p>', 502)
  }

  if (state.identityProbe === true) {
    // Signed, browser-bound, one-shot enrollment reveals only the authenticated
    // user's identity. It never creates a tenant, issues a session or grants data.
    if (!env.DSH_SERVER_IDENTITY_PROBE_KEY || !env.DSH_SERVER_IDENTITY_EVIDENCE_KEY
      || env.DSH_SERVER_IDENTITY_PROBE_KEY === env.DSH_SERVER_IDENTITY_EVIDENCE_KEY || state.qrId !== null) {
      return htmlPage('身份核验已关闭', '<p>请重新联系实例维护者。</p>', 403)
    }
    const enrollmentFlow = await deps.call<{ provider: string; status: string; expiresAt: number } | null>('getOAuthSession', [flowId])
    if (enrollmentFlow === null || enrollmentFlow.provider !== PROVIDER_ID || enrollmentFlow.status !== 'exchanging'
      || enrollmentFlow.expiresAt <= Date.now()) return htmlPage('身份核验已过期', '<p>请重新发起核验。</p>', 410)
    const evidence = JSON.stringify({ v: 1, ...identity, observedAt: Date.now() })
    const signature = toBase64Url(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw',
      new TextEncoder().encode(env.DSH_SERVER_IDENTITY_EVIDENCE_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode(evidence)))
    // HMAC operations yield too; do not deliver evidence after the flow/state window.
    const live = await deps.call<{ provider: string; status: string; expiresAt: number } | null>('getOAuthSession', [flowId])
    if (live === null || live.provider !== PROVIDER_ID || live.status !== 'exchanging'
      || live.expiresAt <= Date.now() || state.exp * 1000 <= Date.now()) {
      return htmlPage('身份核验已过期', '<p>请重新发起核验。</p>', 410)
    }
    return htmlPage('身份核验完成（未授予设备权限）',
      `<p>请将下面的核验结果交给实例维护者绑定原账号。此操作没有登录设备池。</p><pre id="identity-evidence">${escapeHtml(JSON.stringify({ evidence, signature }))}</pre>`,
      200, { 'Set-Cookie': clearStateCookie(env) })
  }
  if (env.DSH_SERVER_IDENTITY_ENROLLMENT_ONLY === '1') {
    return htmlPage('实例正在迁移', '<p>暂未开放新登录；已有设备凭据不受此页面限制。</p>', 503)
  }

  // Explicit application admission trusts Logto's configured app access policy,
  // not a server-side role claim. Unset/unknown modes retain the email allowlist.
  // Both modes still require this app's fully verified ID token and verified email.
  if (env.DSH_SERVER_OIDC_ADMISSION !== 'application' && !allowedAccounts(env).includes(identity.account)) {
    return htmlPage('账号未获授权', '<p>该账号不在本服务的允许列表内。</p>', 403)
  }

  // The registry, not the request/email, supplies the live membership generation.
  // Resolve before signing so capacity/disabled-member failures cannot issue a session.
  const principal = await deps.resolveIdentity(identity)
  const session = await deps.issueSession(principal)

  if (state.qrId !== null) {
    const completed = await deps.call<boolean>(
      'completeOAuthSession', [state.qrId, principal.account, false, session.token],
    )
    if (!completed) return htmlPage('登录已过期', '<p>二维码会话已失效，请在客户端重新发起登录。</p>', 410)
    return htmlPage('授权完成', '<p>已登录，请回到客户端继续。</p>', 200, {
      'Set-Cookie': clearStateCookie(env),
    })
  }

  // The provider and session signer both yield. Direct flows also expire while
  // exchanging, and must not deliver a token after their live window has ended.
  const directFlow = await deps.call<{
    provider: string; status: string; expiresAt: number
  } | null>('getOAuthSession', [flowId])
  if (directFlow === null || directFlow.provider !== PROVIDER_ID
    || directFlow.status !== 'exchanging' || directFlow.expiresAt <= Date.now()) {
    return htmlPage('登录已过期', '<p>登录会话已失效，请重新发起。</p>', 410)
  }

  const separator = state.returnTo.includes('?') ? '&' : '?'
  return redirect(`${state.returnTo}${separator}token=${encodeURIComponent(session.token)}`, {
    'Set-Cookie': clearStateCookie(env),
  })
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie')
  if (header === null) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=') || null
  }
  return null
}
