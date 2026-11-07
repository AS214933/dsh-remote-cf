# Historical note: OAuth feasibility

> **Archived / superseded.** This summarizes an early protocol investigation, not the current setup guide. Some early conclusions about client browser entry and generic providers were corrected later. Use [authentication](AUTHENTICATION.md), [deployment](DEPLOYMENT.md) and [testing](TESTING.md).

## Useful protocol observation

The client-facing flow can be server-driven:

```text
GET  /api/v1/auth/oauth/providers
POST /api/v1/auth/oauth/qr/start?provider=logto
GET  /api/v1/auth/oauth/qr/{qrId}
```

A created flow returns a short-lived identifier and a same-server landing URL, for example:

```text
https://remote.example.com/api/v1/auth/q/<flow-id>
```

That landing page is not an image. It can redirect a browser to an identity provider while the originating client polls the server for completion. The server validates the provider identity and issues its own session credential; a provider access token is not automatically a server session.

## Corrections to the initial proposal

- Browser entry must not be dismissed as an unused field or unsupported concept. Supported clients may open a landing URL in a browser; client-specific behavior still needs real-client acceptance.
- “Any OAuth provider without client changes” was too broad. The current HTTP integration is specifically Logto OIDC, not an operator-configurable generic provider service.
- Callback state must be signed, browser-bound, short-lived and one-shot at the application flow boundary. OIDC ID tokens require actual signature/claim validation, not decoding alone.
- PKCE verifier ownership, nonce, verified email, provider/phase/expiry checks and destructive token collection are part of the implemented boundary, not optional finish work.
- OAuth authentication does not create tenant isolation. All allowed identities in one instance share its device namespace.

## Current implementation pointers

The supported flow uses the exact Logto callback `/api/v1/auth/oauth/logto/callback`, official SDK discovery/authorization/code exchange, confidential-client authentication and JOSE ID-token verification. See the [current authentication guide](AUTHENTICATION.md) rather than reusing the old proposal's SQL, routes, pseudocode, work estimates or generic-provider fixture.

The [browser redirect note](OAUTH-REDIRECT-FEASIBILITY.md) preserves the corrected conceptual distinction between QR/poll and direct native return. There is no claim here that every Android/desktop client version supports identical entry paths.
