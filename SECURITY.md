# Security policy

This independently maintained server port now provides **logical OIDC tenant isolation in one shared Gateway Durable Object**, keyed by verified issuer/subject rather than email. It does not provide separate processes/physical databases, reserved per-tenant quota, a managed SLA or independent security certification. Review [multi-tenancy and migration](docs/MULTITENANCY.md), [architecture](docs/ARCHITECTURE.md) and [authentication](docs/AUTHENTICATION.md) before sharing an instance.

## Reporting a vulnerability

Use **Security → Report a vulnerability** if private reporting is enabled. Do not put exploit details, live URLs, tokens, tenant subjects, identity-enrollment evidence, device identifiers or raw logs in a public issue. If private reporting is unavailable, request a private channel without sensitive details, or use a published maintainer profile contact method.

Include the exact source revision, synthetic reproduction, affected configuration and impact. Use disposable local identities/devices; cross-tenant reports should demonstrate unauthorized behavior with test tenants you control, not someone else's deployment or credentials.

## Operator responsibilities

- Keep runtime Secrets, private deployment identity, owner subject pins, probe capabilities and identity evidence out of Git/log sharing. Restrict deployment builds and untrusted previews.
- Choose OIDC admission deliberately. Default is the verified-email allowlist; `application` trusts correctly configured Logto application access policy and **does not enforce a server-side roles claim**. Tenant records have no account-count cap by default (`DSH_SERVER_MAX_TENANTS` unset, empty or `0`); only an explicit safe positive integer enables a cap. Invalid values fail closed with `503 / TENANT_CONFIG_INVALID`, not an unlimited/default fallback. No account-count cap does not remove per-tenant/global resource bounds or platform quotas, or provide a security audit/resource reservation.
- Prefer OIDC-only for shared production. Any enabled password fallback belongs only to the reserved original-owner partition; it is not multi-user password signup.
- Supervise original-owner migration. Never infer ownership from matching email/first login. Identity-only enrollment must issue no ordinary session/device access. Evidence signing uses a separate operator-only Secret, never the URL probe capability; remove temporary enrollment Secrets/gate after verification.
- **Never roll back to a pre-tenant binary after onboarding.** Older code ignores tenant scoping. Retained legacy backup tables do not make ordinary old-version rollback safe; follow the [tenant-aware rollback gate](docs/MULTITENANCY.md#deployment-and-rollback-gate).
- Monitor account-wide Cloudflare quotas and singleton resource contention. Per-tenant access isolation/limits do not prevent every shared availability or billing impact.
- Review dependency updates and test both same-tenant success and cross-tenant rejection. Synthetic tests are not proof of every client/network or an independent penetration test.

Logout/cookie removal does not revoke every issued session/device/provider credential. Apply the relevant tenant/device revocation or key rotation when compromise is suspected and verify behavior; historical source cleanup is not credential revocation. See [revocation boundaries](docs/AUTHENTICATION.md#sessions-and-revocation) and [publication hygiene](docs/PUBLICATION.md).
