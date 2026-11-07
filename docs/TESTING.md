# Testing and validation boundaries

[README](../README.md) · [Architecture](ARCHITECTURE.md) · [Connection latency](CONNECTION-LATENCY.md)

## Prerequisites

Use a supported modern Node.js release **at least 22.13**, compatible with the locked Wrangler version; prefer a current supported LTS. The OAuth lifecycle tests use native `node:sqlite`; older Node versions cannot run the full suite. Install from the lockfile:

```bash
npm ci
```

Native workerd dependencies must be available for runtime tests. Some diagnostic scripts additionally require an explicitly selected upstream checkout and separate TypeScript/WebRTC tooling; those are not prerequisites for the standard isolated test gate.

## Isolated regression gate

```bash
npm run typecheck
npm test
npm run test:runtime
npm run test:oauth-runtime
npm run test:tenant-runtime
npm run test:enrollment-runtime
git diff --check
```

Do not hard-code the test count as a guarantee; use the result of the exact revision being released. These tests exercise different layers:

| Suite | Scope |
| --- | --- |
| Protocol / crypto / Worker Vitest suites | Decoder and bounds, session cryptography, response contracts, routing and configuration |
| Gateway lifecycle Vitest suite | Actual Gateway handlers with controlled sockets/store/runtime base, restored attachments, replacement ownership and deadline behavior |
| TURN cache Vitest suite | Singleflight, per-device separation, capacity, fixed TTL/margin, failures and stale-flight ownership |
| Logto / OAuth lifecycle Vitest suites | Signed test ID tokens, admission/enrollment policy, SDK request shape, real in-memory SQLite flow migration, one-shot claim/collection and expiry |
| Tenant Store / Worker / Gateway / session suites | Stable issuer/subject identity, tenant-bound principals/credentials, owner pin/migration, no account-count cap by default (`0`), optional positive cap/invalid-config rejection, resource bounds and cross-tenant negative paths |
| `test:runtime` | Real Miniflare/workerd Gateway, controlled credential issuer and explicit hibernation/wake cycles |
| `test:oauth-runtime` | Real workerd QR/direct callback with a synthetic ES384 provider, PKCE, confidential authentication, nonce, browser state and session authorization |
| `test:tenant-runtime` | Real workerd two-user isolation checks in the current singleton Gateway model, using disposable local state |
| `test:enrollment-runtime` | Real workerd verified identity evidence with independent operator-only HMAC key, no tenant/session/legacy claim and normal-login gate |

The runtime scripts use real assertions and disposable local state. Provider/network calls are intercepted for their synthetic scenarios; they do not require production credentials or real registered devices. Tenant tests exercise logical isolation in one Gateway, not per-user physical databases/processes or independent quota allocations. The unit/runtime gate is not a third-party security audit, real-phone/real Logto-user test, cross-network TURN test or long-duration production acceptance test.

