# tung.chat — Protocol

Written 2026-09-29. Version `1`. This is the document to build both repos from. The Zod schemas in `tung-chat-service/src/protocol/frames.ts` must match it exactly; the app keeps a synced copy.

Two layers:

- **Outer frames** — JSON over the WebSocket, readable by the server. Only what the server needs for routing.
- **Inner frames** — encrypted end-to-end between the two browsers, carried inside outer `relay` frames. The server sees only padded ciphertext.

## 1. Client state machine

```
home ──start──► connecting ──welcome──► naming ──claimed──► lobby
                                                             │  │
                          ┌────────── invite ────────────────┘  └──── invite_in ───────┐
                          ▼                                                             ▼
                      inviting ──declined/expired/cancel──► lobby ◄──decline/expire── invited
                          │                                                             │
                       paired (+ peer pub)                                     accept → paired
                          │                                                             │
                          └───────── reveal / peer_reveal, derive keys ─────────────────┘
                                                  ▼
                                             handshake ──both inner `hello` ok──► verifying
                                                                                     │
                                                                  both inner `go` ───┘
                                                                          ▼
                                                                        chat
 any state ── end / ended / resume_failed / fatal error ──► ended ──(3 s)──► home (all memory wiped)
```

`verifying` vs `chat` is known only to the two clients. The server just sees a paired session.

## 2. Server session state

| State | Meaning | TTL (then teardown) |
|---|---|---|
| `connected` | Socket open, no pseudonym yet | 2 min |
| `claimed` | Holds a pseudonym, idle in lobby | 30 min |
| `inviting` | Has one outbound invite pending | invite TTL 2 min, then back to `claimed` |
| `invited` | Has one inbound invite pending | same invite |
| `paired` | Linked to a peer, relaying frames | 30 min with no `relay` frame in either direction |
| *(grace)* | Socket dropped in any state | 45 s to resume, else teardown |

A session has at most **one** pending invite in either direction. Invites to a session that is busy, blocked the sender, is inside its reconnect grace, or doesn't exist all return the same `unavailable` error, so the sender learns nothing beyond "not reachable right now".

If the invitee is inside its grace window when the initiator sends `reveal`, the server answers `undeliverable` and does not mark the key as revealed; the initiator re-sends `reveal` after `peer_back`.

If the initiator is inside its grace window when the invitee sends `accept`, the server answers `error unavailable` and keeps the invite; the invitee may retry until it expires.

On `resumed`, the client must trust the server's `state` over what it remembers: notifications sent while it was away (e.g. `invite_expired`) were dropped, not queued.

**Teardown** of a paired session tears down both sides: remove both pseudonyms, delete the pairing, send `ended` to whichever sockets are live, close them. Teardown of an unpaired session removes its pseudonym and any invite it's part of (notifying the other party with `invite_cancelled`).

## 3. Outer frames

All frames are JSON objects with a `type` field. Binary data is base64url without padding. Unknown types or schema mismatches close the socket with code `4001`.

### Client → server

| type | fields | notes |
|---|---|---|
| `hello` | `v: 1`, `resume?: string` | Must be the first frame, within 10 s of connecting, or the socket closes with `4003`. With `resume`, re-attaches to a session. |
| `claim` | `pseudonym: string` | Normalized server-side: trim, lowercase, `^[a-z0-9_-]{3,24}$`. |
| `invite` | `to: string`, `commit: string` | `commit` = SHA-256 of the initiator's X25519 public key (§5.2). |
| `invite_cancel` | `inviteId: string` | |
| `accept` | `inviteId: string`, `pub: string` | Invitee's X25519 public key (32 bytes). |
| `decline` | `inviteId: string`, `block?: boolean` | `block` adds sender's pseudonym to this session's block set. |
| `reveal` | `pub: string` | Initiator's public key, sent after `paired`. Server forwards to peer. Accepted only from the initiator of the pair, only in `paired` state; otherwise `4001`. Repeats are forwarded again (the initiator re-sends after reconnects; the invitee ignores duplicates). `relay` frames are refused until a `reveal` has been forwarded. |
| `relay` | `c: string` | Ciphertext of one inner frame. Max 12 KB encoded. |
| `end` | — | Ends immediately, no grace. |
| `ping` | — | Every 20 s. Server answers `pong`. |

