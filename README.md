<div align="right">

**English** | [简体中文](README-zh.md)

</div>

# dsh-remote-cf

Cloudflare Workers port of the [DSH Remote](https://github.com/AS214933/ds-harness-remote) server.

Single account, like the self-hosted reference server: one account from the
environment, no user table, no identity provider. The difference is where it runs —
Cloudflare's edge, with a Durable Object holding every WebSocket.

## Why a port

The reference server is a single Node process holding all connections in memory.
That maps almost directly onto a Durable Object: one instance, one stateful actor,
long-lived sockets. On this platform a single account costs **$0/month** and needs
no server to babysit.

Two platform facts made this viable, both measured rather than assumed:

- **1 MiB WebSocket messages pass intact** — our protocol cap is exactly 1 MiB, and
  2 MiB also round-trips, so the frame contract needs no change.
- **A 25 s alarm heartbeat works** — measured at 25,021 ms, so the protocol's
  heartbeat interval is achievable without relaxing it.

## What it does

```
Client / Host ──WSS──► Worker (stateless)
                       ├── /api/*  → REST
                       ├── /       → static SPA
                       └── /ws/*   → Durable Object
                                       ├── every WebSocket
                                       ├── peers / links
                                       ├── relay forwarding
                                       └── SQLite: devices, tokens, lockout
```

- Device registration, credential issue/refresh/revoke
- WebSocket gateway: `hello` auth, peer management, link state machine
- Opaque encrypted relay between the two ends of a link
- WebRTC signaling forwarding (offer/answer/ice, transport selection)
- Cloudflare Realtime TURN credentials (optional; Relay works without it)
- Alarm-driven heartbeat, login lockout, per-account and per-source rate limits

The server never sees plaintext: it forwards Noise ciphertext and coordinates
transports. It cannot decrypt sessions, prompts or tool output.

## Deploy

```bash
npm install

# Required secrets — never as plain vars, which are readable in the dashboard.
npx wrangler secret put SESSION_SECRET          # >= 16 chars, signs session cookies
npx wrangler secret put DSH_SERVER_PASSWORD     # >= 8 chars

# Edit wrangler.jsonc for your account and public URL, then:
npx wrangler deploy
```

`wrangler.jsonc` `vars` holds the non-secret settings:

| Variable | Meaning |
| --- | --- |
| `DSH_SERVER_ACCOUNT` | The one account, e.g. your email |
| `DSH_SERVER_PUBLIC_URL` | Public origin; must match the browser origin exactly |
| `DSH_SERVER_ROOT_PAGE` | `assets` serves the SPA at `/`; default answers 418 |
| `DSH_SERVER_ALLOWED_ORIGINS` | Comma-separated browser origins allowed to call the API |
| `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` | Optional, for Cloudflare Realtime TURN |
| `DSH_SERVER_HEARTBEAT_INTERVAL_MS` | Optional, default 25000, bounded 5000–120000 |

Then point the clients at the deployment: `DSH_REMOTE_SERVER=https://<your-worker>`.

## Local development

```bash
npx wrangler dev -c wrangler.dev.jsonc   # uses inline test credentials
node test/e2e.mjs                        # 23 end-to-end checks
npx vitest run                           # 45 unit tests
```

`wrangler.dev.jsonc` is local-only and carries throwaway credentials. The real
config is `wrangler.jsonc`.

## Tests

| Suite | Covers |
| --- | --- |
| `test/protocol.test.ts` | Frame decoding, limits, duplicate-key rejection, identifier and version parsing |
| `test/crypto.test.ts` | Digests, session cookie signing/tampering/expiry, timing equalisation, config bounds |
| `test/e2e.mjs` | Live Worker + Durable Object: login, device lifecycle, token rotation and reuse, WebSocket handshake |
| `test/host-connect.mjs` | **The real Host plugin client** against a live server |
| `test/data-plane.mjs` | **A real Noise IK tunnel** through the server's relay |
| `test/webrtc-path.mjs` | **A real WebRTC data channel** negotiated through the server |
| `test/turn-relay.mjs` | **TURN forced** (`iceTransportPolicy: relay`) so relaying is proven |
| `test/client-flow.mjs` | **The plugin's real sign-in flow**, including the Host claim step |
| `test/endpoint-contract.mjs` | **Every endpoint the plugin calls** — extracted from its source |
| `test/rpc-tunnel.mjs` | **Application RPC inside the tunnel**, proving it stays opaque |
| `test/soak.mjs` | **Long-lived connection** on the real edge, with an RPC afterwards |

中文文档见 [README-zh.md](README-zh.md).

`e2e.mjs` runs against a live `wrangler dev`, not mocks — the point is to verify the
SQLite store, the alarm beat and the gateway together under the real runtime.

`host-connect.mjs` goes further: it imports `HostServerApi`, `IdentityStore` and
`ServerCredentialStore` from a `ds-harness-remote` checkout and drives them against
this server, so a contract mismatch shows up here rather than in production. Point
`DSH_REPO` at that checkout:

```bash
DSH_REPO=/path/to/ds-harness-remote npx tsx test/host-connect.mjs   https://your-worker owner@example.com 'your-password'
```

It covers: real X25519 identity creation, account login and device registration
through the shipped API, credential load, the host read paths, the control WebSocket
hello, and a heartbeat ping/pong round trip.

`data-plane.mjs` goes one layer deeper and is the test that proves the server is
actually useful: two peers complete a **Noise IK handshake** through the server's
signaling path, then exchange **encrypted payloads** through it — client to host and
back, a 256 KiB payload split into Noise-sized chunks, and a deliberately rewound
relay counter that the server refuses.

```bash
DSH_REPO=/path/to/ds-harness-remote npx tsx test/data-plane.mjs   https://your-worker owner@example.com 'your-password'
```

`webrtc-path.mjs` and `turn-relay.mjs` cover the negotiated transports with
`@roamhq/wrtc` — a real native WebRTC stack, so ICE, DTLS and SCTP are genuine. The
second one is the one that matters operationally: it sets
`iceTransportPolicy: 'relay'`, which makes the agent gather *only* relayed
candidates, so the only way a connection can form is through the TURN server. That is
the situation a peer behind a symmetric NAT is in, and it is the only test that
proves an issued credential actually works rather than merely being well-formed.

## Design notes

**Single account, flat model.** No D1, no sharding, no tenancy: every device belongs
to the one account, so `peers` and `links` are ordinary maps and there is no
cross-account check to get wrong.

**Errors cross the RPC boundary as data.** A thrown error loses its `code` and
`status` in the structured clone, so Gateway RPCs return a `Result` envelope and the
Worker maps it to HTTP. Without this every failure reached the client as `500`.

**The alarm never touches SQLite.** A heartbeat that writes would contend with an
in-flight login for the same database handle, and a busy timeout during login is an
outage. The alarm only sends frames and reschedules itself.

**Failure paths are time-equalised.** A wrong password and an unknown address must
cost the same, or response time enumerates account names. Both digests are always
computed and compared, never short-circuited.

**Refresh reuse revokes the device.** A replayed refresh token means the previous
response was intercepted; handing out a new pair would let the attacker keep the
session.

## Limitations

- **TURN requires Cloudflare Realtime TURN or a separate coturn.** Workers cannot
  host a TURN server; it can only issue credentials.
- **Code deploys disconnect WebSockets.** The clients already reconnect.
- **One account only.** Multi-account would need a DO per account plus D1, and the
  heartbeat would then have to avoid hibernation-blocking timers.
- **Not affiliated with the upstream project.** This is an independent port of a
  protocol whose design is documented upstream.

## License

MIT
