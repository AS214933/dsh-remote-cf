# dsh-remote-cf

**English** · [简体中文](README-zh.md)

A Cloudflare Workers implementation of the DSH Remote server: REST authentication and device APIs, a hibernating Durable Object WebSocket gateway, encrypted Relay forwarding, and optional Cloudflare Realtime TURN credentials.

> **Single-account deployment, not multi-tenant hosting.** Password login and optional Logto OIDC authenticate access to one shared device namespace. Even a small group of up to ten people needing separate accounts and isolated devices is **not supported** by one instance. An OIDC email allowlist does not create tenant isolation. See [architecture and limits](docs/ARCHITECTURE.md#single-account-boundary).

## Start here

| Guide | What to read |
| --- | --- |
| [Deployment](docs/DEPLOYMENT.md) | Private configuration copy, explicit Wrangler target, secrets and first deployment |
| [Authentication](docs/AUTHENTICATION.md) | Password, Logto OIDC, OIDC-only mode, verified email and revocation limits |
| [Architecture](docs/ARCHITECTURE.md) | Single-account trust boundary, transports, storage, default 418 and known limits |
| [Testing](docs/TESTING.md) | Isolated unit/workerd checks and boundaries of legacy live diagnostics |
| [Connection latency](docs/CONNECTION-LATENCY.md) | Server-side RPC reduction and bounded TURN credential reuse |
| [Operations](docs/OPERATIONS.md) | Platform costs, quotas and Git deployment operations |
| [Publication](docs/PUBLICATION.md) | Public-repository preparation and release hygiene |

For a local checkout, use a supported modern Node.js release (at least 22.13; see the testing guide):

```bash
npm ci
npm run typecheck
npm test
npm run test:runtime
npm run test:oauth-runtime
```

Deployment is intentionally not a bare `npm run deploy` recipe: use the ignored local configuration and explicit `--config` commands in the [deployment guide](docs/DEPLOYMENT.md). No public service endpoint or credentials are provided by this repository.

## Scope

- Supports device registration, access/refresh credentials, presence and connection signaling.
- Forwards end-to-end encrypted session traffic; it still handles authentication material and connection metadata. This is not an independent security certification.
- Coordinates LAN/P2P, TURN-assisted WebRTC and encrypted server Relay. A credential-issuance check is not proof of a working TURN data path.
- Defaults to HTTP **418** for the root and unrelated routes. The bundled static asset is a placeholder, not a Remote web workbench.
- Does not promise zero cost, unrestricted capacity, full upstream parity or compatibility with every client revision. Review [operations](docs/OPERATIONS.md), [testing](docs/TESTING.md) and [limits](docs/ARCHITECTURE.md#limits-and-security-boundaries).

## Origin and license

The canonical project is [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote); the [AS214933 fork](https://github.com/AS214933/ds-harness-remote) is also used as a protocol reference. This repository is an independent Workers implementation, not an official upstream service.

This repository declares MIT; see [LICENSE](LICENSE). That declaration does not replace applicable upstream or dependency notices for copied, adapted or bundled material. Source attribution and distribution requirements are covered in the [architecture guide](docs/ARCHITECTURE.md#source-origin-and-licensing).
