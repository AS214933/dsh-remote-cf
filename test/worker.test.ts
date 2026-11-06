/**
 * Worker-level routing tests.
 *
 * The 418 default is a security property, not a cosmetic one: this deployment has no
 * public web surface, and a scanner must not be able to tell what is running here
 * from a status code. These tests pin that, plus the routes that must keep working.
 */
import { describe, expect, it, vi } from 'vitest'
import worker from '../src/worker.js'
import type { Env } from '../src/env.js'

const PUBLIC_URL = 'https://relay.example'

/** A minimal env: no Durable Object is reached by the paths under test. */
function makeEnv(overrides: Partial<Env> = {}): Env {
  const assets = { fetch: vi.fn(async () => new Response('asset', { status: 200 })) }
  return {
    DSH_SERVER_ACCOUNT: 'owner@example.com',
    DSH_SERVER_PASSWORD: 'password123',
    DSH_SERVER_PUBLIC_URL: PUBLIC_URL,
    SESSION_SECRET: 'session-secret-long-enough',
    ASSETS: assets as unknown as Fetcher,
    GATEWAY: { getByName: () => ({ fetch: async () => new Response('do') }) } as unknown as Env['GATEWAY'],
    ...overrides,
  }
}

async function get(path: string, env = makeEnv()): Promise<Response> {
  return worker.fetch(new Request(`${PUBLIC_URL}${path}`), env)
}

describe('default 418', () => {
  it('answers 418 at the root', async () => {
    const response = await get('/')
    expect(response.status).toBe(418)
  })

  it('answers 418 for common probe paths', async () => {
    for (const path of ['/.env', '/admin', '/wp-admin', '/wp-login.php', '/.git/config', '/phpmyadmin', '/backup.zip']) {
      const response = await get(path)
      expect(response.status, path).toBe(418)
    }
  })

  it('does not leak a stack, a UI, or an indexable page', async () => {
    const response = await get('/')
    // Plain text with no HTML: nothing to fingerprint, nothing to crawl.
    expect(response.headers.get('Content-Type')).toContain('text/plain')
    expect(response.headers.get('X-Robots-Tag')).toContain('noindex')
    expect(await response.text()).not.toContain('<')
  })

  it('never falls through to the asset handler by default', async () => {
    const env = makeEnv()
    await get('/anything', env)
    // Serving the SPA for unknown paths is what made the server look like it had a
    // web UI; it must not happen unless explicitly enabled.
    expect(env.ASSETS.fetch).not.toHaveBeenCalled()
  })

  it('serves the SPA at the root only when asked', async () => {
    const env = makeEnv({ DSH_SERVER_ROOT_PAGE: 'assets' })
    const response = await get('/', env)
    expect(response.status).toBe(200)
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce()
  })
})

describe('routes that must keep working', () => {
  it('answers health checks', async () => {
    for (const path of ['/healthz', '/health', '/ready']) {
      const response = await get(path)
      expect(response.status, path).toBe(200)
      expect(await response.json()).toEqual({ status: 'ok' })
    }
  })

  it('routes /api/* to the API, not to 418', async () => {
    const response = await get('/api/v1/nope')
    // Unknown API routes are a 404 from the API layer, never a teapot: a client
    // needs to tell "this endpoint does not exist" from "you are being probed".
    expect(response.status).toBe(404)
  })

  it('rejects a WebSocket upgrade attempt without the Upgrade header', async () => {
    const response = await get('/ws/v1/connect')
    expect(response.status).toBe(426)
  })

  it('rejects a WebSocket request carrying a query string', async () => {
    // The Upgrade header must be present, otherwise the 426 branch answers first and
    // the query-string rule is never reached.
    const response = await worker.fetch(
      new Request(`${PUBLIC_URL}/ws/v1/connect?token=abc`, {
        headers: { Upgrade: 'websocket' },
      }),
      makeEnv(),
    )
    expect(response.status).toBe(403)
  })

  it('rejects a foreign Origin', async () => {
    const response = await worker.fetch(
      new Request(`${PUBLIC_URL}/ws/v1/connect`, {
        headers: { Upgrade: 'websocket', Origin: 'https://evil.example' },
      }),
      makeEnv(),
    )
    expect(response.status).toBe(403)
  })
})

describe('configuration guard', () => {
  it('refuses to serve with a short password', async () => {
    const env = makeEnv({ DSH_SERVER_PASSWORD: 'short' })
    await expect(get('/', env)).rejects.toThrow(/DSH_SERVER_PASSWORD/)
  })

  it('refuses to serve without an account', async () => {
    const env = makeEnv({ DSH_SERVER_ACCOUNT: '' })
    await expect(get('/', env)).rejects.toThrow(/DSH_SERVER_ACCOUNT/)
  })

  it('refuses a public URL with a path', async () => {
    const env = makeEnv({ DSH_SERVER_PUBLIC_URL: 'https://relay.example/sub' })
    await expect(get('/', env)).rejects.toThrow(/origin/)
  })
})

describe('register-owned-role', () => {
  it('refuses an unauthenticated claim', async () => {
    // The endpoint mints a device, so it must never work without a credential.
    const response = await worker.fetch(
      new Request(`${PUBLIC_URL}/api/v1/devices/register-owned-role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: 1, device: {} }),
      }),
      makeEnv(),
    )
    expect(response.status).toBe(401)
  })

  it('is routed rather than answering 404 or 418', async () => {
    // A 404 here is what broke the UI: signing in succeeded, then the host picker
    // came up empty because the Host could never be claimed.
    const response = await worker.fetch(
      new Request(`${PUBLIC_URL}/api/v1/devices/register-owned-role`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ v: 1, device: {} }),
      }),
      makeEnv(),
    )
    expect(response.status).not.toBe(404)
    expect(response.status).not.toBe(418)
  })
})

describe('close code semantics', () => {
  it('distinguishes a replaced identity from a retryable failure', async () => {
    // 4003 tells the client "another instance took over, do not reconnect" — the
    // reference uses it so two instances do not fight. Every other reason is
    // retryable and must stay 4001, or a replacement puts both ends in a loop.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/gateway.ts', import.meta.url), 'utf8')
    expect(source).toContain('CLOSE_CODE_REPLACED = 4003')
    expect(source).toContain("code === 'CONNECTION_REPLACED' ? CLOSE_CODE_REPLACED : SERVER_SHUTDOWN_CLOSE_CODE")
  })
})

describe('ceilings match the reference server', () => {
  it('caps peers and links at 256', async () => {
    // The reference caps both at 256. A higher local cap changes behaviour under load
    // and, on a metered platform, the bill.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/gateway.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/const MAX_PEERS = 256/)
    expect(source).toMatch(/const MAX_LINKS = 256/)
  })
})
