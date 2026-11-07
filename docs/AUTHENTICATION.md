# Authentication

[README](../README.md) · [Multi-tenancy and migration](MULTITENANCY.md) · [Deployment](DEPLOYMENT.md) · [Architecture](ARCHITECTURE.md)

## OIDC identities become logical tenants

A verified OIDC `issuer + sub` identifies a stable tenant within the shared Gateway. Verified email is admission/display metadata, not an ownership key. An email change does not move devices, and two subjects with the same email do not share a namespace. Callers cannot select a tenant by submitting its ID.

Sessions carry signed v2 principals and are checked against the live tenant registry. Devices and saved credential digests bind to the authenticated tenant; per-tenant lists, peer lookups, mutations, Host authorization, refresh/revoke, WebSocket links and TURN caches use that scope. Logical isolation does not provide separate execution, storage, availability or quota reservations. See [multi-tenancy](MULTITENANCY.md).

## Logto OIDC flow

1. A client discovers the `logto` provider, then starts a short-lived QR/poll flow or opens direct browser entry.
2. The server redirects to Logto with S256 PKCE, signed state and a nonce. A secure browser-state cookie binds the callback to its initiating browser.
3. Code exchange uses confidential-client Basic authentication. ID-token signature/claims are verified against the configured tenant JWKS.
4. Verified email and the configured admission policy are checked; the verified issuer/subject resolves or admits the tenant within capacity.
5. An ordinary admitted flow receives this server's tenant-bound session. The verifier/flow is consumed once; QR collection is single-use and expires.

The official `@logto/js` SDK handles discovery, authorization URL and code-exchange details; `jose` validates signatures/claims. Current permitted ID-token algorithms are ES384, ES256 and RS256 with issuer, audience/authorized-party, time, subject and nonce checks. SDK decoding alone is not authorization. Discovery is restricted to the expected HTTPS Logto origin/layout. See [setup](DEPLOYMENT.md#4-logto-oidc-and-admission).

### Admission policy and capacity

- `email_verified` must be boolean `true`; missing, false and string values are rejected.
- Default or unrecognized `DSH_SERVER_OIDC_ADMISSION` uses the verified-email allowlist. It defaults to normalized `DSH_SERVER_ACCOUNT`; `OAUTH_ALLOWED_ACCOUNTS` replaces that list. Accepted distinct issuer/subject identities still receive distinct tenants.
- Explicit `DSH_SERVER_OIDC_ADMISSION=application` trusts a successfully verified login to the configured Logto app with verified email. **The server does not validate roles claims.** Configure Logto application access policy before enabling this mode. Merely assigning a role without enforcing app access is not a server-side role authorization rule.
- `DSH_SERVER_MAX_TENANTS` defaults to ten tenant records. Disabled users still count; one original-owner slot stays reserved until owner binding. This is an admission cap, not guaranteed active capacity or per-user billing.
- The app requests `openid profile email` by default, without automatically adding `offline_access`. Extra scopes/resources are operator choices.
- Current HTTP provider routing is specifically Logto; historical generic-provider examples are not a supported setup guide.

### Original owner and identity-only enrollment

Upgraded device/token state is retained in a reserved `legacy-owner` tenant. The owner is **not** assigned by first login or matching email. Before ordinary admission of that identity, configure exact `DSH_SERVER_LEGACY_OWNER_ISSUER` and `DSH_SERVER_LEGACY_OWNER_SUBJECT`.

If the subject is unknown, use the supervised [identity-only enrollment](MULTITENANCY.md#identity-only-enrollment) gate: a runtime Secret capability plus `DSH_SERVER_IDENTITY_ENROLLMENT_ONLY=1` permits a nonce/PKCE/cookie-bound identity probe. It returns signed evidence but creates no tenant, session or device access. Evidence uses an **independent operator-only** `DSH_SERVER_IDENTITY_EVIDENCE_KEY`, not the URL probe capability; missing/equal keys fail closed. Ordinary callbacks are denied during the gate; saved device credentials remain valid. Verify evidence HMAC with that independent key, pin the owner, remove temporary enrollment Secrets/gate, and only then admit ordinary users. Do not publish either key, identity evidence or enrollment URL.

### Browser and native handoff

QR landing confirms browser authorization while the originating client collects the result by polling. Direct native clients may use the supported `dshremote://oauth` return target. Arbitrary external return URLs are not supported.

The existing direct handoff may place a signed session bearer in a restricted same-origin/native query. Treat it as sensitive: OAuth responses are `no-store`/`no-referrer`, platform query redaction should be enabled, and full callback/QR URLs must not be shared. Query redaction does not hide QR IDs in paths or private identity evidence.

The default same-origin `/app` target is not a web application; this repository bundles no Remote workbench and unrelated routes return 418. Use a supported client flow.

## OIDC-only and legacy password fallback

For shared production use, set `DSH_SERVER_PASSWORD_LOGIN=disabled` in the ignored configuration and deploy with explicit `--config`. Password requests return `403 / PASSWORD_LOGIN_DISABLED`; `off`/`false` are recognized synonyms, but prefer `disabled` consistently. There is **no password-based multi-user signup**.

If deliberately enabled, `POST /api/v1/auth/login` checks only the configured account/password for the reserved original-owner partition. It does not create arbitrary users or authenticate other tenants. Rate limits, lockout and timing-equalized comparison are controls, not a justification for weak/reused secrets. Keep real passwords in Workers Secrets, using a long random independent value.

Current startup checks still require `DSH_SERVER_PASSWORD` (at least 8 characters) and `SESSION_SECRET` (at least 16), even with password login off; use much stronger independent secrets than these floors. Switching admission mode does not itself revoke old credentials. Old tenantless account sessions are rejected by the tenant-aware release and require re-login, while preserved legacy device credentials can continue in their partition. Plan a control-socket reconnect window during migration.

## Sessions and revocation

| Credential | Purpose / current lifetime | Revocation boundary |
| --- | --- | --- |
| Signed v2 server session | Tenant account login/registration; 8 hours, with live tenant validation | Expiry, signing-key rotation and applicable tenant-registry state; deleting one browser cookie is not bearer revocation |
| Device access token | Tenant-scoped device API/gateway authentication; 1 hour | Device/token revocation and expiry |
| Device refresh token | Renew its tenant/device credentials; 30 days | Revocation, expiry and refresh-reuse detection |
| Issued TURN credential | Provider allocation, configured TTL | Provider expiry/revocation; local cache deletion cannot retract a provider capability |

Refresh replay retains a consumed-token marker and revokes only the matching device in that tenant. Async issuance checks credential generation so an old refresh cannot issue a successor after re-registration. This is separate from the lifetime of credentials already delivered to a client.

`POST /api/v1/auth/logout` clears the browser cookie; it is not global logout. Password/account-label/allowlist/IdP-session changes or the OIDC-only switch are not substitutes for tenant/device revocation or signing-key rotation. Assess the affected credential class and verify the intended revocation path. A session-key rotation does not revoke device or provider TURN credentials.

`register-owned-role` allows an authenticated device to authorize a Host **within its own tenant**; it must not cross tenant boundaries. Retained legacy migration tables do not make a pre-tenant-code rollback safe—see the [rollback gate](MULTITENANCY.md#deployment-and-rollback-gate).

## Validation levels

Keep provider discovery/redirect checks, `prompt=none` callback acceptance, synthetic signed-provider workerd tests, real user client login, two-user cross-tenant rejection and forced TURN/network acceptance as separate evidence levels. A synthetic test is not a third-party audit or proof of every client/network.

Never enter another person's password or one-time code. Use disposable staging identities/devices and follow [testing](TESTING.md).
