/**
 * Logto sign-in tests.
 *
 * The centrepiece is id_token verification. The official SDK's `decodeIdToken` only
 * parses the payload — it checks field types and nothing else — so the signature, issuer,
 * audience and expiry checks here are the entire security boundary. Each is pinned
 * individually because a regression in any one of them is silent.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  accountFromClaims, allowedAccounts, callbackUrl, createPkce, logtoConfig, resetLogtoCache,
  verifyIdToken, buildSignInUrl, exchange,
} from '../src/logto.js'
import { isAllowedReturnTo, signState, verifyState } from '../src/oauth.js'
import type { Env } from '../src/env.js'

const SECRET = 'session-secret-long-enough'
const ENDPOINT = 'https://auth.example.com'
const CLIENT_ID = 'client-abc'
const NONCE = 'test-flow-nonce-unique'

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DSH_SERVER_ACCOUNT: 'owner@example.com',
    DSH_SERVER_PASSWORD: 'password123',
    DSH_SERVER_PUBLIC_URL: 'https://relay.example',
    SESSION_SECRET: SECRET,
    LOGTO_ENDPOINT: ENDPOINT,
    LOGTO_CLIENT_ID: CLIENT_ID,
    LOGTO_CLIENT_SECRET: 'client-secret',
    ...overrides,
  } as Env
}

const ISSUER = `${ENDPOINT}/oidc`
const JWKS_URI = `${ISSUER}/jwks`

// --- a real RSA key so verification is exercised, not stubbed -----------------------

const KID = 'test-kid'

let keyCache: { pair: CryptoKeyPair; jwk: JsonWebKey } | null = null

/** A real RSA key, created once per test file. */
async function testKey(): Promise<{ pair: CryptoKeyPair; jwk: JsonWebKey }> {
  if (keyCache !== null) return keyCache
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey
  keyCache = { pair, jwk }
  return { pair, jwk }
}

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Build an id_token signed with the test key (or a tampered variant). */
async function makeIdToken(
  claims: Record<string, unknown>,
  options: { kid?: string; tamper?: boolean } = {},
): Promise<string> {
  const { pair } = await testKey()
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: options.kid ?? KID })))
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)))
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${header}.${payload}`),
  )
  let encoded = b64url(signature)
  if (options.tamper === true) {
    // Flip one character so the signature no longer matches.
    encoded = (encoded[0] === 'A' ? 'B' : 'A') + encoded.slice(1)
  }
  return `${header}.${payload}.${encoded}`
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000)
  return {
    iss: ISSUER,
    sub: 'user-1',
    aud: CLIENT_ID,
    exp: now + 3600,
    iat: now - 10,
    email: 'Owner@Example.com',
    email_verified: true,
    nonce: NONCE,
    ...overrides,
  }
}

/** Route the SDK's discovery and JWKS fetches to the test key. */
function stubProvider(): void {
  resetLogtoCache()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/oidc/.well-known/openid-configuration')) {
      return Response.json({
        issuer: ISSUER,
        authorizationEndpoint: `${ISSUER}/auth`,
        tokenEndpoint: `${ISSUER}/token`,
        userinfoEndpoint: `${ISSUER}/me`,
        jwksUri: JWKS_URI,
        endSessionEndpoint: `${ISSUER}/session/end`,
        responseTypesSupported: ['code'],
        subjectTypesSupported: ['public'],
        idTokenSigningAlgValuesSupported: ['RS256'],
        scopesSupported: ['openid', 'profile', 'email'],
        tokenEndpointAuthMethodsSupported: ['client_secret_basic'],
        claimsSupported: ['sub', 'email'],
      })
    }
    if (url === JWKS_URI) {
      const { jwk } = await testKey()
      return Response.json({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] })
    }
    return new Response('not found', { status: 404 })
  }))
}

describe('logtoConfig', () => {
  it('is null when unconfigured, which keeps password login as the only option', () => {
    const bare = makeEnv()
    delete (bare as unknown as Record<string, unknown>).LOGTO_ENDPOINT
    expect(logtoConfig(bare)).toBeNull()
  })

  it('parses a full configuration and strips a trailing slash', () => {
    const config = logtoConfig(makeEnv({ LOGTO_ENDPOINT: `${ENDPOINT}/` }))
    expect(config).toMatchObject({ endpoint: ENDPOINT, clientId: CLIENT_ID })
    expect(config?.scopes).toEqual(['openid', 'profile', 'email'])
  })

  it('appends extra scopes', () => {
    expect(logtoConfig(makeEnv({ LOGTO_SCOPES: 'roles, organizations' }))?.scopes)
      .toEqual(['openid', 'profile', 'email', 'roles', 'organizations'])
  })
})

describe('verifyIdToken', () => {
  it('accepts a correctly signed token', async () => {
    stubProvider()
    try {
      const config = logtoConfig(makeEnv())!
      const token = await makeIdToken(claims())
      const result = await verifyIdToken(config, token, NONCE)
      expect(result?.email).toBe('Owner@Example.com')
    } finally { vi.unstubAllGlobals() }
  })

  it('rejects a tampered signature', async () => {
    // The single most important check: the SDK would happily decode this token.
    stubProvider()
    try {
      const config = logtoConfig(makeEnv())!
      const token = await makeIdToken(claims(), { tamper: true })
      expect(await verifyIdToken(config, token, NONCE)).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })

  it('rejects alg none', async () => {
    // `none` means "no signature"; accepting it would let anyone mint a token.
    stubProvider()
    try {
      const config = logtoConfig(makeEnv())!
      const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'none', typ: 'JWT' })))
      const payload = b64url(new TextEncoder().encode(JSON.stringify(claims())))
      expect(await verifyIdToken(config, `${header}.${payload}.`, NONCE)).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })

  it('rejects a wrong issuer', async () => {
    stubProvider()
    try {
      const config = logtoConfig(makeEnv())!
      const token = await makeIdToken(claims({ iss: 'https://evil.example/oidc' }))
      expect(await verifyIdToken(config, token, NONCE)).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })

  it('rejects a wrong audience', async () => {
    stubProvider()
    try {
      const config = logtoConfig(makeEnv())!
      const token = await makeIdToken(claims({ aud: 'someone-elses-client' }))
      expect(await verifyIdToken(config, token, NONCE)).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })

  it('accepts an audience array containing this client', async () => {
    stubProvider()
    try {
      const config = logtoConfig(makeEnv())!
      const token = await makeIdToken(claims({ aud: ['other', CLIENT_ID], azp: CLIENT_ID }))
      expect(await verifyIdToken(config, token, NONCE)).not.toBeNull()
    } finally { vi.unstubAllGlobals() }
  })

  it('rejects an expired token', async () => {
    stubProvider()
    try {
      const config = logtoConfig(makeEnv())!
      const past = Math.floor(Date.now() / 1000) - 10
      const token = await makeIdToken(claims({ iat: past - 3600, exp: past }))
      expect(await verifyIdToken(config, token, NONCE)).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })

  it('rejects an unknown kid', async () => {
    stubProvider()
    try {
      const config = logtoConfig(makeEnv())!
      const token = await makeIdToken(claims(), { kid: 'unknown-kid' })
      expect(await verifyIdToken(config, token, NONCE)).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })

  it('rejects malformed input without throwing', async () => {
    stubProvider()
    try {
      const config = logtoConfig(makeEnv())!
      for (const bad of ['', 'a', 'a.b', 'a.b.c.d', 'not.a.token']) {
        expect(await verifyIdToken(config, bad, NONCE)).toBeNull()
      }
    } finally { vi.unstubAllGlobals() }
  })

  it('returns null when the tenant is unreachable', async () => {
    resetLogtoCache()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    try {
      const config = logtoConfig(makeEnv())!
      expect(await verifyIdToken(config, await makeIdToken(claims()), NONCE)).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })
})

describe('accountFromClaims', () => {
  it('lower-cases the email', () => {
    expect(accountFromClaims({ email: 'A@B.com', email_verified: true } as never)).toBe('a@b.com')
  })

  it('is null without an email, so the flow can refuse rather than invent one', () => {
    expect(accountFromClaims({} as never)).toBeNull()
    expect(accountFromClaims({ email: '' } as never)).toBeNull()
    expect(accountFromClaims({ email: 42 } as never)).toBeNull()
  })
})

describe('confidential OIDC exchange and flow binding', () => {
  it('uses SDK PKCE form parameters plus client_secret_basic only at the token endpoint', async () => {
    stubProvider()
    const discoveryFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== `${ISSUER}/token`) {
        expect(new Headers(init?.headers).get('Authorization')).toBeNull()
        return discoveryFetch(input, init)
      }
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Basic ${btoa(`${CLIENT_ID}:client-secret`)}`)
      const params = new URLSearchParams(String(init?.body))
      expect(params.get('grant_type')).toBe('authorization_code')
      expect(params.get('code')).toBe('test-code')
      expect(params.get('code_verifier')).toBe('test-verifier')
      expect(params.get('redirect_uri')).toBe('https://relay.example/callback')
      expect(params.has('client_secret')).toBe(false)
      return Response.json({ access_token: 'synthetic-access', id_token: 'synthetic-id', expires_in: 300 })
    }))
    try {
      const config = logtoConfig(makeEnv())!
      const target = new URL((await buildSignInUrl(config, { redirectUri: 'https://relay.example/callback', state: 'signed-state', challenge: 'challenge', nonce: NONCE }))!)
      expect(target.searchParams.get('nonce')).toBe(NONCE)
      expect(target.searchParams.get('code_challenge_method')).toBe('S256')
      expect(target.searchParams.get('scope')?.split(' ')).not.toContain('offline_access')
      expect(await exchange(config, { code: 'test-code', verifier: 'test-verifier', redirectUri: 'https://relay.example/callback' }))
        .toEqual({ accessToken: 'synthetic-access', idToken: 'synthetic-id', expiresIn: 300 })
    } finally { vi.unstubAllGlobals() }
  })

  it('rejects missing/wrong nonce, multiple audiences without azp, future iat and empty subject', async () => {
    stubProvider()
    try {
      const config = logtoConfig(makeEnv())!
      for (const value of [claims({ nonce: undefined }), claims({ nonce: 'wrong-nonce' }), claims({ aud: [CLIENT_ID, 'other'] }),
        claims({ azp: 'other' }), claims({ iat: Math.floor(Date.now() / 1000) + 121 }), claims({ sub: '' })]) {
        expect(await verifyIdToken(config, await makeIdToken(value), NONCE)).toBeNull()
      }
    } finally { vi.unstubAllGlobals() }
  })

  it('accepts real ES384 signatures as emitted by the tenant', async () => {
    stubProvider()
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify']) as CryptoKeyPair
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    const discoveryFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => String(input) === JWKS_URI
      ? Response.json({ keys: [{ ...jwk, kid: 'ec-key', alg: 'ES384', use: 'sig' }] }) : discoveryFetch(input, init)))
    try {
      const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'ES384', kid: 'ec-key' })))
      const payload = b64url(new TextEncoder().encode(JSON.stringify(claims())))
      const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, pair.privateKey, new TextEncoder().encode(`${header}.${payload}`))
      expect((await verifyIdToken(logtoConfig(makeEnv())!, `${header}.${payload}.${b64url(signature)}`, NONCE))?.sub).toBe('user-1')
    } finally { vi.unstubAllGlobals() }
  })

  it('never authorizes unverified or malformed email claims', () => {
    for (const verified of [undefined, false, null, 'true', 1]) {
      expect(accountFromClaims({ email: 'owner@example.com', email_verified: verified } as never)).toBeNull()
    }
    expect(accountFromClaims({ email: 'not-an-email', email_verified: true } as never)).toBeNull()
  })
})

