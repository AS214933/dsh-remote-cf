# Architecture and limits

[README](../README.md) · [Multi-tenancy](MULTITENANCY.md) · [Deployment](DEPLOYMENT.md) · [Authentication](AUTHENTICATION.md)

## Logical tenant boundary

Verified OIDC `issuer + sub` maps to a stable tenant. Email must be verified for admission but is display/admission metadata, **not the tenant key**: changing email does not move a device pool, and different subjects sharing an email do not share devices.

The current release deliberately retains **one singleton `Gateway` Durable Object** so existing opaque device credentials and first-frame WebSocket authentication remain compatible with clients. Isolation is enforced in authenticated application scope, not by separate processes, physical databases or Cloudflare quota allocations. SQL device keys include `(tenant_id, device_id)`; credential digests resolve their own tenant. A caller-supplied tenant ID in a header/query/body cannot select another partition.

Tenant scope applies to sessions, registry checks, device lists/mutations, peer key lookups, owned-Host registration, refresh/revoke, WS peers/links and snapshots, Relay/signaling targets and TURN cache ownership. Default/unrecognized OIDC admission uses the verified-email allowlist; explicit `application` admission trusts configured Logto application access policy and **does not validate a roles claim**. Tenant-record capacity defaults to ten, including disabled users, with an owner slot reserved until binding.

See [multi-tenancy](MULTITENANCY.md) for exact identity/admission behavior, owner pinning, identity-only enrollment and the rollback gate. Per-user Worker/DO deployments remain an alternative for stronger resource separation; they are not the topology used by this release.

## Request and state layout

```text
Host / client
  ├── HTTPS /api/* ── Worker ── authenticated principal / Gateway RPC
  └── WSS /ws/v1/connect ────── singleton Gateway
                                  ├── live tenant registry
                                  ├── SQLite: tenant-scoped devices/tokens/flows
                                  ├── tenant-scoped hibernating peers and links
                                  ├── signaling / encrypted Relay forwarding
                                  └── shared alarms, execution and platform quotas
```

The Worker handles HTTP routing, signed principals, Origin/CORS rules and maps Gateway result envelopes into HTTP responses. Gateway RPC method names are chosen by server code, not by a public arbitrary method dispatcher.

SQLite stores the tenant registry, device metadata, credential digests/replay markers, lockout state and short-lived OAuth flow state. Durable data and hibernating socket attachments survive differently: peer/link snapshots restore their tenant and lifecycle authority before the first wake event; the tenant-scoped TURN credential cache intentionally remains memory-only.

The gateway saves negotiating stages, socket-generation identity and Relay replay counters so hibernation does not turn a link into an unknown connection. Replacement/close/error paths verify current-socket ownership so delayed events cannot remove successors. Alarms schedule heartbeat and handshake/hello deadlines. These protections do not guarantee invisible deployment/network interruption or reserved processing time for each tenant.

## Migration and identity authority

Legacy devices and tokens migrate transactionally into a reserved owner partition; private original tables remain as migration backup. Old tenantless account sessions require re-login, and pre-tenant authenticated sockets must reconnect. The original owner is never inferred from matching email or whoever signs in first: pin the exact issuer/subject, using supervised identity-only enrollment when necessary.

