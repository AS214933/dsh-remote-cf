# Logto and TURN verification checklist

> This neutral checklist replaces an instance-specific deployment diary. It contains no service endpoint, credential, device record or deployment version. The current setup instructions are [deployment](DEPLOYMENT.md) and [authentication](AUTHENTICATION.md).

## Before enabling Logto

- [ ] Review [logical OIDC tenancy and legacy-owner migration](MULTITENANCY.md); an email allowlist alone is not tenant isolation. Pin the verified original issuer/subject before normal login admission.
- [ ] Use a confidential Logto web application supporting `client_secret_basic`.
- [ ] Set the tenant HTTPS origin without `/oidc`; confirm the expected same-origin discovery/token/JWKS layout.
- [ ] Register the exact callback, for example `https://remote.example.com/api/v1/auth/oauth/logto/callback`.
- [ ] Set the client secret through the same explicit private `--config` target as deployment.
- [ ] Confirm boolean `email_verified: true` and choose default allowlist or explicit Logto application admission; application mode does not enforce a server-side role claim.
- [ ] Enable query-string redaction and restrict access/retention for OAuth logs. QR IDs in paths and custom log fields require separate care.

## Isolated code checks

```bash
npm ci
npm run typecheck
npm test
npm run test:runtime
npm run test:oauth-runtime
npm run test:tenant-runtime
npm run test:enrollment-runtime
```

The isolated suites exercise SDK confidential-client request shape, S256 PKCE, signed browser state, nonce, real test-token signatures, verified-email policy, one-shot claim/collection, expiry, schema migration and hibernation behavior. They do not authenticate a real person or prove a deployed network path.

## Deployment acceptance

- [ ] HTTPS and `/healthz` respond as expected; root 418 is normal.
- [ ] Provider discovery exposes Logto only when all required settings are configured.
- [ ] The start redirect uses the expected tenant, exact callback, nonce, S256 challenge and secure state cookie.
- [ ] Invalid or missing state/browser cookie is rejected before token exchange.
- [ ] A real owner completes a supported QR or native-client sign-in on a disposable staging device.
- [ ] Unverified email and identities outside the selected admission policy are rejected; token collection is one-shot.
- [ ] Two independent users cannot list, mutate, connect, Relay or fetch TURN for each other's devices, including overlapping device IDs and hibernation recovery.
- [ ] Original owner's membership/device data is retained; temporary probe/evidence Secrets are removed and only tenant-aware rollback revisions are permitted.
- [ ] Logs and test output contain no authorization code, token, cookie, verifier, QR URL or credential bytes.

A non-interactive authorization request returning `login_required` can confirm app/callback acceptance without user login. It is not a substitute for actual owner sign-in. Do not post full redirect URLs to show this result.

## OIDC-only acceptance

After successful real sign-in, set `DSH_SERVER_PASSWORD_LOGIN=disabled` and redeploy the same private config:

- [ ] New password login returns `403 / PASSWORD_LOGIN_DISABLED`.
- [ ] Logto remains available and usable.
- [ ] Required password/session secrets remain configured for current startup checks.
- [ ] Operators understand that existing signed sessions and device credentials are not revoked by the mode switch.

## TURN acceptance

- [ ] TURN key/API token are Secrets, not vars or client-visible configuration.
- [ ] An authorized negotiating device can obtain an ICE list and unauthorized requests are rejected.
- [ ] A credential-issuance test is recorded only as issuance validation.
- [ ] If network fallback is required, a separate disposable-client test forces TURN and confirms real allocation/data-channel traffic.
- [ ] Cache invalidation is not misrepresented as provider-side credential revocation.

## Recordkeeping

Record exact source revision, synthetic/real environment and evidence boundaries. Keep private instance domains, account/zone/Worker identifiers, device identities and deployment-specific versions in private operator records, not this public checklist. Remove only devices/state created by a test invocation; never run broad production cleanup to make a report look clean.