The [multi-tenancy migration/rollback gate](MULTITENANCY.md#deployment-and-rollback-gate) is part of release preparation. Old tenantless sessions need re-login, pre-tenant sockets need reconnect, and a pre-tenant binary is not a safe rollback once independent users have been admitted.

## Local development server

Use an explicit local-only configuration and port:

```bash
npx wrangler dev --config wrangler.dev.jsonc --port 8790
```

Values in the development config are synthetic fixtures, never production credentials. Keep test requests aligned with that port and its public-URL setting. The current development config does not connect to an external identity provider. Historical generic OAuth mock scripts and their old `OAUTH_PROVIDERS` fixture do **not** validate the current Logto integration; prefer the isolated OAuth runtime test above. Do not deploy the development configuration.

If source/configuration changes alter these fixtures, inspect the current command help and config rather than assuming a particular historical script is still a release gate.

## Legacy live diagnostics are not release gates

Older scripts such as the following are manual diagnostic aids:

- `host-connect.mjs`, `client-flow.mjs`, `data-plane.mjs` and `rpc-tunnel.mjs`
- `webrtc-path.mjs`, `turn-relay.mjs` and `soak.mjs`
- `oauth-e2e.mjs`, `endpoint-contract.mjs`, `reconnect-race.mjs` and `verify-peer-shape.mjs`

Some historical `ok(name, detail)` helpers recorded success even when a caller supplied a false predicate as display text. The old generic OAuth fixture also predates the present Logto path. Consequently, old PASS totals and previously published transport/security success tables are **not authoritative validation** of the current revision. An endpoint-presence check accepting any non-404 response does not prove authorization or response-schema correctness.

Before promoting any such script to a gate:

1. Inspect its current assertions and fail paths.
2. Deliberately provide a false/mutated result and verify the process exits nonzero.
3. Record the exact server/client/upstream revisions and isolated environment.
4. Rerun with disposable state; document what it actually proves and what it does not.

Do not infer “all transports work” from a successful ICE credential response or a label printed by a helper.

## Destructive and credential-sensitive tools

**Do not run maintenance helpers as part of routine tests or against a live owner's profile.**

`cleanup-devices.mjs` can revoke matching remote devices. `fix-host-claim.mjs` is an operational repair tool that can read and replace an existing Host credential store; re-registration can invalidate earlier device tokens. Their location under `test/` does not make them isolated or harmless.

The current cleanup helper defaults to dry-run and needs `--apply` for revocation. The repair helper additionally requires an explicit `--state-root`; without `--apply` it checks paths only. Before use, read the current script, require an explicit disposable target/state directory, and understand its backup/side effects. Never use broad account cleanup as a substitute for tracking devices created by that invocation. Cleanup dry-run still makes authentication/listing requests even though it does not delete anything.

Legacy tools historically accepted passwords as arguments or printed credential prefixes; do not follow old command transcripts. Current maintenance helpers use `DSH_TEST_PASSWORD` from a protected environment, not a password argument. Environment injection is not a secret vault: do not put a real value into shell-history examples, logs or a committed environment file. Review each tool's current input/output behavior before using real credentials; redact all authentication material and do not post raw callback/QR URLs.

## Real integration acceptance

Use a separately controlled staging deployment and disposable devices. Recommended evidence is layered:

1. HTTPS/health and expected unauthenticated rejection.
2. Provider discovery, exact callback registration and confidential-client authentication.
3. A real authorized user completing Logto login through a supported client.
4. Supervised original-owner identity evidence/pin and preserved membership/device access, following [migration](MULTITENANCY.md#original-owner-migration); no first-login/email ownership inference.
5. Two distinct issuer/subject users, separate device lists/credentials/peers, allowed same-tenant operations and denied cross-tenant API, WS, Relay/signaling and TURN paths. Reuse a synthetic device ID across tenants to exercise composite scoping where the client contract permits.
6. Application admission behavior under the real Logto app access policy (no server-side role claim check), default allowlist rejection, unset/empty/`0` no-account-count-cap behavior, optional safe positive cap (including owner reservation only then), invalid setting `503 / TENANT_CONFIG_INVALID`, and enrollment-only normal-login rejection.
7. Device registration, descriptor/pinning and the client's encrypted tunnel; LAN/P2P and, where required, explicitly forced TURN data-channel traffic—not only credential issuance.
8. Tenant-scoped refresh replay/revocation, reconnect, deployment interruption and sustained/network-change behavior. Use only a tenant-aware rollback revision after onboarding.

Do not enter another person's password/OTP or create unattended production devices. Remove only staging devices and temporary files created by the test itself. Keep raw credentials, identity stores and network traces out of Git.

## Regression comparisons

The Gateway runtime can compare prior setup behavior with the optimized path when the named Git revision is available:

```bash
SETUP_SOURCE_REF=8e07c6d node test/gateway-runtime.mjs
```

This uses a historical source control revision, not a deployment identifier. A synthetic delayed issuer isolates server waiting and cannot predict a phone's end-to-end setup time. See the [latency guide](CONNECTION-LATENCY.md) for sample boundaries and cache trade-offs.
