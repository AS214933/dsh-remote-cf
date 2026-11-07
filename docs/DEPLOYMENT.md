# Deployment

[README](../README.md) · [Multi-tenancy and migration](MULTITENANCY.md) · [Authentication](AUTHENTICATION.md) · [Operations](OPERATIONS.md)

> One deployment now supports **logical OIDC tenants in one shared Gateway DO**, not per-user physical databases or resource reservations. Configure admission and original-owner migration before inviting users. The default capacity is ten tenant records; see the [tenant boundary and rollback gate](MULTITENANCY.md).

Examples use reserved domains/synthetic values. Real endpoints, tenant subjects, Cloudflare IDs, device details and secrets belong only in private configuration or runtime Secrets—not tracked files.

## Prerequisites

- Supported modern Node.js, at least 22.13 and compatible with the locked Wrangler version; prefer a supported LTS.
- npm and a Cloudflare account able to deploy Workers with SQLite-backed DOs.
- A reachable HTTPS public origin, for example `https://remote.example.com`.
- A confidential Logto web app for multi-user OIDC admission; optional Cloudflare Realtime TURN credentials.
- For an upgrade: private source/config backup and a supervised owner identity pin/enrollment plan.

Review [costs and shared quotas](OPERATIONS.md). The tenant cap is not a free-plan or availability guarantee.

## 1. Create a private configuration copy

```bash
npm ci
cp wrangler.jsonc wrangler.local.jsonc
```

PowerShell can use `Copy-Item`. Edit the ignored copy for Worker name, account, public URL and routes. Keep `GATEWAY` → `Gateway`, SQLite backing and the existing namespace/migration lifecycle unless deliberately planning a different data migration.

This is a **fragment**, not a complete config:

```jsonc
{
  "name": "my-remote-service",
  "workers_dev": false,
  "routes": [{ "pattern": "remote.example.com", "custom_domain": true }],
  "observability": { "enabled": true, "redact_query_string": true },
  "vars": {
    "DSH_SERVER_ACCOUNT": "owner@example.com",
    "DSH_SERVER_PUBLIC_URL": "https://remote.example.com",
    "DSH_SERVER_PASSWORD_LOGIN": "disabled",
    "DSH_SERVER_MAX_TENANTS": "10",
    "DSH_SERVER_OIDC_ADMISSION": "allowlist"
  }
}
```

Choose a custom domain or the actual `workers.dev` origin. Public URL must be an origin without path/query/fragment/credentials; use a canonical value without trailing slash. A custom domain must be available to the target account. Never copy another operator's IDs.

Use the same explicit target for secret changes and deployments. Bare Wrangler defaults do not choose a private copy. The wrapper refuses a bare deploy; use `npm run deploy -- --config wrangler.local.jsonc` or explicitly set `DSH_DEPLOY_CONFIG`.

```bash
git check-ignore wrangler.local.jsonc
npx wrangler whoami
```

Named copies such as `wrangler.staging.local.jsonc` are ignored too. Verify the exact path; ignore rules do not protect already tracked or force-added files.

## 2. Required runtime Secrets

Use interactive prompts, not real secrets in arguments, plain vars, issue reports or transcripts:

```bash
npx wrangler secret put SESSION_SECRET --config wrangler.local.jsonc
npx wrangler secret put DSH_SERVER_PASSWORD --config wrangler.local.jsonc
```

Current startup checks require a session secret of at least 16 characters and password secret of at least 8, even in OIDC-only mode. Use independent high-entropy random secrets, not merely the floor lengths. The password, if enabled, is only an original-owner fallback; it is not multi-user signup.

For Logto/TURN, set the additional Secrets described below. Automation should use narrowly scoped Cloudflare deployment authorization; do not commit auth environment or staging files.

## 3. Upgrade and original-owner migration gate

