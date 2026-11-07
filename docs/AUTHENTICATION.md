# Authentication

[README](../README.md) · [Deployment](DEPLOYMENT.md) · [Architecture](ARCHITECTURE.md)

## One shared account, regardless of login method

A deployment has one configured `DSH_SERVER_ACCOUNT`, one Gateway device namespace and no per-user ownership partition. Password login is available by default; Logto OIDC is optional; password login can be disabled after OIDC has been validated.

**An email allowlist is admission control, not multi-tenancy.** Multiple accepted Logto identities do not receive isolated hosts, devices, sessions or quotas. A requirement for up to ten different, mutually isolated accounts is not supported by one current instance. Do not add emails and assume isolation. Use separately operated deployments or implement and independently test an actual tenancy design before serving unrelated users.

## Password login

`POST /api/v1/auth/login` checks the one configured account/password and issues the server's signed session credential. The implementation includes rate limits, account lockout and timing-equalized comparisons. These are controls, not a security certification or justification for a weak/reused password.

Real passwords belong in Cloudflare Secrets. The current startup floor is 8 characters, but operators should use a long, random, independent secret. The startup check also requires a session-signing secret of at least 16 characters. Exact account spelling matters for password authentication; a normalized email is simplest when sharing identity with OIDC.

## Optional Logto OIDC

Current supported integration uses the authorization-code flow:

1. A client discovers the `logto` provider.
2. It starts a short-lived QR flow and polls, or opens the direct Logto start URL.
3. The server redirects a browser to Logto with S256 PKCE, signed state and a nonce. A secure browser-state cookie binds the response to the initiating browser.
4. The server exchanges the authorization code using confidential-client Basic authentication and verifies the ID token against the configured tenant JWKS.
5. Only an explicitly verified, allowlisted email can receive this server's own session credential.
6. The verifier/flow is consumed once; QR token collection is also single-use and expiration is enforced.

The official `@logto/js` SDK handles discovery, authorization URL and code-exchange protocol details. `jose` performs signature and claim validation; SDK decoding alone is not authorization. The current allowlist of ID-token signature algorithms is ES384, ES256 and RS256, with issuer, audience/authorized-party, time, subject and nonce checks.

The tenant must use the expected HTTPS Logto endpoint layout. Discovery cannot redirect client authentication to an unrelated token origin. Setup and the exact callback are documented in [deployment](DEPLOYMENT.md#4-optional-logto-oidc).

### Identity policy

- Default allowed email is `DSH_SERVER_ACCOUNT`, compared as a normalized email for OIDC.
- `email_verified` must be the boolean `true`; missing, false or string values are rejected.
- The provider authenticating a user does not automatically authorize that user for this deployment.
- `OAUTH_ALLOWED_ACCOUNTS` can replace the accepted-email list, but **does not add per-account isolation**. For the intended single-owner deployment, leave it unset or keep it to that owner.
- The app asks for `openid profile email` by default and does not add `offline_access` automatically. Extra scopes/resources require an explicit operator choice.
- Generic provider configuration left in historical code/notes is not a supported public setup guide. Current HTTP provider routing is specifically Logto.

### Browser and native handoff

QR landing and direct entry are related but distinct delivery paths. The QR browser confirms authorization while the originating client collects a token by polling. Direct native clients may use the supported `dshremote://oauth` callback. Return targets are restricted; arbitrary external redirects are not supported.

The existing direct handoff may place a signed session bearer in a same-origin/native callback query. Treat that URL as sensitive. OAuth responses use `no-store` and `no-referrer`; also enable platform query-log redaction and avoid sharing full callback/QR URLs. This client contract is not a recommendation to put tokens in arbitrary URLs.

The default same-origin `/app` target does not create a web application: this repository has no bundled Remote workbench and unrelated routes return 418. Use a supported client flow rather than assuming browser sign-in supplies a web UI.

## OIDC-only mode

Set `DSH_SERVER_PASSWORD_LOGIN=disabled` in the ignored deployment config and redeploy with an explicit `--config`. Password login then returns `403 / PASSWORD_LOGIN_DISABLED` instead of validating the supplied password. `off` and `false` are also recognized, but use the documented `disabled` value consistently.

Keep `DSH_SERVER_PASSWORD` and `SESSION_SECRET` configured: current startup checks still require both. This switch changes **new login admission only**. It does not invalidate an already issued session, refresh token, device access token or an existing registered device. Verify a real owner sign-in before closing your fallback path.

## Sessions and revocation

Authentication creates more than one credential class; they must not be confused:

| Credential | Current purpose / lifetime | Revocation boundary |
| --- | --- | --- |
| Signed server session | Account-level login and device registration; currently 8 hours | Expiry or session-signing-key rotation; clearing a browser cookie alone does not revoke copies of the bearer |
| Device access token | Device API and gateway authentication; currently 1 hour | Device/token revocation and expiry |
| Device refresh token | Renew device credentials; currently 30 days | Device/token revocation, expiry and refresh-reuse handling |
| Issued TURN credential | Provider-side allocation; operator-configured TTL | Provider-side expiry/revocation; deleting the local cache is not provider revocation |

`POST /api/v1/auth/logout` clears the browser session cookie; it is not global logout. Changing the password, account label, email allowlist, IdP session or OIDC-only flag does not revoke all credentials previously issued by this server. A leaked session can remain usable until its own boundary is addressed.

For an incident, identify the affected credential class. Rotate the relevant secret, revoke affected registered devices, and verify the resulting behavior. Session-key rotation invalidates signed account sessions but is not a substitute for revoking device credentials or already issued TURN credentials. Do not promise instantaneous retraction of responses already delivered to a client.

Single-account trust is also relevant to `register-owned-role`: an already authenticated device can authorize registration of a Host in the same shared deployment. This is not a cross-user authorization model.

## Validation levels

Keep these claims separate:

- Provider discovery and authorization redirect: configuration/entry-point checks.
- A non-interactive `prompt=none` response such as `login_required`: app/callback acceptance without authenticating a person.
- A synthetic signed-provider workerd test: local protocol and runtime regression coverage.
- A real owner completing login in a supported client: integration acceptance.
- Forced TURN allocation/data flow and sustained device connectivity: separate network acceptance.

Never enter someone else's password or one-time code as a testing shortcut. Use a disposable staging device/account you control, avoid production state mutation, and follow [testing guidance](TESTING.md).
