# tung.chat — Roadmap

Written 2026-09-29. Build order for v1, then what comes after.

## v1 — build order

Status 2026-09-29: steps 1–7 and 9 done (Playwright in step 7 replaced by a Node test of two controllers through the real relay, plus a manual two-tab browser run). Albanian strings are a draft. Next: step 8 (first deploy).

| Step | Repo | Deliverable | Done when |
|---|---|---|---|
| 1 | service | NestJS 12 scaffold, `ws` adapter, `config.ts`, redacting logger, `/health` | Server starts, `/health` returns counts |
| 2 | service | `protocol/frames.ts` (Zod) + session/invite stores + state transitions + sweeper | Unit tests for every transition and TTL |
| 3 | service | Rate limits, origin check, resume/grace | e2e tests with 2–3 raw `ws` clients: claim, invite, accept, relay, end, drop + resume, expiry |
| 4 | app | Vite + React scaffold, theme, font, icon set, Home with quotes | Home renders on a 360px phone, Lighthouse perf ≥ 95 |
| 5 | app | `crypto/` (keys, commitment, channel, padding, safety code) | Unit tests incl. known-answer tests, replay rejection, tamper → end |
| 6 | app | State machine + socket layer + screens: Claim, Lobby, Verify, Chat, Ended | Full flow between two browser windows locally |
| 7 | both | Playwright two-context e2e (desktop + mobile viewport), "server can't read" test, log-leak test | Green in CI |
| 8 | ops | App Platform app (`web` Caddy container + `api`, 1 instance, `preserve_path_prefix`), CSP report-only first, HSTS (DNSSEC only after leaving App Platform) | Staging at a private subdomain |
| 9 | app | `/how` and `/security` plain-language pages, English + Albanian strings | Reviewed by you |
| 10 | ops | CSP enforced, build hashes recorded, launch | tung.chat live |

## v1.1
- One-time invite code/link as an alternative to name lookup (D2).
- Installable PWA (static-asset service worker only).
- Message fade timer (D4) if not in v1.
- External review of the crypto code.

## v2
- **PAKE-bound security answer** (SECURITY §3): a matching answer is what unlocks the keys, so even a malicious server can't sit in the middle. Blocked on finding an audited browser implementation.
- Per-message symmetric ratchet for forward secrecy *within* a conversation.
- Open-source the app repo with reproducible builds and a verification page (D6, second step).
- Move from App Platform to our own server with access logs off (D7).

## Not planned
Accounts, contact lists, group chats, file/image sharing, message history, push notifications, offline delivery. Each of these either needs storage or widens what the server knows.
