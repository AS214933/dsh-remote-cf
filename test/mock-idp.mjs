/**
 * Mock OAuth 2.0 identity provider for local end-to-end runs.
 *
 * Implements the two endpoints a provider must expose:
 *   GET  /authorize   -> 302 back to redirect_uri with a code
 *   POST /token       -> { access_token }
 *   GET  /user        -> profile
 *   GET  /user/emails -> address list (to exercise the fallback path)
 *
 * The `code` decides which account comes back, so the test can drive both the allowed
 * and the rejected case through the same stub.
 *
 *   node test/mock-idp.mjs [port]
 */
import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 8901)
const ALLOWED = process.env.MOCK_IDP_ACCOUNT ?? 'owner@example.com'
const OUTSIDER = process.env.MOCK_IDP_OUTSIDER ?? 'someone-else@example.com'

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`)
  const json = (status, body) => {
    const payload = JSON.stringify(body)
    response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
    response.end(payload)
  }

  // The browser arrives here first. Immediately bounce back with a code, which is what
  // a real provider does after the user has authenticated.
  if (url.pathname === '/authorize') {
    const redirectUri = url.searchParams.get('redirect_uri')
    const state = url.searchParams.get('state')
    if (!redirectUri || !state) { json(400, { error: 'missing redirect_uri or state' }); return }
    const target = new URL(redirectUri)
    target.searchParams.set('code', 'mock-code')
    target.searchParams.set('state', state)
    response.writeHead(302, { Location: target.toString() })
    response.end()
    return
  }

  if (url.pathname === '/token' && request.method === 'POST') {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const params = new URLSearchParams(raw)
    const code = params.get('code') ?? ''
    // `outsider` drives the "authenticated but not allowed" branch.
    json(200, { access_token: code === 'outsider' ? 'token-outsider' : 'token-allowed', token_type: 'bearer' })
    return
  }

  if (url.pathname === '/user') {
    const token = (request.headers.authorization ?? '').replace(/^Bearer /, '')
    // Mimic GitHub hiding the address for users who keep it private, so the email-list
    // fallback is exercised rather than assumed.
    json(200, { login: 'mock-user', email: null, __token: token })
    return
  }

  if (url.pathname === '/user/emails') {
    const token = (request.headers.authorization ?? '').replace(/^Bearer /, '')
    const address = token === 'token-outsider' ? OUTSIDER : ALLOWED
    json(200, [
      { email: 'secondary@example.com', primary: false, verified: true },
      { email: address, primary: true, verified: true },
    ])
    return
  }

  json(404, { error: 'not_found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock IdP on http://127.0.0.1:${PORT}`)
  console.log(`  allowed : ${ALLOWED}`)
  console.log(`  outsider: ${OUTSIDER}`)
})
