# tung.chat — Architecture

Written 2026-09-29. Two repositories: `tung-chat-app` (browser client) and `tung-chat-service` (relay). Protocol details are in [PROTOCOL.md](PROTOCOL.md); the reasoning behind the security choices is in [SECURITY.md](SECURITY.md).

## 0. Shape of the system

```
  Browser A                 DigitalOcean App Platform (tung.chat)                Browser B
 ┌─────────────┐          ┌──────────────────────────────────────┐          ┌─────────────┐
 │ React SPA   │ wss://…  │ DO router (TLS, path routing)        │ wss://…  │ React SPA   │
 │ keys in RAM ├─────────►│   /        → web: Caddy container,   │◄─────────┤ keys in RAM │
 │ WebCrypto   │ /ws      │               static build + headers │ /ws      │ WebCrypto   │
 └─────────────┘          │   /ws, /health → api: NestJS relay   │          └─────────────┘
                          │               1 instance, in-memory  │
                          │               Maps + TTLs, no DB     │
                          └──────────────────────────────────────┘
```

The server does three things: holds live pseudonyms, delivers invitations, and forwards opaque encrypted frames between two paired sockets. It cannot decrypt anything.

## 1. Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | **Vite + React 19 + TypeScript**, static build, `pnpm` | The app is one screen with a state machine; there is nothing to server-render and no SEO beyond the home page. The deciding factor is lockdown: a static bundle with no server runtime can be served with a strict CSP (no nonces), every file hash-pinned, and diffed against a public build. Next.js would work with `output: 'export'`, but brings a framework runtime and conventions we would only be turning off. |
| Styling | Plain CSS with CSS variables (one `theme.css`, a few component files) | The theme is small; Tailwind is fine but unnecessary weight for ~6 screens. |
| Client state | One `Controller` class outside React (`src/session/controller.ts`), read through `useSyncExternalStore` | States and transitions are few and must be exact; keeping them in a plain class makes them testable in Node against the real relay, and StrictMode can't open a second socket. Keys and the channel are private fields, never rendered state. |
| Crypto | **WebCrypto** (`crypto.subtle`): X25519 ECDH, HKDF-SHA-256, AES-256-GCM | Built into every modern browser, keys can be non-extractable. `@noble/curves` / `@noble/hashes` as fallback only if a target browser lacks X25519. |
| Font | JetBrains Mono, self-hosted `woff2` | See PRODUCT §4. |
| Backend | **NestJS 12 on Express**, TypeScript, `pnpm` | Matches `slothify-service` / Kookooli conventions. HTTP surface is tiny (`/health`); the real work is the WebSocket gateway. |
| WebSocket | Raw `ws` server attached to Nest's HTTP server at `/ws` (`perMessageDeflate: false`, `maxPayload` ≈ 12 KB, origin checked before upgrade) | We skip Nest's gateway layer: our frames aren't Nest's `{event, data}` shape and owning the server keeps limits explicit. Smaller and simpler to audit than socket.io, no long-polling fallback (which would add HTTP request logs and cookies). Reconnection is handled by our own resume token (PROTOCOL §4) — socket.io's reconnection wouldn't restore our session state anyway. |
| Validation | **Zod** schemas for every inbound frame | Anything not matching the schema closes the socket. |
| State | In-process `Map`s with TTL sweeps | No database. Nothing is written to disk. Restarting the process ends every conversation — acceptable and even desirable. |
| Logging | `pino` with a strict allowlist: event type, counts, durations, error codes | Never pseudonyms, IPs, invite IDs, frame sizes per session, or anything user-supplied. |
| Hosting | **DigitalOcean App Platform** (D7): `web` = Caddy container serving the static build, `api` = Node service, 1 instance | Same platform as other Kodistat services. Static-site components can't set response headers, so the app ships as a tiny container to get CSP/HSTS/COOP. Known cost: DO's router logs client IPs. Moving to a VPS with access logs off is a later step. |
| CI | GitHub Actions: lint, typecheck, unit tests, e2e, reproducible build hash | Same toolchain as other repos. |

