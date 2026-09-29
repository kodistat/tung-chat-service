# tung.chat — Security

Written 2026-09-29. The whole product is secrecy, so this is the most important document. It says what the design protects, what it does not, and what must be built for the promises to be true. Items are ordered by severity.

## 1. What we promise, precisely

**We promise:**
- Message content, security questions, and answers are readable only by the two browsers in the conversation.
- The server keeps nothing on disk. When a conversation ends, the server forgets both pseudonyms and the pairing.
- The browser keeps nothing either: no storage, no cookies, no history entries with conversation data.

**We do not and cannot promise** (and the `/security` page must say so in plain words):
- That the other person isn't screenshotting, photographing the screen, or copying text.
- That the device isn't compromised (malware, spyware, a browser extension that reads the page).
- That nothing reaches the disk. The operating system can copy browser memory to disk (swap, hibernation files, crash reports), and a web page can't prevent it. Disk encryption makes it unreadable; iPhones don't swap to disk, and Macs encrypt swap. The weak spot is Windows without BitLocker/device encryption.
- Anonymity from the network. Our server, DigitalOcean, and Cloudflare (which carries App Platform traffic) see IP addresses while you're connected. Use Tor Browser or a VPN if that matters to you.
- That the JavaScript you're running is the published version (see §4) unless you verify it.

Every item below exists to make the first list true.

## 2. End-to-end encryption

**Severity: the product doesn't exist without it.**

"Conversations don't live on the server" is only a retention *policy* if the server can read them. An operator with access, a hosting provider, a court order, or an attacker who compromises the server could log messages in transit, and "we delete everything" would still be technically true. The only way to make secrecy a *property* is that the server never has the keys.

Design (details in PROTOCOL §5):
- Each browser generates a fresh X25519 keypair for this conversation only; the private key is non-extractable and never leaves the tab.
- Keys are agreed via ECDH through the server; the server only ever sees public keys.
- Every message, question, answer, and verdict is encrypted with AES-256-GCM with separate keys per direction, counter nonces, replay rejection, and length-hiding padding.
- When the conversation ends the keys are dropped; there is no long-term key, so a later compromise can't decrypt anything recorded earlier (forward secrecy per conversation).

## 3. The security-question flow and its limit

**Severity: high. This is a gap in the original design and needs to be understood before building.**

The security questions are a good idea, but they protect against a different threat than people will assume.

- **What questions protect against:** the wrong *person*. Someone guessed or overheard the pseudonym and claimed it first, or is squatting the name you told your friend. They won't know the answer to "what did we eat in Durrës?".
- **What they do *not* protect against:** a man-in-the-middle *on the channel*, which for us means the server itself (compromised, coerced, or malicious operator). During the key exchange the server could hand each browser its own key instead of the peer's. It then decrypts everything from A, re-encrypts to B, and vice versa. The questions and answers flow through it untouched, both people pass verification, and the server reads the whole conversation.

Two defences, in order of when we ship them:

### v1 — Safety code with commitment (ships first)
Both screens show five words derived from both public keys (PROTOCOL §5.3). If a man-in-the-middle is present the words differ. People who can compare them over another channel (phone call, in person, another app) get proof no one is in the middle. The **commitment** (the initiator sends a hash of their key first and reveals the key only after the invitee's key is fixed) means an attacker can't search for keys that make the codes match; they get one guess at 1 in 2⁴⁰.

Limit: it relies on people actually comparing the code through another channel. Many won't. That's why v2 exists.

### v2 — Bind the security answer into the key exchange (PAKE)
This is what makes the original idea cryptographically real. The asker types the question *and the expected answer* locally; the answerer types their answer; both run a **Password-Authenticated Key Exchange** (e.g. CPace or SPAKE2) using the answer as the shared password. If the answers match, the resulting keys match and the chat decrypts; if not, it fails. A server in the middle can't pass without knowing the answer, and gets exactly one online guess per conversation (after which the conversation ends).

Notes before building v2:
- Answers must be normalized identically on both sides (trim, lowercase, collapse spaces, strip accents) or real users will fail.
- A naive scheme like `HMAC(answer, transcript)` is **not** a substitute: an attacker who sees the HMAC can brute-force short answers offline in seconds. It has to be a real PAKE.
- A maintained, audited browser PAKE implementation must be found and reviewed first (CPace has an IETF draft with reference code; check current JS implementations and their audit status). If none is good enough we stay on v1 rather than hand-roll one.

### Mutual verification (decision D1)
As originally specified, only the initiator verifies. The invitee has no way to check who invited them — and the invitee is the one being approached. Recommendation: either side can ask questions, both must press go, and the safety code is shown to both.

## 4. Web-delivered crypto: trusting the JavaScript

**Severity: high, inherent to any browser-based E2EE.**

Every visit downloads the code that does the encryption. Whoever controls what tung.chat serves (us, the server, a hijacked domain, a compromised build) could serve a version that quietly sends keys elsewhere, and the user would not notice. Native apps have the same problem at update time; browsers have it on every page load. We can't eliminate this; we can make it expensive and detectable:

- **No third-party code or requests at all.** No analytics, no CDNs, no Google Fonts, no external images, no error-tracking SDK in the browser. Every byte comes from tung.chat.
- **Strict Content-Security-Policy** (§5) so injected or inline scripts can't run.
- **Subresource Integrity** on every script and stylesheet in `index.html`.
- **Small, dependency-light bundle.** React + our code; audit the lockfile; pin versions; `pnpm audit` in CI.
- **Reproducible builds now, open source later (D6).** v1 keeps the repos private but records the SHA-256 of every built file per release. In the second step we publish the source and hashes so anyone can verify that what tung.chat serves equals what the public source builds to. Until then, users are trusting us — the `/security` page should say so.
- **Domain protection:** registrar lock, HSTS, 2FA on registrar, GitHub, and DigitalOcean. DNSSEC is not possible while on App Platform (it rejects DNSSEC-enabled domains); add it after the move to our own server. Submit to the HSTS preload list only once the setup is stable — removal is slow and hard.

## 5. Required HTTP security headers (Caddy in the `web` container)

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
  font-src 'self'; img-src 'self' data:; connect-src 'self' wss://tung.chat;
  manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';
  upgrade-insecure-requests
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Permissions-Policy: camera=(), microphone=(), geolocation=(), clipboard-read=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Cache-Control: no-store            (on index.html; hashed assets may be cached immutable)
```

These are the **production** headers. Vite's dev server injects `<style>` tags and uses `ws://localhost:*` for hot reload, so local development runs without this CSP (or with `'unsafe-inline'` styles and a localhost `connect-src`). Test the real policy against the production build before every release.

The WebSocket endpoint must check the `Origin` header equals `https://tung.chat` (and localhost in development) to stop other sites opening sockets from a visitor's browser.

## 6. Metadata the server can't avoid seeing

**Severity: medium.** Encryption hides content, not the envelope. While a conversation is live the server necessarily knows:
- the two pseudonyms and that they are paired,
- when frames are sent and their padded size bucket,
- the IP addresses of both sockets.

What we do about it:
- **Nothing is written down.** Only allowlisted log fields (event type, counts, durations, error codes). The logger accepts numbers and booleans only, so pseudonyms, IPs, and ids can't be logged by accident (`src/common/logger.ts`).
- **Access logs off** in our own Caddy and Node. **Accepted gap for now (D7):** App Platform traffic reaches us through **Cloudflare** (responses carry `server: cloudflare`, confirmed 2026-09-29) and then DigitalOcean's router. Both terminate TLS, both can log client IPs, request paths (`/`, `/ws`), and connection timing, and we can't turn that off. They see no content — frames are encrypted end-to-end in the browser — but they are a TLS-terminating middlebox, so the page itself travels decrypted through them (one more reason for SRI and, later, published build hashes). Moving to our own server with access logs off removes both; revisit before any growth push.
- **IP only for rate limiting**, as an HMAC with a random daily salt held in memory, dropped after an hour of inactivity.
- **No disk writes** by our process; on the later self-hosted setup, also no swap so live pseudonyms are never paged to disk.
- **Pseudonyms are the users' problem to keep meaningless.** The UI suggests random names and warns against using real names.

## 7. Pseudonym namespace abuse

**Severity: medium.**

| Threat | Mitigation |
|---|---|
| Enumerating who is online by guessing names | Exact-match lookup only. No search, no suggestions, no list. Invites rate-limited per session and per IP. Busy, blocked, and nonexistent all return the same `unavailable`. |
| Invite spam / harassment | One pending invite at a time; 2-minute expiry; `decline + block`. |
| Squatting a name someone is about to use | 30-minute lobby expiry; claim rate limit per IP; and the security questions exist precisely to catch an impostor holding the name. |
| Look-alike names (`rn` vs `m`, Cyrillic letters) | Restrict to `[a-z0-9_-]`, which removes homoglyph tricks from other alphabets. |

**Alternative (D2):** instead of looking someone up by name, the invitee could get a one-time invite code/link to share out of band. That removes lookup and enumeration entirely. Recommended as an addition in v1.1, not a replacement, because lookup-by-name is the flow you designed.

## 8. Client-side hygiene

- No `localStorage`, `sessionStorage`, IndexedDB, or cookies (enforced by a lint rule).
- The ended screen tells people to close the tab, and the `/security` page lists what they can do themselves for a clean finish: close the tab, private window, disk encryption on, crash reports off.
- No conversation data in the URL, page title, or history.
- On `end`, `ended`, `pagehide`, or tab close: drop keys, zero out transcript state, close the socket.
- Blur the transcript when the page is hidden (mobile app-switcher previews).
- No notifications with content. No link previews; links are not clickable.
- If a service worker is ever added, it caches static assets only and never touches `/ws`.
- Input fields: `autocomplete="off"`, `autocorrect="off"`, `spellcheck="false"`.

## 9. Server-side hardening

- Zod-validate every frame; close on any violation. Cap frame size at the WebSocket level (`maxPayload`).
- Token-bucket rate limits per connection and per salted IP (values in PRODUCT §3).
- Cap total concurrent sessions and sessions per IP to avoid memory exhaustion.
- Resume tokens are 256-bit random, stored only as hashes, rotated on every resume, compared in constant time.
- Containers run as non-root users; the relay trusts the client-IP header only when `TRUSTED_IP_HEADER` is configured.
- Caps: 20 concurrent connections per IP, 20,000 sessions total, first frame must be `hello` within 10 s.
- Dependencies pinned and audited; minimal package list.

## 10. Abuse and legal position

End-to-end encryption plus no storage means **we cannot read, moderate, or hand over conversations**, and there is no content-based abuse reporting. The block button is the only tool. This is the intended trade-off, but as an operator based in Albania you should get a short legal opinion on hosting a service like this, and publish a clear privacy notice and terms that state exactly what the server sees (§6) and retains (nothing).

## 11. Before launch

- [x] Full-flow test through the real relay (`tung-chat-app/test/conversation.test.ts`), reconnection and timeouts in unit tests; manual two-tab run in a browser, desktop and phone width.
- [x] Test that proves the relay never sees plaintext: every frame is captured during a test chat and no question, answer, message, or safety word appears.
- [x] No pseudonym/IP in logs: the logger only accepts numeric fields (`src/common/logger.ts`).
- [x] Production build run locally under the exact CSP (`vite preview`): no violations; a positive control confirmed violations are reported.
- [ ] CSP on staging (report-only first), then enforce.
- [ ] First App Platform deploy: confirm `do-connecting-ip`, `preserve_path_prefix`, and that both Dockerfiles build (not verifiable locally — no Docker here).
- [ ] External review of `src/crypto/` by someone who didn't write it.
- [ ] Publish `/security` page and build hashes.