### Server → client

| type | fields | notes |
|---|---|---|
| `welcome` | `resumeToken: string`, `limits: {...}` | Token is 32 random bytes; server stores only its hash. |
| `resumed` | `resumeToken: string`, `state`, `pseudonym?`, `peer?` | Token is rotated on every resume. |
| `resume_failed` | — | Session is gone. Client goes to `ended`. |
| `claimed` | `pseudonym: string`, `expiresAt: number` | |
| `invite_sent` | `inviteId: string`, `expiresAt: number` | |
| `invite_in` | `inviteId`, `from: string`, `commit: string`, `expiresAt` | |
| `invite_declined` / `invite_expired` / `invite_cancelled` | `inviteId` | Back to lobby. |
| `paired` | `pairId: string`, `peer: string`, `pub?: string` | Initiator receives invitee's `pub`; invitee receives no `pub` (it arrives via `peer_reveal`). |
| `peer_reveal` | `pub: string` | Invitee only. Must hash to the `commit` from `invite_in`, or the client ends the chat. |
| `frame` | `c: string` | Inner frame from the peer. |
| `undeliverable` | — | Peer is in grace; the last `relay` was dropped. Client marks the message unsent. |
| `peer_away` | `graceUntil: number` | |
| `peer_back` | — | |
| `ended` | `reason: 'peer_end' \| 'peer_lost' \| 'idle' \| 'expired' \| 'server_restart'` | |
| `error` | `code` | See §7. Non-fatal unless the socket is also closed. |
| `pong` | — | |

The server **never buffers** relay frames for an absent peer. It returns `undeliverable` and the sender's client can resend after `peer_back`.

## 4. Reconnection

- The resume token exists only in the tab's JavaScript memory. Reloading or closing the tab loses it — that is an intentional "end".
- On socket close, the client reconnects with exponential backoff (0.5 s, 1 s, 2 s, 4 s … capped at 8 s) and sends `hello { resume }`.
- If the session is still within its 45 s grace, the server attaches the new socket, rotates the token, tells the peer `peer_back`, and returns `resumed`. Keys, counters, and transcript stay in the client's memory, so the chat continues.
- If a second socket resumes a session that already has a live socket, the old one is closed with `4004` (replaced).
- If grace runs out, the server tears down the session and the peer receives `ended { reason: 'peer_lost' }`.

## 5. End-to-end encryption

### 5.1 Primitives (WebCrypto)
- Key agreement: **X25519**, fresh ephemeral keypair per conversation, private key created `extractable: false`.
- Key derivation: **HKDF-SHA-256**.
- Encryption: **AES-256-GCM**, separate key per direction.
- Hash: **SHA-256**.

### 5.2 Handshake with commitment

The commitment step stops a man-in-the-middle from trying many keys until the safety codes happen to match (see SECURITY §3).

```
Initiator A                          Server                         Invitee B
  gen (skA, pkA)
  invite{to:B, commit:H(pkA)} ──────────►  invite_in{from:A, commit} ────►
                                                                     gen (skB, pkB)
                               ◄──────────  accept{inviteId, pub:pkB} ◄──
  ◄── paired{pairId, peer:B, pub:pkB}       paired{pairId, peer:A} ─────►
  reveal{pub:pkA} ─────────────────────────► peer_reveal{pub:pkA} ───────►
                                                                     check H(pkA) == commit
  both: shared = X25519(sk, peer_pk)
        th     = SHA-256("tung/v1" ‖ pairId ‖ pseudoA ‖ pseudoB ‖ pkA ‖ pkB)
        kAB    = HKDF(shared, salt=th, info="tung/v1 A->B", 32)
        kBA    = HKDF(shared, salt=th, info="tung/v1 B->A", 32)
        sas    = HKDF(shared, salt=th, info="tung/v1 sas", 5)
  both send inner `hello` (key confirmation) ◄──── relay ────►
```

- Length-prefix every field in `th` (2-byte big-endian length) so concatenations are unambiguous.
- `pseudoA` is always the initiator's pseudonym, `pseudoB` the invitee's.
- After deriving keys, both clients drop `sk` and `shared` references; the derived `CryptoKey`s are non-extractable.

