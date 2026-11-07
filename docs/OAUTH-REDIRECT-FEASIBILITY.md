# Historical note: browser redirect entry

> **Archived / superseded.** This records a corrected conceptual finding from earlier OAuth research. It is not a transcript of a public service, a current callback contract for arbitrary providers, or proof that all client versions behave the same. Current supported behavior is in [authentication](AUTHENTICATION.md).

## The important correction

A QR code can encode a server landing URL. Opening that URL in a desktop browser and scanning it with a phone can reach the same redirect page:

```text
client creates QR/poll flow
  → https://remote.example.com/api/v1/auth/q/<flow-id>
  → browser redirects to configured Logto tenant
  → callback is verified by server
  → originating client collects its session once
```

Thus “QR flow” does not mean the landing URL is an image or that browser opening is inherently unsupported. It also does not mean every client consumes every advertised URL in the same way; validate the supported client revision.

## QR versus direct native delivery

- **QR/poll:** the browser confirms authorization, while the client that created the flow polls for its own server session token.
- **Direct:** a supported native return target can receive a server session through the existing direct handoff contract.

Both require signed state, a browser-state cookie, short expiry, PKCE and one-shot flow handling. Current OIDC login also validates nonce, ID-token signature/claims and verified email under the selected admission policy.

The direct return target must remain allowlisted; arbitrary URLs would leak the issued session. The current native target is `dshremote://oauth`, with narrow same-origin alternatives. A default `/app` return does not imply a web workbench exists in this repository. Callback and token-query URLs are sensitive even with private response headers; redact logs and do not share them.

## Limits of this historical investigation

The earlier generic GitHub/other-provider sketches, copied response examples, live service identifiers, effort estimates and SQL drafts are intentionally not retained as setup instructions. Current routes select Logto explicitly. The earlier generic mock cannot stand in for the [real-assertion synthetic OIDC runtime test](TESTING.md#isolated-regression-gate).

A browser redirect alone does not add tenant isolation. The current port separately implements [logical OIDC tenancy and safe legacy-owner binding](MULTITENANCY.md); this historical redirect investigation is not its authorization design.
