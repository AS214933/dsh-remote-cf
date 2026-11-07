# OIDC multi-tenancy and migration

## Identity and isolation

Each verified OIDC `issuer + sub` maps to a stable server tenant. Email is verified
admission/display metadata, never a tenant lookup key. A changed email retains its
namespace; two different subjects sharing an email do not share devices.

This release keeps one Gateway Durable Object for client compatibility: opaque
saved device credentials and first-frame WebSocket hello still work without a
client update. Isolation is logical, not separate processes/physical databases.
Device SQL keys are `(tenant_id, device_id)`. Credential digests identify their
own tenant; callers cannot select a tenant with a header/query/body value.

Sessions are signed v2 principals and validated against the live tenant registry.
Old tenantless account sessions require re-login. Per-tenant API lists, peer key
lookups, mutation, owned-Host registration, refresh/revoke, WS peer/link maps,
snapshots, Relay/signaling targets and TURN caches all use authenticated scope.

## Admission policy

- Default/unrecognized `DSH_SERVER_OIDC_ADMISSION` retains the configured verified
  email allowlist.
- Explicit `application` trusts a successfully verified login to this Logto app
  with a verified email. This **does not validate a roles claim**. Configure Logto
  application access policy correctly before enabling it. Assigning a role in
  Logto without a policy/claim check is not itself server-side authorization.
- `DSH_SERVER_MAX_TENANTS` defaults10. One reserved slot remains for the original
  owner until binding. Disabled users still count toward capacity.
- Password fallback, if enabled, belongs only to the reserved owner partition;
  it is not a password-based multi-user signup service. OIDC-only is recommended.

## Original owner migration

Old device/token tables are transactionally copied into a reserved `legacy-owner`
partition; original tables remain as private same-database backup tables. Device
IDs, identity keys, credential digests, expiration/revoked states and the old
membership handle are preserved. Old pending OAuth flows are invalidated.

The owner is **never inferred from the first login or matching email**. Configure
exact `DSH_SERVER_LEGACY_OWNER_ISSUER` and `DSH_SERVER_LEGACY_OWNER_SUBJECT` before
that identity's first normal tenant admission. The registry aliases only this
pinned identity to the reserved partition; other users get independent tenants.
Existing legacy device credentials may continue within their partition while
owner binding is pending. Existing authenticated control sockets must reconnect
because pre-tenant attachments cannot safely establish tenant authority.

### Identity-only enrollment

If the original subject is unknown, temporarily set the runtime Secret
`DSH_SERVER_IDENTITY_PROBE_KEY` to a high-entropy capability and set
`DSH_SERVER_IDENTITY_ENROLLMENT_ONLY=1` before migration. Open a private start URL
with `identity_probe=<capability>`. The signed flow uses the existing nonce/PKCE/
browser-cookie checks, returns signed identity evidence, and **does not create a
tenant, issue a session, or grant device access**. Normal OIDC callbacks are denied
while the enrollment-only gate is set; saved device credentials remain valid.

Use an **independent**, operator-only runtime Secret
`DSH_SERVER_IDENTITY_EVIDENCE_KEY` to sign/verify evidence. Never sign evidence
with the capability disclosed in the start URL; that would let its recipient
forge identities. Equal or missing keys fail closed.

The operator verifies the evidence HMAC using this independent Secret, confirms the
user, pins exact issuer/subject, removes the probe Secret and enrollment gate, then
admits ordinary users. Never post the capability, identity evidence, subject,
operator endpoint or device list in this public repository. Do not publish a
public enrollment link. Treat this as a one-time supervised operation, not signup.

## Limits and shared fate

Current bounds:64 device rows,1,024 active credential rows and50,000 used-refresh
replay markers per tenant; used markers expire with their original refresh TTL
and are separately bounded.32 online peers/16 links per tenant, with global256
peer/link ceilings. Global pre-auth sockets, SQL storage, event execution and
Cloudflare quotas remain shared. These limits reduce accidental exhaustion but
are not reserved per-user capacity or a usage-billing system.

Refresh replay retains a consumed-token marker and revokes only that tenant's
matching device. Async issuance validates a credential generation so an old
refresh cannot mint a new pair after same-device re-registration. Issued TURN
credentials are provider capabilities until expiration; revoking a local device
cannot retroactively cancel already issued TURN credentials.

## Deployment and rollback gate

1. Run the tenant Store/Worker/Gateway/OIDC/session/enrollment tests and real
   `npm run test:tenant-runtime` two-user isolation test.
2. Keep a private pre-change source/config backup; migration itself transactionally
   retains old device/token tables. Plan a reconnect and account re-login window.
3. Enable enrollment-only first, verify owner evidence/pin, then enable desired
   admission. Do not let normal login allocate the owner's identity prematurely.
4. Verify original membership/devices, two independent users and cross-tenant
   rejection before inviting more users. Never create unattended production test
   devices; synthetic tests use local workerd state only.
5. **Never roll back to a pre-tenant binary after onboarding.** Old code ignores
   tenant columns and can expose/mutate all partitions. Roll back only to a tested
   tenant-aware revision, or stop service and perform an explicitly planned private
   restore with understood loss of newer tenant data. Archived tables do not make
   an ordinary old-version Wrangler rollback safe.

The synthetic runtime tests prove the covered server paths, not a third-party
security audit, every client version, or permanent availability. Monitor account
usage and consider per-tenant DO separation in a future protocol/routing design.
