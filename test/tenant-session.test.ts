import { describe, it, expect } from 'vitest'
import { signSession, verifySession } from '../src/crypto.js'
const secret = 'synthetic-session-signing-secret'
describe('tenant-bound session payload', () => {
  it('preserves authenticated identity and rejects unsigned tenant substitution', async () => {
    const session = { v: 2 as const, tenantId: 'tenant-a', account: 'owner@example.com', issuer: 'https://auth.example.com/oidc', subject: 'user-a', expiresAt: Date.now() + 60_000 }
    const token = await signSession(secret, session)
    expect(await verifySession(secret, token)).toEqual(session)
    const [body, signature] = token.split('.')
    const value = JSON.parse(Buffer.from(body!, 'base64url').toString())
    value.tenantId = 'tenant-b'
    expect(await verifySession(secret, `${Buffer.from(JSON.stringify(value)).toString('base64url')}.${signature}`)).toBeNull()
  })
  it('does not upgrade an old tenantless session into a principal', async () => {
    const legacy = { account: 'owner@example.com', expiresAt: Date.now() + 60_000 }
    const parsed = await verifySession(secret, await signSession(secret, legacy))
    expect(parsed?.tenantId).toBeUndefined()
    expect(parsed?.v).toBeUndefined()
  })
  it('fails closed for malformed v2 identity fields', async () => {
    for (const bad of [{ v: 2, account: 'owner@example.com', expiresAt: Date.now() + 60_000 },
      { v: 2, tenantId: 'a', account: 'owner@example.com', issuer: null, subject: 'x', expiresAt: Date.now() + 60_000 }]) {
      expect(await verifySession(secret, await signSession(secret, bad as never))).toBeNull()
    }
  })
})
