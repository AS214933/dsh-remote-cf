import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/env.js'
import { TurnCredentialCache } from '../src/turn.js'

const env = { TURN_KEY_ID: 'test-key', TURN_KEY_API_TOKEN: 'test-only', TURN_CREDENTIAL_TTL_SECONDS: '86400' } as Env
const ice = (credential = 'synthetic-test-credential') => [{ urls: ['turn:turn.example:3478'], username: 'synthetic', credential }]
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}) })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('bounded device-isolated TURN credential reuse', () => {
  it('joins concurrent calls, retains successful results per device, and never shares peer credentials', async () => {
    const first = deferred<Response>()
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(Response.json({ iceServers: ice('host-only') }))
    vi.stubGlobal('fetch', fetcher)
    const cache = new TurnCredentialCache(env)
    const a = cache.get('client'), b = cache.get('client'), host = cache.get('host')
    expect(a).toBe(b)
    expect(fetcher).toHaveBeenCalledTimes(2)
    first.resolve(Response.json({ iceServers: ice('client-only') }))
    expect(await a).toEqual(ice('client-only'))
    expect(await host).toEqual(ice('host-only'))
    expect(await cache.get('client')).toEqual(ice('client-only'))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('expires reuse from mint start, caps it at five minutes, and preserves a sixty-second TTL margin', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async () => Response.json({ iceServers: ice() }))
    vi.stubGlobal('fetch', fetcher)
    const cache = new TurnCredentialCache(env)
    await cache.get('client')
    vi.advanceTimersByTime(299_999)
    await cache.get('client')
    expect(fetcher).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    await cache.get('client')
    expect(fetcher).toHaveBeenCalledTimes(2)
    const short = new TurnCredentialCache({ ...env, TURN_CREDENTIAL_TTL_SECONDS: '120' })
    await short.get('client')
    vi.advanceTimersByTime(60_000)
    await short.get('client')
    expect(fetcher).toHaveBeenCalledTimes(4)
    const minimal = new TurnCredentialCache({ ...env, TURN_CREDENTIAL_TTL_SECONDS: '60' })
    expect(await minimal.get('client')).toEqual(ice())
    expect(await minimal.get('client')).toEqual(ice())
    expect(fetcher).toHaveBeenCalledTimes(6)
  })

  it('does not cache a failure, and invalidated old flights cannot overwrite or delete a replacement', async () => {
    const old = deferred<Response>(), replacement = deferred<Response>()
    const fetcher = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise)
      .mockRejectedValueOnce(new Error('issuer unavailable')).mockResolvedValueOnce(Response.json({ iceServers: ice('recovered') }))
    vi.stubGlobal('fetch', fetcher)
    const cache = new TurnCredentialCache(env)
    const a = cache.get('client')
    cache.forget('client')
    const b = cache.get('client')
    replacement.resolve(Response.json({ iceServers: ice('new') }))
    expect(await b).toEqual(ice('new'))
    old.resolve(new Response('unavailable', { status: 503 }))
    expect(await a).toBeNull()
    expect(await cache.get('client')).toEqual(ice('new'))
    expect(await cache.get('host')).toBeNull()
    expect(await cache.get('host')).toEqual(ice('recovered'))
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it('bounds active issuer work even when invalidation removes all pending map slots', async () => {
    const pending = deferred<Response>()
    const fetcher = vi.fn(async () => { await pending.promise; return Response.json({ iceServers: [] }) })
    vi.stubGlobal('fetch', fetcher)
    const cache = new TurnCredentialCache(env)
    for (let i = 0; i < 64; i++) { void cache.get(`device-${i}`); cache.forget(`device-${i}`) }
    expect(await cache.get('overflow')).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(64)
    // One Response per fetch is needed when bodies are consumed concurrently.
    pending.resolve(Response.json({ iceServers: [] }))
    await Promise.resolve()
  })
})
