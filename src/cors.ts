/**
 * Cross-origin access for the browser workbench.
 *
 * The web UI is served from its own origin (a Pages deployment, a local dev server,
 * or the desktop shell) and talks to this server by absolute URL, so every request
 * is cross-origin. Without CORS the browser blocks the preflight and the login never
 * leaves the page — the server looks broken while its logs show nothing at all,
 * because the request is never sent.
 *
 * The allowlist is explicit and empty by default. A wildcard is not an option here:
 * `Access-Control-Allow-Credentials` cannot be combined with `*`, and a
 * session-cookie API that any origin may call is a CSRF hole. Operators list the
 * origins they actually serve the UI from.
 */

/**
 * Build the CORS headers for one request.
 *
 * Returns null when the origin is not allowlisted, so the caller can answer without
 * granting anything rather than silently reflecting an arbitrary origin.
 */
export function corsHeaders(
  request: Request,
  allowedOrigins: readonly string[],
): Record<string, string> | null {
  const origin = request.headers.get('Origin')
  // No Origin means a non-browser client (the Host plugin on Node, curl, a mobile
  // app). CORS does not apply to those, and they must not be refused.
  if (origin === null) return null
  if (!allowedOrigins.includes(origin)) return null

  return {
    'Access-Control-Allow-Origin': origin,
    // The session cookie is scoped to this server's own origin and is not needed by
    // the cross-origin UI, which uses the bearer token instead. `true` is still
    // required for the logout path to clear a cookie set by a same-origin visit.
    'Access-Control-Allow-Credentials': 'true',
    // Vary matters: without it a cache can serve one origin's response, with its
    // Allow-Origin, to another origin.
    Vary: 'Origin',
  }
}

/**
 * Answer a preflight `OPTIONS` request.
 *
 * Kept separate from the normal response path because a preflight carries no
 * credentials and must succeed before the browser will send the real request.
 */
export function preflightResponse(request: Request, allowedOrigins: readonly string[]): Response {
  const origin = request.headers.get('Origin')
  const headers = corsHeaders(request, allowedOrigins)
  if (headers === null) {
    // Not allowlisted: answer without CORS headers so the browser blocks it, but do
    // not pretend the route exists in any useful way.
    return new Response(null, { status: 403, headers: { Vary: 'Origin' } })
  }
  void origin
  return new Response(null, {
    status: 204,
    headers: {
      ...headers,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      // Echo the requested headers rather than a fixed list: the UI sends
      // Authorization and Content-Type, and hardcoding the set would break silently
      // the first time a client adds one.
      'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers')
        ?? 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  })
}

/** Parse the allowlist from one comma-separated value. */
export function parseAllowedOrigins(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
    // Normalise a trailing slash: browsers send the origin without one, and a
    // mismatch here fails in the least debuggable way possible.
    .map(entry => (entry.endsWith('/') ? entry.slice(0, -1) : entry))
}
