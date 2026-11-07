# Connection setup latency: Workers-side optimization

[README](../README.md) · [Architecture](ARCHITECTURE.md) · [Testing](TESTING.md)

## Scope

These changes reduce server-side work without changing the Host/client wire format, negotiated transport, token lifetime or ICE timeout. They do not implement multiple accounts or tenant isolation.

An end-to-end client setup interval can include native RTC initialization, credential lookup, ICE checks, Noise negotiation and initial capability/history RPCs. A low eventual ICE RTT or a LAN-selected connection does not identify which of those stages consumed setup time.

In the investigated client/Host order, client ICE lookup precedes offer creation, while Host ICE lookup follows receipt of the offer. Two external credential issuer waits could therefore be serialized even when LAN wins. Host peer-descriptor lookup before acceptance is another server-side round trip.

## Implemented design

1. **Authorized peer lookup in one Gateway RPC.** Token authentication, opposite-role peer lookup and online state are resolved together. The authorized peer response retains the public identity key; the presence projection stays narrow.
2. **Authorized ICE lookup in one Gateway RPC.** Hash the token once, validate the negotiating link, then resolve mint/cache state. After every await, recheck the exact live token/device/link/socket state and deadline synchronously before returning credentials.
3. **Authentication result includes online state.** Remaining device routes do not need a second source-presence lookup.
4. **Nonblocking prefetch on Host acceptance.** Independent client and Host credentials are requested concurrently using `ctx.waitUntil`. Acceptance and signaling do not wait for that work; no keepalive timer or `blockConcurrencyWhile` is added.
5. **Per-device singleflight and bounded reuse.** Same-device requests join one pending mint. Distinct devices do not share credentials. The cache has at most 64 entries and 64 total active mints, including invalidated off-map flights.
6. **Fixed expiry with provider margin.** Reuse is `min(5 minutes, configured TTL − 60 seconds)`, anchored before the mint begins, never sliding on access. At the minimum 60-second provider TTL a fresh result may be returned but is not retained for reuse. Failures are not cached.
7. **Ownership-safe invalidation.** Explicit revoke, refresh-reuse revoke and re-registration forget the device entry. An old in-flight result cannot repopulate a deleted entry or overwrite/remove a newer one.
8. **No persisted credential cache.** Credentials are not added to link/socket attachments or SQLite. ICE HTTP responses use `Cache-Control: no-store`. Logs contain source/timing/success metadata, not credential bytes.

The cache is deliberately memory-only. Hibernation/redeployment discards it while peer/link lifecycle snapshots can still be restored. The next authorized lookup can therefore be cold.

## Isolated benchmark

The real workerd/Miniflare comparison uses a synthetic issuer taking 150 ms per call, the same sequential client-then-Host endpoint order and disposable local state. The control loads setup code from Git revision `0dee93f`; it is not an operator deployment version.

| Local sample | Previous | Optimized |
| --- | ---: | ---: |
| Cold client then Host ICE requests | 345 ms | 167 ms |
| Host portion after client request completes | 168 ms | 4 ms |
| Warm client then Host ICE requests | 340 ms | 8 ms |

These are individual isolated samples, not p50/p95 measurements or a promised real-device speedup. The demonstrated reduction is serialized issuer work and RPC count. At least one cold external mint still remains; network/RTC/Noise/application setup costs remain outside this benchmark.

Run the current isolated checks from [testing](TESTING.md):

```bash
npm test
npm run test:runtime
```

When the historical Git revision is present, the comparison can be run with:

```bash
SETUP_SOURCE_REF=0dee93f node test/gateway-runtime.mjs
```

## Validation boundaries

Regression coverage includes expiry/deletion/revoke while minting; closed, replaced, ready or timed-out links after an await; same-device joins; independent peer credentials; fixed expiry/minimum-TTL behavior; failure recovery; stale-flight ownership; and capacity under invalidation churn.

The workerd suite explicitly hibernates the Durable Object. Credential cache loss must cause a fresh authorized mint while first-event wake routing, pending/accepted/handshake state, ready Relay replay counters and close-event notification still behave correctly. These tests use isolated local records and a controlled issuer, not production credentials or real phone acceptance.

## Operational limits

- Reuse is best effort, not a provider availability guarantee or a spending cap.
- Issued provider credentials remain valid until provider-side expiry/revocation. Local cache deletion is not provider revocation and cannot retract a response already sent.
- Do not shorten credential TTL merely to match cache retention; a server-only change does not add credential-refresh behavior to deployed clients.
- Do not attribute every second of setup to Workers. Measure the actual Host/client stages before changing ICE timeouts or forcing Relay.
- A successful mint proves credential issuance, not TURN allocation or a working data path. Cross-network and real-client acceptance remain separate.

Deployment topology, personal endpoints and release-specific version identifiers do not belong in this technical document. Use private operator records for a particular instance and the neutral [deployment](DEPLOYMENT.md) and [operations](OPERATIONS.md) guides for public instructions.