Read the complete [migration procedure](MULTITENANCY.md#original-owner-migration) before deploying over a single-account instance.

1. Run the isolated test gates, including `npm run test:tenant-runtime`.
2. Keep a private pre-change source/config backup; schedule account re-login/control-socket reconnect. The application transactionally moves old device/token state into reserved `legacy-owner` scope and retains original tables as private backup.
3. Pin exact `DSH_SERVER_LEGACY_OWNER_ISSUER` and `DSH_SERVER_LEGACY_OWNER_SUBJECT` **before that identity is admitted normally**. Email matching/first-login ownership is deliberately forbidden.
4. If the subject is unknown, set runtime Secret `DSH_SERVER_IDENTITY_PROBE_KEY`, a **different operator-only** `DSH_SERVER_IDENTITY_EVIDENCE_KEY`, and `DSH_SERVER_IDENTITY_ENROLLMENT_ONLY=1` for supervised [identity-only enrollment](MULTITENANCY.md#identity-only-enrollment). Its private `identity_probe` capability flow returns evidence signed by the independent evidence key but issues no session, creates no tenant and grants no device access. Missing/equal keys fail closed. Ordinary callbacks are denied while gated; saved device credentials remain valid.
5. Verify evidence HMAC privately with the evidence key—not the probe capability—confirm the user, configure exact owner issuer/subject, remove temporary enrollment Secrets/gate, then enable normal admission. Never publish the probe link, either key, evidence or subject.
6. Verify owner membership/devices, independent users and cross-tenant rejection before inviting more users.

Old tenantless account sessions require re-login; existing legacy device credentials remain scoped to the reserved partition. Pre-tenant WS attachments must reconnect. **Do not roll back to a pre-tenant binary after onboarding**: old code ignores tenant boundaries. Restore only with an explicit tenant-aware rollback/data plan.

The application schema migration happens in the existing Gateway storage. Do not create a new namespace or rename the Worker merely to get tenancy; that would abandon the intended legacy state rather than migrate it.

## 4. Logto OIDC and admission

Configure a confidential web app supporting authorization code, S256 PKCE and `client_secret_basic`. Use the tenant root HTTPS endpoint, without `/oidc` suffix. The exact redirect URI is:

```text
https://remote.example.com/api/v1/auth/oauth/logto/callback
```

Set nonsecret identity/admission settings in the ignored config:

```jsonc
{
  "LOGTO_ENDPOINT": "https://auth.example.com",
  "LOGTO_CLIENT_ID": "your-confidential-app-id",
  "DSH_SERVER_PASSWORD_LOGIN": "disabled",
  "DSH_SERVER_MAX_TENANTS": "10",
  "DSH_SERVER_OIDC_ADMISSION": "allowlist"
}
```

```bash
npx wrangler secret put LOGTO_CLIENT_SECRET --config wrangler.local.jsonc
```

- Default/unrecognized admission retains the verified-email allowlist. Default email is `DSH_SERVER_ACCOUNT`; `OAUTH_ALLOWED_ACCOUNTS` can replace it. Distinct verified issuer/subject identities become separate logical tenants.
- To trust Logto app-level admission, explicitly set `DSH_SERVER_OIDC_ADMISSION=application`. Configure and test the app access policy first. **No server-side roles-claim check is performed**; assigning a Logto role alone is not the required policy.
- `DSH_SERVER_MAX_TENANTS` defaults ten; disabled records count and a reserved owner slot remains until binding.
- Verified email must be present and `email_verified === true`. Tenant ownership is stable issuer/subject, not email.
- OIDC-only is recommended for shared production; no password-based multi-user registration is provided.

Current signatures support ES384, ES256 and RS256 with strict token validation. Do not replace verification with decoding to work around a setup error. See [authentication](AUTHENTICATION.md) for policy, browser handoff and revocation limits.

## 5. Optional Cloudflare TURN

```bash
npx wrangler secret put TURN_KEY_ID --config wrangler.local.jsonc
npx wrangler secret put TURN_KEY_API_TOKEN --config wrangler.local.jsonc
```

The TURN API token can mint provider credentials: keep it out of vars, code, build output and logs. Credential issuance is tenant/connection scoped, but issued provider capabilities can outlive local device/cache revocation until provider expiry. Signing credentials is not proof of TURN data-channel connectivity. Realtime bandwidth is a separate quota/cost meter; see [operations](OPERATIONS.md).

## 6. Deploy and verify

```bash
npm run typecheck
npm test
npm run test:runtime
npm run test:oauth-runtime
npm run test:tenant-runtime
npx wrangler deploy --config wrangler.local.jsonc
```

Check HTTPS health, unauthenticated rejection, provider discovery, correct callback and password refusal when OIDC-only. Then perform authorized owner binding and two-user isolation acceptance with controlled staging identities/devices, not unattended production test accounts. A redirect or synthetic runtime pass is narrower evidence than real client/tenant/network acceptance.

Current nonsecret settings include `DSH_SERVER_PUBLIC_URL`, Origin policy, optional concurrent-Host policy, heartbeat configuration and the tenant/admission settings above. Keep operational values out of tracked templates. Changing these is not a global logout; see [revocation](AUTHENTICATION.md#sessions-and-revocation).

## Git builds, logs and release hygiene

Follow [Workers Builds](OPERATIONS.md#连接-github可以而且不需要仓库公开) for explicit ignored config generation. It must propagate all required tenant admission/owner/enrollment settings for the intended rollout; do not assume a dashboard runtime var survives if the generated Wrangler vars omit it. The identity probe key remains a runtime Secret, never a public build value.

Enable query redaction before real OAuth traffic. It does not hide QR IDs in URL paths, identity evidence, runtime identifiers or Wrangler build output; keep logs private and redact before sharing. Read the [publication checklist](PUBLICATION.md) before committing or changing visibility.
