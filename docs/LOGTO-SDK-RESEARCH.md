# Historical note: Logto SDK selection

> **Archived / superseded.** The original SDK investigation preceded the current implementation and contained provisional advice that was later corrected. This summary preserves the useful integration lessons, not old deployment status, test totals or unsafe copy-paste snippets. See [authentication](AUTHENTICATION.md) and [deployment](DEPLOYMENT.md).

## Current division of responsibility

| Responsibility | Current choice |
| --- | --- |
| OIDC discovery, authorization URL, code-exchange parameters | Official `@logto/js` SDK |
| S256 verifier/challenge and signed/browser-bound flow state | Server code |
| Confidential-client authentication | Token-only SDK requester supplies Basic authentication |
| ID-token signature and claims | `jose`, using configured tenant JWKS and an explicit algorithm allowlist |
| Verified-email authorization, expiry and one-shot flow/token ownership | Server policy and Durable Object SQLite |
| DSH client QR/poll/direct-session bridge | Server routes |

The SDK does not replace server authorization policy. Decoding a JWT or trusting its field types is not a signature/issuer/audience/time/nonce check. Likewise, a valid provider identity is not automatically an allowlisted deployment identity.

## Findings that matter when maintaining the integration

1. **Requester returns parsed JSON.** Returning a Fetch `Response` to SDK helpers is not equivalent. Discovery uses the complete well-known URL expected by the installed SDK.
2. **Do not assume a `clientSecret` argument exists.** The inspected browser-friendly code-exchange helper sends protocol form fields but does not itself authenticate this confidential application. Authentication is injected only on its token requester, not discovery/JWKS calls.
3. **Use real signature verification.** Current code supports ES384, ES256 and RS256 explicitly, selects public signing keys and validates OIDC claims. RSA-only pseudocode is not a universal Logto integration.
4. **Honor Workers Fetch behavior.** Requests use manual redirects and check success; the unsupported edge `redirect: 'error'` mode is not a safe copy-paste choice here. Requests have bounded timeouts.
5. **PKCE/state ownership survives asynchronous work.** A verifier is written once, atomically claimed and erased before exchange. Expiration/provider/phase are checked at collection and completion, including after awaits.
6. **Request only necessary scopes.** `openid profile email` is the default. Reserved-scope behavior is explicit so `offline_access` is not silently requested for a flow that does not use refresh tokens.
7. **Consent is not an account-picker guarantee.** SDK prompt names should be documented by their actual semantics; client/provider UX still needs acceptance.

## Reproducible evidence, not frozen totals

The current Logto/OAuth unit suites inspect actual SDK request shapes and locally signed ID tokens. The isolated workerd test uses a synthetic ES384 provider to exercise full QR and direct callbacks without a human login or production network. See [testing](TESTING.md) for current commands and limits.

Old test filenames, total counts, “not deployed yet” statements and a generic OAuth mock are not evidence for the current implementation. Pin and inspect the installed SDK when upgrading rather than applying this note as a timeless statement about every Logto package/version.

The SDK alone does not establish isolation. The current port separately implements [logical OIDC tenancy and explicit legacy-owner migration](MULTITENANCY.md), keyed by verified issuer/subject rather than email.