**Not used, on purpose:** Postgres, Knex, migrations, Redis, object storage, analytics, error trackers that capture request payloads (no Sentry in the browser; server-side Sentry only with payload capture off, or not at all), CDN.

### Considered and deferred: WebRTC data channels
Peer-to-peer data channels would take the server out of the message path entirely. Deferred because: (a) each side learns the other's IP address, which for this product is a worse leak than the server seeing ciphertext; (b) many mobile networks need a TURN relay anyway, which is just a relay we'd have to run; (c) it adds ICE/STUN complexity to a v1 that should be small and auditable. E2EE over our relay gives the same content secrecy. Revisit only if relay bandwidth becomes a cost problem.

## 2. tung-chat-service layout

```
tung-chat-service/
├── src/
│   ├── main.ts                 bootstrap: WsAdapter, no body parser beyond defaults, no request logger
│   ├── app.module.ts
│   ├── config.ts               env parsing + all limits/TTLs from PRODUCT §3
│   ├── protocol/
│   │   ├── frames.ts           Zod schemas + TS types for every client↔server frame (source of truth)
│   │   └── errors.ts           error codes
│   ├── relay/
│   │   ├── relay.server.ts     attaches `ws` to the HTTP server: origin check, IP, parse → validate → dispatch
│   │   ├── session.store.ts    sessions, pseudonym index, pairing (in-memory)
│   │   ├── invite.store.ts     pending invites, block lists
│   │   ├── sweeper.ts          interval that expires TTLs and tears down
│   │   └── relay.service.ts    the state transitions (PROTOCOL §2)
│   ├── limits/
│   │   └── rate-limiter.ts     token buckets per connection and per salted-IP-hash
│   ├── health/
│   │   └── health.controller.ts   GET /health → { ok: true } (no counts: they'd reveal live pairs)
│   └── common/                 logger (redacting), shutdown hooks
├── test/
│   ├── unit/                   stores, state transitions, rate limiter
│   └── e2e/                    two/three `ws` clients against a real server
├── deploy/
│   └── app.yaml                App Platform spec for both components (web + api)
├── docs/
├── example.env
└── package.json
```

### 2.1 Server state (all in memory)

```ts
type SessionId = string;           // 128-bit random, server-generated

interface Session {
  id: SessionId;
  socket: WebSocket | null;        // null while inside the reconnect grace window
  resumeTokenHash: Uint8Array;     // SHA-256 of the resume token; the token itself is only on the client
  pseudonym: string | null;        // normalized; null until claimed
  state: 'connected' | 'claimed' | 'inviting' | 'invited' | 'paired';
  peer: SessionId | null;
  blocked: Set<string>;            // pseudonyms this session blocked
  expiresAt: number;               // the TTL that applies to the current state
  graceUntil: number | null;       // set when socket drops
  rate: TokenBucket;
}

sessions:   Map<SessionId, Session>
pseudonyms: Map<string /* normalized */, SessionId>
invites:    Map<InviteId, { from: SessionId; to: SessionId; expiresAt: number }>
ipBuckets:  Map<string /* HMAC(ip, dailySalt) */, TokenBucket>   // rate limiting only, dropped after 1h idle
```

- Session/pair counts appear only in a `stats` log line every 5 minutes, never on a public route.
- The server does **not** know whether a paired session is in "verifying" or "chatting" — that distinction lives inside the encrypted channel (PROTOCOL §3). Less metadata.
- Tearing down a pairing deletes both sessions' pseudonyms from the index, drops the pairing, and closes both sockets with a reason code. Nothing is retained, not even a counter per pseudonym.
- The daily salt for IP hashing is random, held in memory, and rotated every 24h, so rate-limit keys can't be correlated across days or reversed after a restart.

### 2.2 Scaling
One Node process comfortably holds tens of thousands of idle WebSockets; this is far beyond launch needs. If we ever need more than one instance, both sockets of a pair must reach the same shared state: Redis with TTLs and persistence disabled (`save ""`, `appendonly no`) plus pub/sub to forward frames between instances. Not in v1.

## 3. tung-chat-app layout