**Do not roll back to a pre-tenant binary after onboarding.** Such code ignores tenant ownership and can expose or mutate multiple partitions. Retained backup tables do not make an ordinary old-version rollback safe. Read the [migration and rollout procedure](MULTITENANCY.md#original-owner-migration) before upgrading an existing instance.

## Transport model

| Transport | Server role |
| --- | --- |
| LAN / P2P WebRTC | Authenticate same-tenant peers, provide descriptors and forward negotiation; the data path can be direct |
| TURN-assisted WebRTC | Authorize tenant-scoped credential issuance and signaling; Cloudflare carries the TURN data path |
| Encrypted server Relay | Forward opaque encrypted frames only between the ends of an authorized same-tenant link |

The normal client/Host tunnel uses Noise end-to-end encryption. The service forwards session ciphertext rather than interpreting prompts/tool output, but still receives authentication material, public keys, device metadata, timing and routing identifiers. Encryption does not eliminate operator responsibility for logs, credentials, updates or authorization.

Workers do not run a TURN server. Another TURN implementation is not a drop-in backend for this Cloudflare credential issuer. Obtaining ICE configuration does not prove a TURN allocation/data channel across a restrictive network. See [connection latency](CONNECTION-LATENCY.md) for fused lookups and nonblocking credential prefetch; neither caching nor Relay changes client cryptographic handshakes.

## Default HTTP behavior

`/healthz`, supported API routes and `/ws/v1/connect` have explicit handlers. The root and unrelated paths default to **418**. `DSH_SERVER_ROOT_PAGE=assets` opts into a placeholder root asset, not a Remote workbench or SPA.

418/indexing headers are operational choices, not invisibility guarantees. The API is discoverable, CORS is not authentication, and an Origin allowlist is not a tenant selector.

## Limits and security boundaries

| Resource | Current bound |
| --- | --- |
| Tenant records | Default ten; disabled users count, owner slot reserved until binding |
| Device rows / active credential rows | 64 / 1,024 per tenant |
| Used-refresh replay markers | 50,000 per tenant, expiring with original refresh TTL |
| Online peers / active links | 32 / 16 per tenant; global 256 peer/link ceilings |
| Control / Relay frame ceiling | 64 KiB / 1 MiB |
| Frame budget | 512 frames and 16 MiB per one-second window per connection |
| ICE candidates | 256 per connection |
| TURN cache | Bounded shared memory cache; credential ownership includes authenticated tenant/device |

These are protective implementation bounds, **not guaranteed per-user capacity, a billing system, a spending cap or a Cloudflare quota override**. Global pre-auth sockets, the singleton event loop, SQL storage and platform quotas remain shared. One tenant's heavy usage can affect others despite access-control isolation. See [operations](OPERATIONS.md) for the current one-Gateway cost model and the alternative physical-per-user model.

Additional boundaries:

- No full-upstream-parity or independent security-certification claim; test client/upstream revisions explicitly.
- Short-window output estimates are not native `bufferedAmount` backpressure measurement. Bursts and slow receivers need dedicated testing.
- Payload/schema validation is not proof of complete upstream parity. Capability advertising and older-client compatibility need explicit regression coverage.
- Deployments can interrupt connections; include reconnect, tenant-aware reauthentication and migration in acceptance.
- Changing password/OIDC settings is not global credential revocation. See [sessions and revocation](AUTHENTICATION.md#sessions-and-revocation).
- Query-log redaction does not redact QR IDs in paths, identity evidence or custom identifier logs. Operational logs remain sensitive.
- Legacy live-diagnostic labels are not release gates; use the isolated tests and multi-user acceptance in [testing](TESTING.md).

## Source origin and licensing

The canonical project is [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote); the [AS214933 fork](https://github.com/AS214933/ds-harness-remote) is also a protocol reference. This repository declares MIT in [LICENSE](../LICENSE) and is not an official upstream service.

A repository license does not erase other authors' notices. For substantially copied/adapted material, identify the exact revision and preserve applicable original notices alongside this port's notice. Do not infer either clean-room implementation or infringement solely from protocol similarity; precise derivation depends on source history.

Preserve dependency notices when distributing bundled Worker code. Review development-tool/native-binary licenses if redistributing those artifacts; their presence in the lockfile does not itself determine the server source license. See [third-party notices](../THIRD_PARTY_NOTICES.md). This guide is not a legal opinion.

## Historical design notes

[Parity](PARITY.md), [OAuth feasibility](OAUTH-FEASIBILITY.md), [redirect investigation](OAUTH-REDIRECT-FEASIBILITY.md), [SDK investigation](LOGTO-SDK-RESEARCH.md) and [hibernation investigation](PENDING-MOBILE-CONNECT.md) are historical summaries, not current deployment/security guarantees. Use the current architecture, multi-tenancy, authentication, deployment and testing guides.
