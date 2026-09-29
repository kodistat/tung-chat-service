# tung.chat — project docs

Written 2026-09-29. Two repositories:

- `tung-chat-app` → the browser client (git@github.com:kodistat/tung-chat-app.git)
- `tung-chat-service` → the relay server (git@github.com:kodistat/tung-chat-service.git)

These docs live in the service repo (same pattern as `slothify-service/docs`). The app repo's README points here.

*Tung* is the Albanian "hi" / "bye". The whole product is one conversation between two people: say hi, talk, say bye, and nothing is left behind.

## The product in one paragraph

Two people open tung.chat in a browser (desktop or phone). Each picks a throwaway pseudonym that exists only for this one conversation. One of them (the **initiator**) looks up the other by pseudonym and sends an invitation. The other (the **invitee**) accepts. Before any chatting, the initiator asks as many security questions as they want to be sure who is on the other end. When satisfied, the initiator gives the **go** and the chat opens. When either side ends the conversation, it is gone: pseudonyms released, keys destroyed, nothing on the server, nothing in the browser.

## Documents

| File | What it covers |
|---|---|
| [PRODUCT.md](PRODUCT.md) | User flow, screens, rules, hacker theme, home-page quotes, icon |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Stack decisions, repo layouts, in-memory server state, hosting |
| [PROTOCOL.md](PROTOCOL.md) | State machines, WebSocket message schemas, end-to-end crypto, timeouts |
| [SECURITY.md](SECURITY.md) | Threat model, what the design protects and what it cannot, required hardening |
| [ROADMAP.md](ROADMAP.md) | Build order, v1 scope, later work |

## Headline decisions

1. **End-to-end encryption is mandatory, not a feature.** "Messages are not kept on the server" is only a promise unless the server *cannot read them*. The server is a blind relay of ciphertext. Keys are generated in the browser and never leave it. See [SECURITY.md §2](SECURITY.md#2-end-to-end-encryption).
2. **Security questions alone do not protect against the server.** They prove the *person* is right, not that the *channel* is. v1 adds a short "safety code" both people can compare; v2 binds a shared-secret answer into the key exchange itself. See [SECURITY.md §3](SECURITY.md#3-the-security-question-flow-and-its-limit).
3. **No database.** All server state is in memory with short TTLs. This is a deliberate departure from every other Kodistat service (no Postgres, no Knex, no migrations).
4. **Frontend: Vite + React static SPA**, not Next.js. The deciding constraint is lockdown: a static bundle with no server runtime is easier to audit, pin with a strict Content-Security-Policy and Subresource Integrity, and serve from a box we fully control. See [ARCHITECTURE.md §1](ARCHITECTURE.md#1-stack).
5. **Backend: NestJS 12 on Express** with raw WebSockets (`ws`), matching the other Kodistat services.
6. **DigitalOcean App Platform for now (D7)**, like the other Kodistat services. The app runs as a small Caddy container (so we control security headers); the relay runs as a single-instance Node service. Trade-off accepted for now: DigitalOcean and Cloudflare (which carries App Platform traffic) can log visitor IPs. Moving to our own server is a later step.

## Decisions

These were gaps in the original spec. Answered 2026-09-29: D1–D5 as recommended; D6 and D7 changed (see Decision column).

| # | Question | Decision |
|---|---|---|
| D1 | Verification is one-way: only the initiator asks questions. Should the invitee also be able to verify the initiator? | **Yes, mutual.** Either side may ask questions; the chat opens only when *both* have pressed go. Plus a shared safety code shown to both. |
| D2 | How does the initiator find the invitee: search by pseudonym, or a one-time invite code/link? | **Exact-match pseudonym lookup** (your design), hardened: no partial search, no listing, rate limits, decline + block. Invite link is a v1.1 option that removes lookup entirely. |
| D3 | What happens when a phone drops the connection (switching apps, tunnel, lock screen)? | **45-second grace window** with a resume token. Explicit "end" is instant; a network drop is not. |
| D4 | Should messages fade from the screen after a while even during the chat? | **Optional per chat**, off by default, chosen by the initiator at go time (1 / 5 / 15 min). |
| D5 | Languages? | **English + Albanian** (same as Slothify), English default. |
| D6 | Do we open-source the app repo? | **Not now — second step.** Repos stay private for v1. We still keep the build reproducible and record file hashes per release so publishing later is easy. |
| D7 | Hosting: our own VPS or DigitalOcean App Platform? | **App Platform for now**; own server later. Accepted cost: App Platform traffic goes through Cloudflare and DO's router, which can log visitor IPs; we can't disable that (content stays encrypted either way). |
