# Historical note: upstream parity investigation

> **Archived / superseded.** This file summarizes an earlier comparison with the reference server around the v0.6.3 protocol era. It is not a current parity certificate, security audit, release gate or deployment guide. Use [architecture](ARCHITECTURE.md), [authentication](AUTHENTICATION.md) and [testing](TESTING.md) for current behavior.

## What the comparison investigated

The investigation compared API response shapes, gateway frame routing, connection limits, heartbeat/deadline behavior, older-client transport compatibility and token/device lifecycles. It identified gaps rather than establishing that every core/security behavior was identical.

Follow-up changes addressed several concrete cases, including peer response shape, connection/peer bounds, allowed transport-selection phases and compatibility forwarding. Subsequent hibernation work found additional lifecycle issues that a single-process comparison alone had not covered. The [historical connection note](PENDING-MOBILE-CONNECT.md) explains that distinction.

## Deliberate differences

- One shared deployment account, not a user/tenant database or multi-account service.
- Cloudflare Durable Object WebSockets/SQLite instead of a single Node process and its in-memory state.
- Cloudflare Realtime TURN credential issuance rather than hosting a TURN service inside Workers.
- Account-scoped device revocation and optional explicit browser Origin configuration.
- Default 418 for unrelated/root paths, with an opt-in placeholder asset rather than a bundled web workbench.
- Optional Logto authorization-code login and OIDC-only admission; this is not the same as implementing all upstream Logto hooks/M2M/account-management features.

## Claims not made

This repository does not claim complete route/schema/security parity, every upstream hook/capability, identical backpressure behavior or support for arbitrary client revisions. Sharing frame names and nominal limits does not prove semantic equivalence under malformed input, retries, revocation, load or hibernation.

An accepted list of OIDC emails is not a set of isolated upstream accounts. Even a small group requiring independent device ownership needs a different, explicitly tested tenancy design or separately operated instances.

Legacy manual-suite PASS totals are not sufficient evidence; some historical helpers ignored false predicates. Current test guidance distinguishes real-assertion isolated coverage from live diagnostics. A future parity report should pin exact server/client revisions, publish a focused difference matrix, and link assertions for each claim rather than use blanket “fully identical” wording.
