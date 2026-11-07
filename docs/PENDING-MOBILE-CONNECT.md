# Historical note: hibernation and connection lifecycle

> **Archived investigation; current behavior is maintained in tests.** This note replaces an instance-specific incident/deployment record. It contains no device identity, hardware name, service endpoint or deployment version. See [architecture](ARCHITECTURE.md), [testing](TESTING.md) and [connection latency](CONNECTION-LATENCY.md).

## Confirmed server lifecycle defects investigated

A single-process reference server can retain connection maps in ordinary memory. A hibernating Durable Object cannot assume those maps still exist when the first message, close event or RPC wakes it. The investigation identified these cases:

1. Peers were restored too late, making the first wake event see an empty peer map.
2. Links, stages and Relay counters were not restored, so a still-open socket could refer to an unknown connection.
3. Delayed errors/send failures from an old socket could remove a replacement socket's state.
4. New connections could postpone an earlier heartbeat/deadline alarm.
5. Hello deadlines needed persisted absolute timing and revalidation after asynchronous authentication.
6. Age-based guesses about duplicate clients diverged from explicit socket-replacement semantics.

The implementation now restores snapshots before processing wake events, saves negotiating/link/replay state in recoverable attachments, uses socket-generation ownership, clears snapshots before teardown, and schedules the earliest relevant deadline. These are specific fixes, not proof that every disconnect is a server bug or every future client version is compatible.

## Evidence and its limits

Lifecycle tests call actual Gateway handlers with controlled sockets/store/runtime base. Separate real workerd tests explicitly hibernate/wake the object and cover first-event routing, pending/accepted/handshake stages, ready Relay cycles, replay rejection and close-event notification.

Historical Git source revision `d8cbf6a` can be used as a failing comparison for the wake-routing case when available. That is a source revision, not an instance deployment ID. A regression comparison should retain the same test scenario and assertion, not infer success from missing log lines.

These tests use disposable local state. They do not by themselves prove native Noise compatibility, real-phone behavior, network-change recovery, a forced TURN data path or long-term production stability. Instant successful reconnection is narrower evidence than overnight/network-change acceptance.

## Explanations that should not be inferred from sparse logs

- Host protocol compatibility uses its Remote client version; a surrounding desktop product's prerelease version is not interchangeable evidence.
- Optional Relay assignment fields must not be invented when the supported contract forwards encrypted Relay over the control socket.
- One client's retry sequence does not establish another client's transport order or prove LAN/P2P failed.
- Cloudflare invocation success and a missing frame log do not prove a particular HTTP status, client action or functioning TURN data path.
- A connection accepted by a Host can still fail later during transport, encryption or application setup.

## Still separate from this fix

True native backpressure measurement, complete malformed-payload/schema parity, capability advertising, client-specific retry classification and broad upstream compatibility remain independent review topics. Do not mark them solved merely because wake routing passed.

Later work changed schema initialization to per-database tracking and implemented hardened Logto/OIDC; the initial investigation's “not handled here” notes for those subjects are therefore historical. Use the current guides instead of treating this file as an outstanding issue list or security certificate.