```
tung-chat-app/
├── public/                     icon.svg + generated PNGs, manifest.webmanifest
├── src/
│   ├── main.tsx                fonts, CSS, privacy guards, render
│   ├── App.tsx                 shell: header, banners, picks the screen for the phase
│   ├── screens.tsx             Home, Naming, Lobby, Verify, Chat, Ended, Unsupported
│   ├── pages.tsx               /how and /security (en + sq)
│   ├── conversation.ts         the page's single Controller, hooks, pagehide/visibility/Esc guards
│   ├── components.tsx          Button, Field, Cursor, private input props
│   ├── pseudonym.ts            random name suggestions
│   ├── session/
│   │   ├── controller.ts       client state machine (PROTOCOL §1, §5), handshake, verify, chat
│   │   └── socket.ts           WebSocket with resume-on-drop (PROTOCOL §4)
│   ├── crypto/
│   │   ├── keys.ts             X25519, commitment, HKDF → directional AES keys + safety bytes
│   │   ├── channel.ts          seal/open inner frames, counters, replay + gap detection
│   │   ├── padding.ts          size buckets
│   │   ├── inner.ts            inner frame schemas and limits
│   │   ├── safety-code.ts      5 bytes → 5 words
│   │   └── bytes.ts            base64url, UTF-8, constant-time compare
│   ├── protocol/frames.ts      GENERATED copy of the service's frames.ts (`pnpm sync:protocol`)
│   ├── content/                quotes.json, wordlist.json (256 words)
│   ├── i18n/                   en.ts, sq.ts (draft), language store (memory only)
│   └── styles/                 theme.css, app.css
├── test/
│   ├── controller.test.ts      malicious-relay cases, double taps, reconnection
│   └── conversation.test.ts    two controllers through the real relay, incl. "relay sees no plaintext"
├── sri.plugin.ts               adds sha384 integrity to index.html (in-repo, no third-party plugin)
├── security-headers.ts         the SECURITY §5 headers; also sent by `vite preview`
├── Caddyfile, Dockerfile       production container for App Platform
└── vite.config.ts              dev on :5180, preview on :4173, both proxy /ws → :4000
```

- **No router.** The URL is always `/` (plus static `/how` and `/security` pages). Pseudonyms, invite IDs, and state never appear in the URL, so they never land in browser history.
- **No storage APIs.** No `localStorage`, `sessionStorage`, IndexedDB, or cookies. Everything lives in React state and closes with the tab. A lint rule bans those APIs in `src/`.
- **PWA (optional, v1.1):** installable icon is nice on phones. If a service worker is added it caches static assets only and must never see WebSocket traffic or messages.

## 4. Deployment

DigitalOcean App Platform, one app with two components (spec in `tung-chat-service/deploy/app.yaml`):

- **Domain:** `tung.chat` serves both the app and the WebSocket at `wss://tung.chat/ws`. Same origin keeps the CSP simple (`connect-src 'self' wss://tung.chat`) and means no CORS.
- **`web` component** (service, Dockerfile from `tung-chat-app`): multi-stage build — Node builds `dist/`, Caddy serves it with the SECURITY §5 headers and an SPA fallback, access log off. Route `/`.
- **`api` component** (service, Node from `tung-chat-service`): routes `/ws` and `/health` with `preserve_path_prefix: true` (App Platform strips the route prefix by default). **Instance count fixed at 1** — state is in memory and a second instance would split it. Health check on `/health`.
- **Client IP** for rate limiting comes from the `do-connecting-ip` header, read only when `TRUSTED_IP_HEADER` is set (unset in local dev).
- **Deploys end conversations.** On SIGTERM the relay sends `ended{server_restart}` to everyone and closes with `4005`. Deploy at quiet hours.
- **Release:** CI builds the app and records the SHA-256 of every output file per release (ready for when the code is published, D6).
- **Logs:** our process logs only allowlisted fields (SECURITY §6). DO's router keeps its own request logs with client IPs; accepted for now (D7).
- **Later (own server):** Caddy + systemd on a VPS, access logs off, no swap. The containers above move over unchanged.
- **DNS/registrar:** enable registrar lock and DNSSEC on `tung.chat`; a hijacked domain is the easiest way to serve modified JavaScript.
