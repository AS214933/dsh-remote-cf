# Deployment

[README](../README.md) · [认证 / Authentication](AUTHENTICATION.md) · [Operations](OPERATIONS.md)

> **One instance is one shared account/device namespace.** It is not suitable for several independently isolated users, even if the intended group is small. Read the [single-account boundary](ARCHITECTURE.md#single-account-boundary) before deploying.

Examples below use reserved example domains and synthetic values. Replace them only in your ignored deployment configuration, never in tracked documentation or templates.

## Prerequisites

- A supported modern Node.js release, at least 22.13, compatible with the installed Wrangler version; a current supported LTS is recommended.
- npm and a Cloudflare account able to deploy Workers with SQLite-backed Durable Objects.
- A chosen HTTPS public origin, for example `https://remote.example.com`, reachable by both Host and clients.
- Optional: a Logto confidential web application and Cloudflare Realtime TURN credentials.

Free-plan availability and pricing are not guaranteed by this project. Check [operations and cost planning](OPERATIONS.md) before selecting a plan.

## 1. Create a private configuration copy

```bash
npm ci
cp wrangler.jsonc wrangler.local.jsonc
```

On Windows PowerShell, `Copy-Item wrangler.jsonc wrangler.local.jsonc` is equivalent. Edit the local copy to select your Worker name, account, public URL and routes. Keep the `GATEWAY` binding and SQLite migration definition unless deliberately planning a data migration.

The following is a **fragment**, not a complete configuration:

```jsonc
{
  "name": "my-remote-service",
  "workers_dev": false,
  "routes": [
    { "pattern": "remote.example.com", "custom_domain": true }
  ],
  "observability": {
    "enabled": true,
    "redact_query_string": true
  },
  "vars": {
    "DSH_SERVER_ACCOUNT": "owner@example.com",
    "DSH_SERVER_PUBLIC_URL": "https://remote.example.com"
  }
}
```

Choose either a custom domain or the actual `workers.dev` origin for your deployment; the public URL must be an origin with no path, query, fragment or trailing slash. A custom domain must be available to the Cloudflare account receiving this Worker. Do not copy another operator's account, zone or deployment identifiers.

Always select the same local file for secret changes and deployment. Bare Wrangler defaults do **not** automatically choose a private copy. The repository's deploy wrapper refuses a bare `npm run deploy`; if using it, pass `npm run deploy -- --config wrangler.local.jsonc` (or explicitly set `DSH_DEPLOY_CONFIG`). The direct Wrangler commands below also name the target.

```bash
git check-ignore wrangler.local.jsonc
npx wrangler whoami
```

Do not commit the local copy. Named copies such as `wrangler.staging.local.jsonc` are also ignored by the repository rule; verify the exact filename before use. Git ignore rules do not protect a file already tracked or added with force.

## 2. Set required secrets

Use the interactive secret prompts rather than placing real values in command arguments, tracked files or plain `vars`:

```bash
npx wrangler secret put SESSION_SECRET --config wrangler.local.jsonc
npx wrangler secret put DSH_SERVER_PASSWORD --config wrangler.local.jsonc
```

Current startup checks require `SESSION_SECRET` of at least 16 characters and `DSH_SERVER_PASSWORD` of at least 8. Use independent high-entropy random values rather than treating these floors as strength recommendations. Both remain required even when password login is disabled.

Do not paste secret values into issue reports, deployment logs or terminal transcripts. Prefer a narrowly scoped Cloudflare API token for automation; do not commit its environment or secret-staging file.

## 3. Deploy and check the public origin

```bash
npm run typecheck
npm test
npx wrangler deploy --config wrangler.local.jsonc
```

After deployment, verify `/healthz`, HTTPS certificate validity and expected authentication behavior. `/` normally returns 418; that is not a failed deployment. There is no bundled Remote web workbench.

Point both Host and clients at the same public origin. A separate deployment has separate state and secrets; changing the selected server may require a new login and device registration. Do not repurpose a deployment holding real devices as a disposable test target.

## 4. Optional Logto OIDC

Add non-secret settings to the local configuration:

```jsonc
{
  "vars": {
    "DSH_SERVER_ACCOUNT": "owner@example.com",
    "DSH_SERVER_PUBLIC_URL": "https://remote.example.com",
    "LOGTO_ENDPOINT": "https://auth.example.com",
    "LOGTO_CLIENT_ID": "your-application-id"
  }
}
```

`LOGTO_ENDPOINT` is the HTTPS tenant origin, with **no `/oidc` suffix**. The implementation expects issuer `<tenant-origin>/oidc` and authorization/token/JWKS endpoints on that same origin. This is Logto integration, not a generic promise to support every OIDC provider layout.

Create/configure a confidential web application that supports `client_secret_basic`. Register this exact callback in that application:

```text
https://remote.example.com/api/v1/auth/oauth/logto/callback
```

Then set the secret on the same Worker:

```bash
npx wrangler secret put LOGTO_CLIENT_SECRET --config wrangler.local.jsonc
npx wrangler deploy --config wrangler.local.jsonc
```

Default scopes are `openid profile email`. The chosen user must provide the configured, allowlisted email with `email_verified: true`. Do not widen the email allowlist to simulate independent tenants: all accepted identities still share one device namespace. See [authentication](AUTHENTICATION.md).

### OIDC-only login

First validate Logto discovery, callback registration and a real sign-in using a disposable test device. Then put this in the local configuration's `vars` and redeploy:

```jsonc
"DSH_SERVER_PASSWORD_LOGIN": "disabled"
```

The password endpoint should return `403` with `PASSWORD_LOGIN_DISABLED`. Existing signed sessions and registered device credentials are **not** automatically revoked by this switch. Do not delete the required password/session secrets; startup still requires them. To re-enable password login, remove the setting or use an enabled value and redeploy.

A provider redirect, a `login_required` response from a non-interactive probe, and successful real user login are different validation levels. Follow the [neutral checklist](LOGTO-DEPLOYMENT.md) rather than assuming a public health check proves authentication.

## 5. Optional Cloudflare Realtime TURN

```bash
npx wrangler secret put TURN_KEY_ID --config wrangler.local.jsonc
npx wrangler secret put TURN_KEY_API_TOKEN --config wrangler.local.jsonc
npx wrangler deploy --config wrangler.local.jsonc
```

The API token can issue billable/limited TURN credentials: never expose it to clients, logs or plain configuration vars. The optional `TURN_CREDENTIAL_TTL_SECONDS` defaults to 86400 and is bounded by the implementation. Credential cache retention is separate from provider credential lifetime; see [latency design](CONNECTION-LATENCY.md).

Workers do not host a TURN server. This code issues Cloudflare Realtime TURN credentials and forwards signaling. Successful issuance proves API permission and response format, not allocation or data relay through a restrictive network. The encrypted server Relay path is a separate fallback.

## Useful non-secret settings

| Setting | Purpose |
| --- | --- |
| `DSH_SERVER_ACCOUNT` | Single deployment account; use the same normalized email for OIDC identity |
| `DSH_SERVER_PUBLIC_URL` | Canonical public HTTPS origin |
| `DSH_SERVER_PASSWORD_LOGIN` | `disabled` rejects new password logins |
| `DSH_SERVER_ALLOWED_ORIGINS` | Explicit comma-separated browser API origins; not an authorization boundary or tenant list |
| `DSH_SERVER_ROOT_PAGE` | `assets` opts into the root placeholder asset; otherwise the root is 418 |
| `DSH_SERVER_ALLOW_CONCURRENT_HOSTS` | `1` permits concurrent links for compatible operational scenarios; not extra accounts |
| `LOGTO_API_RESOURCE` / `LOGTO_SCOPES` | Optional resource and extra comma-separated scopes; do not request unnecessary permissions |
| `DSH_SERVER_HEARTBEAT_INTERVAL_MS` | Optional bounded heartbeat interval; normally leave at its default |

OAuth start intentionally applies its own same-origin browser checks. Adding a CORS origin does not make arbitrary third-party browser login flows supported.

## Updating credentials or account settings

Edit only the ignored local config and use the same explicit target for every operation:

```bash
npx wrangler secret put DSH_SERVER_PASSWORD --config wrangler.local.jsonc
npx wrangler deploy --config wrangler.local.jsonc
```

Changing a password, account label or OIDC mode is not a global logout. Session-key rotation and device revocation address different credential classes; see [revocation limits](AUTHENTICATION.md#sessions-and-revocation).

## Logs and release hygiene

Enable query redaction before any real OAuth traffic. Callback queries contain authorization codes/state, and the existing direct client handoff can contain a session bearer. Query redaction does not remove QR identifiers in URL paths or identifiers in custom log messages; keep log access/retention narrow and redact before sharing.

Review the [publication checklist](PUBLICATION.md) before committing or changing repository visibility. Costs, quota monitoring and Git-based deployments belong in [operations](OPERATIONS.md).
