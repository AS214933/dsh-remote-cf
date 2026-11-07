# Security policy

This is an independently maintained single-account server port. It has no security
certification, managed service SLA, or supported multi-tenant isolation. Do not
onboard unrelated users into one deployment's device pool; see
[architecture](docs/ARCHITECTURE.md) and [authentication](docs/AUTHENTICATION.md).

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** private-reporting flow
if enabled. Do not put exploit details, live URLs, tokens, device identifiers or
logs in a public issue. If private reporting is unavailable, open a minimal issue
requesting a private contact channel without sensitive details, or contact the
maintainer through their published GitHub profile contact method.

Include the source revision, synthetic reproduction steps, impact and affected
configuration. Use disposable local accounts and test identities. Do not test
against someone else's deployment or send real credentials as a reproduction.

## Operator responsibilities

Keep runtime secrets out of Git and logs, restrict OIDC verified-email access,
review dependency updates and account-wide Cloudflare quotas, protect deployment
build settings and disable untrusted preview builds. Logout/cookie removal does
not revoke all already issued bearer/device credentials. Rotate/revoke affected
credentials when compromise is suspected; history rewriting alone is not
revocation. See the [publication checklist](docs/PUBLICATION.md).
