# Architecture and limits

[README](../README.md) · [Deployment](DEPLOYMENT.md) · [Authentication](AUTHENTICATION.md)

## Single-account boundary

**This is a single-account, shared-device deployment. It is not multi-tenant hosting.**

One Worker routes to a singleton `Gateway` Durable Object. Its device/token tables and peer/link maps represent one deployment owner. There is no user table, per-user device ownership check, tenant-specific Gateway selection or per-user quota partition.

Password and optional Logto OIDC are alternate admission methods into that same namespace. Adding several emails to `OAUTH_ALLOWED_ACCOUNTS` does not isolate their devices. The implementation is therefore **not suitable as-is for up to ten separate accounts requiring mutual isolation**, or for any larger unrelated group.

Independent deployments can provide separate stores/secrets at an operational level, but are not a multi-tenant feature of one instance. An actual multi-user design would require explicit tenant identity, storage/routing partitioning, ownership authorization, lifecycle/quota isolation and adversarial cross-tenant tests. This guide does not implement or certify that design.

## Request and state layout

```text
Host / client
  ├── HTTPS /api/* ── Worker ── Gateway RPC ── SQLite
  └── WSS /ws/v1/connect ────── Gateway
                                  ├── hibernating WebSockets
                                  ├── peers and negotiating links
                                  ├── signaling / encrypted Relay forwarding
                                  └── alarms and lifecycle deadlines
```

The Worker handles HTTP routing, session credentials, Origin/CORS rules and maps Gateway result envelopes into HTTP responses. Gateway RPC method names are chosen by server code, not by a public arbitrary method dispatcher.

Durable Object SQLite stores registered device metadata, token digests, lockout state and short-lived OAuth flow state. Durable data and hibernating socket attachments survive differently: peer/link lifecycle snapshots must be restored before the first wake event, while the TURN credential cache intentionally remains memory-only.

The gateway saves negotiating stages, socket-generation identity and Relay replay counters so hibernation does not turn an existing link into an unknown connection. Replacement/close/error paths verify current-socket ownership so a delayed event from an older socket cannot remove its successor. Alarms schedule heartbeat and handshake/hello deadlines; this is not a promise that every deployment or network interruption is invisible to clients.

## Transport model

| Transport | Server role |
| --- | --- |
| LAN / P2P WebRTC | Authenticate peers, provide descriptors and forward negotiation signaling; the data path can be direct |
| TURN-assisted WebRTC | Issue optional Cloudflare Realtime TURN credentials and forward signaling; Cloudflare carries the TURN data path |
| Encrypted server Relay | Forward opaque encrypted frames between the two ends of an authorized link |

The normal client/Host tunnel uses Noise end-to-end encryption. The service is designed to forward session ciphertext rather than interpret prompts or tool output. It still receives authentication material, public identity keys, device metadata, connection timing and routing identifiers. Encryption does not eliminate the operator's responsibility for logs, credentials, updates or access control.

Workers do not run a TURN server. A separate TURN implementation is not a drop-in configured backend of this repository's Cloudflare credential issuer. Obtaining an ICE list is not evidence that a TURN allocation or data channel works across a restrictive network.

See [connection latency](CONNECTION-LATENCY.md) for fused Gateway lookups and nonblocking credential prefetch. Neither cache reuse nor server Relay changes client cryptographic handshakes or makes clients mutually untrusted tenants.

## Default HTTP behavior

`/healthz`, supported API routes and `/ws/v1/connect` have explicit handlers. The root and unrelated paths default to **418**. `DSH_SERVER_ROOT_PAGE=assets` can opt into the bundled root asset, which is only a placeholder—not a Remote web workbench or SPA.

418 responses and indexing headers are operational choices, not security-through-invisibility guarantees. The API remains discoverable, CORS is not authentication, and an Origin allowlist is not an account/tenant partition.

## Limits and security boundaries

Current implementation limits include:

| Resource | Current bound |
| --- | --- |
| Registered devices / token rows | 64 / 1024 per shared deployment |
| Gateway peers / links | 256 / 256 |
| Control / Relay frame ceiling | 64 KiB / 1 MiB |
| Frame budget | 512 frames and 16 MiB per one-second window per connection |
| ICE candidates | 256 per connection |
| TURN cache | At most 64 retained entries and 64 total in-flight mints |

These are implementation bounds, not a throughput guarantee, spending cap or Cloudflare quota override. Refer to source and [operations](OPERATIONS.md) when changing limits; platform plans, billing and native client behavior are separate constraints.

Additional boundaries:

- There is no full-upstream-parity or independent security-certification claim. Client and upstream revisions must be tested explicitly.
- The gateway's short-window output estimate is not a true native `bufferedAmount` backpressure measurement. Bursts and slow receivers need dedicated testing.
- Routing payload validation is not proof that every forwarded payload/UTF-8/schema case matches upstream. Capability advertising and older-client compatibility also need explicit regression coverage.
- Deployments can interrupt active connections; client reconnection and reauthentication behavior must be included in release acceptance.
- Changing password/OIDC settings is not global credential revocation. See [sessions and revocation](AUTHENTICATION.md#sessions-and-revocation).
- Query-log redaction does not redact QR IDs in paths or custom identifier logs. Logs remain sensitive operational data.
- A pass from a legacy live diagnostic is not a release gate; see [testing](TESTING.md).

## Source origin and licensing

The canonical source project is [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote). The [AS214933 fork](https://github.com/AS214933/ds-harness-remote) has also been used as a protocol reference. This repository declares its own MIT license in [LICENSE](../LICENSE) and is not an official upstream service.

A repository-level license declaration does not erase other authors' notices. For any substantially copied or adapted upstream material, identify the exact source revision and preserve the applicable original copyright/license notices alongside this port's notice. Do not infer either clean-room implementation or infringement merely from protocol similarity; the precise derivation must be established from the actual source history.

Likewise, preserve applicable dependency notices when distributing bundled Worker code. Development-tool or optional native-binary licenses must be reviewed if those tools/binaries are redistributed; their presence in a development lockfile does not by itself determine the license of this server's source. This guide is not a legal opinion or a claim that all attribution questions have been resolved.

## Historical design notes

The following files are retained as explicitly historical summaries, not current deployment or security guarantees:

- [Parity investigation](PARITY.md)
- [OAuth feasibility](OAUTH-FEASIBILITY.md)
- [Browser redirect investigation](OAUTH-REDIRECT-FEASIBILITY.md)
- [Logto SDK investigation](LOGTO-SDK-RESEARCH.md)
- [Hibernation/connection investigation](PENDING-MOBILE-CONNECT.md)

Use the current architecture, authentication, deployment and testing guides for supported behavior.
