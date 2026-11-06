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
  accountFromClaims, allowedAccounts, buildSignInUrl, callbackUrl, createPkce, exchange,
  logtoConfig, verifyIdToken,
} from './logto.js'
import { signState, verifyState, isAllowedReturnTo, stateCookieName } from './oauth.js'
import { toBase64Url } from './crypto.js'

/** Long enough to scan and authorise, short enough that a leaked code ages out. */
const SESSION_TTL_SECONDS = 600
const PROVIDER_ID = 'logto'
const PROVIDER_LABEL = 'Logto'

export interface OAuthDeps {
  call<T>(method: string, args: unknown[]): Promise<T>
  issueSession(account: string): Promise<{ token: string; expiresAt: number }>
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
  return new Response(null, { status: 303, headers: { Location: location, ...headers } })
}

function htmlPage(title: string, body: string, status = 200): Response {
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
  if (!oauthConfigured(env)) return Response.json({ items: [] })
  return Response.json({
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
  deps.rate(`oauth-start:${deps.clientKey(request)}`, { max: 30, windowMs: 60_000 })
  if (!oauthConfigured(env)) return deps.errorResponse('OAUTH_PROVIDER_UNAVAILABLE', 404)

  const url = new URL(request.url)
  const requested = url.searchParams.get('provider') ?? PROVIDER_ID
  if (requested !== PROVIDER_ID) return deps.errorResponse('OAUTH_PROVIDER_UNAVAILABLE', 404)

  const id = qrId()
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000
  await deps.call<void>('createOAuthSession', [{ qrId: id, provider: PROVIDER_ID, expiresAt }])

  return Response.json({
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

  if (session === null) return Response.json({ status: 'expired' })
  if (session.status === 'pending') {
    // Expiry is a status, not an error: the client treats it as a state transition and
    // stops polling, while an error would surface as a failure.
    if (session.expiresAt <= Date.now()) return Response.json({ status: 'expired' })
    return Response.json({ status: 'pending' })
  }

  const taken = await deps.call<{ account: string; isAdmin: boolean; token: string } | null>(
    'takeOAuthToken', [qrIdValue],
  )
  // A completed session whose token was already collected reports expired: the token is
  // single-use, and re-serving it would defeat that.
  if (taken === null) return Response.json({ status: 'expired' })
  return Response.json({ status: 'complete', token: taken.token })
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

  if (session === null || session.expiresAt <= Date.now()) {
    return htmlPage('登录已过期', '<p>这个二维码已失效，请在客户端重新发起登录。</p>', 410)
  }
  if (session.status === 'complete') {
    return htmlPage('已登录', '<p>授权已完成，可以关闭此页面。</p>')
  }

  const pkce = await createPkce()
  // The verifier is stored with the flow, not in a cookie: a phone scans the code while
  // the desktop client polls, so the two are different browsers with different jars.
  await deps.call<void>('setOAuthPkce', [qrIdValue, pkce.verifier])

  const state = await signState(env.SESSION_SECRET, {
    providerId: PROVIDER_ID, returnTo: '/app', qrId: qrIdValue,
  })
  const target = await buildSignInUrl(config, {
    redirectUri: callbackUrl(env), state, challenge: pkce.challenge,
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
  const requested = url.searchParams.get('return_to') ?? '/app'
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
  await deps.call<void>('setOAuthPkce', [id, pkce.verifier])

  const state = await signState(env.SESSION_SECRET, {
    providerId: PROVIDER_ID, returnTo: requested, qrId: null, flowId: id,
  })
  const target = await buildSignInUrl(config, {
    redirectUri: callbackUrl(env), state, challenge: pkce.challenge,
  })
  if (target === null) return htmlPage('登录不可用', '<p>无法连接认证服务。</p>', 502)
  return redirect(target, { 'Set-Cookie': stateCookie(env, state) })
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
  if (state === null) return htmlPage('授权失败', '<p>state 无效或已过期，请重新登录。</p>', 400)

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
  const verifier = await deps.call<string | null>('getOAuthPkce', [flowId])
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
  const claims = await verifyIdToken(config, tokens.idToken)
  if (claims === null) {
    return htmlPage('授权失败', '<p>身份令牌校验未通过。</p>', 502)
  }

  const account = accountFromClaims(claims)
  if (account === null) {
    return htmlPage('授权失败', '<p>身份令牌中没有邮箱，请检查 Logto 的 scope 配置。</p>', 502)
  }

  // The provider authenticated *someone*; whether that someone may use this deployment
  // is a separate decision. Without this any Logto account could sign in.
  if (!allowedAccounts(env).includes(account)) {
    return htmlPage('账号未获授权', '<p>该账号不在本服务的允许列表内。</p>', 403)
  }

  const session = await deps.issueSession(account)

  if (state.qrId !== null) {
    const completed = await deps.call<boolean>(
      'completeOAuthSession', [state.qrId, account, false, session.token],
    )
    if (!completed) return htmlPage('登录已过期', '<p>二维码会话已失效，请在客户端重新发起登录。</p>', 410)
    return htmlPage('授权完成', '<p>已登录，请回到客户端继续。</p>')
  }

  const separator = state.returnTo.includes('?') ? '&' : '?'
  return redirect(`${state.returnTo}${separator}token=${encodeURIComponent(session.token)}`, {
    'Set-Cookie': `${stateCookieName(PROVIDER_ID)}=; Path=/api/v1/auth; HttpOnly; Max-Age=0`,
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
