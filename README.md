# dsh-remote-cf

**English** · [简体中文](README-zh.md)

A Cloudflare Workers implementation of the DSH Remote server: REST authentication and device APIs, a hibernating Durable Object WebSocket gateway, encrypted Relay forwarding, and optional Cloudflare Realtime TURN credentials.

> **OIDC multi-tenancy with logical isolation.** Verified `issuer + sub` identities receive separate device/credential namespaces, with a default capacity of ten tenant records. The current implementation keeps **one shared Gateway Durable Object**, not one process/database or quota allocation per user. Admission, original-owner migration and shared-resource limits must be configured before inviting users; see [multi-tenancy](docs/MULTITENANCY.md).

## Start here

| Guide | What to read |
| --- | --- |
| [Deployment](docs/DEPLOYMENT.md) | Private configuration, explicit Wrangler target, secrets and rollout |
| [Multi-tenancy](docs/MULTITENANCY.md) | Stable identity, admission policy, owner enrollment/migration and rollback gate |
| [Authentication](docs/AUTHENTICATION.md) | Logto OIDC, OIDC-only mode, legacy-owner password fallback and revocation |
| [Architecture](docs/ARCHITECTURE.md) | Logical tenant boundary, shared Gateway, transports, storage and limits |
| [Testing](docs/TESTING.md) | Isolated unit/workerd checks and boundaries of legacy live diagnostics |
| [Connection latency](docs/CONNECTION-LATENCY.md) | Server-side RPC reduction and bounded TURN credential reuse |
| [Operations](docs/OPERATIONS.md) | Platform costs, singleton-versus-per-user estimates and Git deployment |
| [Publication](docs/PUBLICATION.md) | Public-repository preparation and release hygiene |

Use a supported modern Node.js release (at least 22.13; see the testing guide):

```bash
npm ci
npm run typecheck
npm test
npm run test:runtime
npm run test:oauth-runtime
npm run test:tenant-runtime
npm run test:enrollment-runtime
```

Deployment is intentionally not a bare `npm run deploy` recipe: use the ignored local configuration and explicit `--config` commands in the [deployment guide](docs/DEPLOYMENT.md). No public service endpoint or credentials are provided by this repository.

## Scope

- Tenant-scoped device registration, access/refresh credentials, presence, signaling and encrypted Relay.
- OIDC identities use stable issuer/subject keys; verified email is admission/display metadata, not an ownership key. Application admission trusts configured Logto app access policy, **not a server-side role check**.
- LAN/P2P, TURN-assisted WebRTC and encrypted server Relay; credential issuance is not proof of a working TURN data path.
- Root/unrelated routes default to HTTP **418**. The bundled asset is a placeholder, not a Remote web workbench.
- No zero-cost, reserved per-tenant capacity, full-upstream-parity or independent security-certification promise. Review [shared limits](docs/ARCHITECTURE.md#limits-and-security-boundaries) and the [migration/rollback gate](docs/MULTITENANCY.md#deployment-and-rollback-gate).

## Origin and license

The canonical project is [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote); the [AS214933 fork](https://github.com/AS214933/ds-harness-remote) is also a protocol reference. This is an independent Workers implementation, not an official upstream service.

This repository declares MIT; see [LICENSE](LICENSE). That does not replace applicable upstream/dependency notices for copied, adapted or bundled material. See [source attribution](docs/ARCHITECTURE.md#source-origin-and-licensing).