describe('allowedAccounts', () => {
  it('defaults to the configured account', () => {
    expect(allowedAccounts(makeEnv())).toEqual(['owner@example.com'])
  })

  it('honours an explicit list', () => {
    expect(allowedAccounts(makeEnv({ OAUTH_ALLOWED_ACCOUNTS: 'A@B.com, c@d.com' })))
      .toEqual(['a@b.com', 'c@d.com'])
  })
})

describe('pkce', () => {
  it('produces a verifier and its S256 challenge', async () => {
    const { verifier, challenge } = await createPkce()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    expect(challenge).toBe(b64url(digest))
  })

  it('does not repeat', async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 20; i += 1) seen.add((await createPkce()).verifier)
    expect(seen.size).toBe(20)
  })
})

describe('callback url', () => {
  it('is built on the public origin', () => {
    expect(callbackUrl(makeEnv())).toBe('https://relay.example/api/v1/auth/oauth/logto/callback')
  })
})

describe('state', () => {
  it('round-trips with a flow id for the direct browser path', async () => {
    const token = await signState(SECRET, {
      providerId: 'logto', returnTo: '/app', qrId: null, flowId: 'flow-1',
    })
    const state = await verifyState(SECRET, token, 'logto')
    expect(state).toMatchObject({ qrId: null, flowId: 'flow-1', returnTo: '/app' })
  })

  it('still rejects a tampered returnTo', async () => {
    const token = await signState(SECRET, { providerId: 'logto', returnTo: '/app', qrId: null })
    const [body, signature] = token.split('.')
    const forged = b64url(new TextEncoder().encode(JSON.stringify({
      typ: 'logto-oauth-state', returnTo: 'https://evil.example', nonce: 'x'.repeat(16),
      qrId: null, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600,
    })))
    expect(await verifyState(SECRET, `${forged}.${signature}`, 'logto')).toBeNull()
    expect(await verifyState(SECRET, `${body}.${signature}`, 'logto')).not.toBeNull()
  })
})

describe('return_to allowlist', () => {
  it('allows only the mobile callback and same-origin paths', () => {
    expect(isAllowedReturnTo('dshremote://oauth')).toBe(true)
    expect(isAllowedReturnTo('/app')).toBe(true)
    for (const bad of ['https://evil.example', '//evil.example', 'javascript:x', 'dshremote://other']) {
      expect(isAllowedReturnTo(bad), bad).toBe(false)
    }
  })
})
