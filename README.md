# tung-chat-service

Relay server for [tung.chat](https://tung.chat). It holds live pseudonyms, delivers invitations, and forwards end-to-end encrypted frames between two browsers. It cannot read messages, has no database, and writes nothing to disk.

Docs: [docs/README.md](docs/README.md) (start here), [docs/PROTOCOL.md](docs/PROTOCOL.md) (what this implements).

## Stack
NestJS 12 on Express (ESM), raw `ws` at `/ws`, Zod-validated frames, in-memory state, pino with allowlisted fields. Node 24, pnpm.

## Develop
```bash
nvm use
pnpm install
cp example.env .env   # optional; defaults work locally
pnpm dev              # http://localhost:4000/health, ws://localhost:4000/ws
```

## Test
```bash
pnpm test        # state machine unit tests (no sockets)
pnpm test:e2e    # real app + real WebSocket clients
pnpm typecheck && pnpm lint
```

## Layout
- `src/protocol/frames.ts` — outer frame schemas; **source of truth**, copied into `tung-chat-app`
- `src/relay/relay.service.ts` — the whole state machine (pure, clock + transport injected)
- `src/relay/relay.server.ts` — `ws` server: origin check, client IP, sockets ↔ relay
- `src/limits/` — token buckets, salted IP keys
- `deploy/app.yaml` — DigitalOcean App Platform spec (`web` + `api`, api fixed at 1 instance)

## Config
See `example.env`. All timers and caps can be overridden by env vars (see `src/config.ts`).