### 5.3 Safety code
`sas` (5 bytes = 40 bits) → 5 words, one per byte, from a fixed 256-word list (`src/content/wordlist.json`, short, distinct, easy to say). Shown to both sides, e.g. `ember · north · violin · tide · delta`. Because of the commitment, a man-in-the-middle gets exactly one attempt with a 1 in 2⁴⁰ chance of matching.

### 5.4 Inner frame encryption
- Plaintext = UTF-8 JSON of the inner frame, then **padded**: 2-byte length prefix + data + zero bytes up to the next bucket of 256, 512, 1024, 2048, 4096, or 8192 bytes. Hides message length from the server.
- Nonce (12 bytes) = 4 zero bytes ‖ 64-bit big-endian send counter. Counter starts at 0, increments on every encryption, never reused within a direction key.
- Additional authenticated data = `pairId`.
- Wire: `c = base64url(counter(8) ‖ ciphertext‖tag)`.
- Receiver rejects any counter ≤ the last accepted one (replay/reorder). A gap (counter jumped) is allowed — normally it means a frame was `undeliverable` and will be re-sent as a new frame — but the receiver always renders `— a message did not arrive —` at the gap. An honest `undeliverable` and a server silently dropping frames look the same to the receiver, so the gap must be visible.
- Any decryption failure ends the conversation (`end`) with an on-screen warning: "the channel was tampered with or broke".

### 5.5 Inner frames

| t | fields | who | meaning |
|---|---|---|---|
| `hello` | `role: 'A' \| 'B'` | both | Key confirmation. Must be the first inner frame each way. |
| `q` | `id`, `text` (≤ 500) | either (D1) | Security question |
| `a` | `qid`, `text` (≤ 500) | either | Answer |
| `judge` | `qid`, `ok: boolean` | asker | Asker's verdict, shown to the answerer |
| `sas_ok` | — | either | "I compared the safety code and it matched" (informational) |
| `go` | `fade?: 0 \| 60 \| 300 \| 900` | both | Ready to chat. Initiator's `fade` wins (D4). Chat opens when both have sent `go`. |
| `msg` | `id`, `text` (≤ 2000 characters **and** ≤ 6,000 UTF-8 bytes) | both | Chat message (only accepted in `chat` state). The byte cap keeps the padded frame inside the 8,192 bucket; enforced before encrypting, with a test using 4-byte characters. |
| `typing` | `on: boolean` | both | Optional |

Receivers ignore `msg` before both `go`s, and ignore `q/a/judge/go` after chat opens.

**After a reconnect** (our `resumed` while paired, or the peer's `peer_back`) each client re-sends its state-like frames, which receivers treat as idempotent: the initiator's `reveal` (if the invitee's `hello` hasn't arrived), the invitee's `hello` (if the initiator's hasn't arrived), `sas_ok`, and `go`. A duplicate `hello` received by the initiator is answered with its own `hello`. One-off frames (`q`, `a`, `judge`, `msg`) are blocked in the UI while either side is reconnecting.

## 6. Timers

| Timer | Where enforced | Value |
|---|---|---|
| Unclaimed connection | server | 2 min |
| Lobby (claimed, no pair) | server | 30 min |
| Invite pending | server | 2 min |
| Verification (paired → both `go`) | **both clients** (server can't see it) | 10 min |
| Paired idle (no `relay`) | server | 30 min |
| Reconnect grace | server | 45 s |
| Client ping | client | every 20 s (app-level `ping`) |
| Server ping | server | WebSocket protocol ping every 20 s; browsers answer without running JS, so throttled background tabs stay alive |
| Silent socket | server | no frame or pong for 60 s → socket closed with `4003` and the session enters grace (resumable) |
| Ended screen | client | 3 s, then wipe and home |

## 7. Error codes

`invalid_name`, `name_taken`, `unavailable`, `busy` (you already have a pending invite or pair), `not_paired`, `rate_limited`, `expired` (the invite no longer exists or isn't yours).

Malformed or oversized frames are not answered with an error frame; the socket is closed (`4001`, or `1009` from `ws` when a frame exceeds 12 KB).

WebSocket close codes: `4000` normal end, `4001` protocol violation, `4002` rate limited, `4003` expired, `4004` replaced by resumed socket, `4005` server restart, `1009` frame too large (sent by `ws`).

HTTP responses to the upgrade request: `403` wrong origin, `429` per-IP connection cap reached.
