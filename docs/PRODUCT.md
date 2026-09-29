# tung.chat — Product

Written 2026-09-29. Decisions marked **D1–D7** are listed in [README.md](README.md#decisions).

## 1. Principles

1. **One pseudonym, one conversation.** A pseudonym is born when you arrive and dies when the conversation ends. No accounts, no history, no contacts list.
2. **Both people must be online.** There is no storage, so there is no offline delivery. If the other person isn't there, you can't reach them. This is the product, not a limitation.
3. **Nothing survives "end".** Either person can end the conversation at any time. Both screens are wiped, both pseudonyms are released, the keys are destroyed.
4. **The server knows as little as possible.** It knows two pseudonyms are paired and that encrypted frames pass between them. It never sees messages, questions, answers, or keys.
5. **Light and fast.** Loads on a weak phone connection. No images beyond the icon, no third-party anything.

## 2. User flow

```
 Home ──► Claim pseudonym ──► Lobby ──┬──► (initiator) look up pseudonym ─► Invite sent ─┐
                                      │                                                  │
                                      └──► (invitee) invite arrives ─► Accept ◄──────────┘
                                                                          │
                                                                          ▼
                                                         Verify (questions + safety code)
                                                                          │
                                                                  both press GO
                                                                          ▼
                                                                        Chat
                                                                          │
                                                             either side presses END
                                                                          ▼
                                                              Ended (wiped) ─► Home
```

### 2.1 Home
- Wordmark `tung_` with a blinking cursor, one line of explanation, and a rotating quote (see §5).
- One action: `[ start ]`.
- Small links: `how it works`, `security` (plain-language summary of SECURITY.md, including what we *cannot* protect).

### 2.2 Claim a pseudonym
- Prompt: `> choose a name for this conversation only_`
- Rules: 3–24 characters, `a–z 0–9 - _`, case-insensitive, trimmed. A `[ random ]` button suggests one (`quiet-heron-42` style) for people who don't want to think.
- Unique only among currently live pseudonyms. If taken: `name in use. pick another.` (No hint about who holds it.)
- Tell the user plainly: *share this name with the other person yourself, through whatever channel you trust.* tung.chat has no directory.

### 2.3 Lobby
The user waits here as either role.
- Shows own pseudonym and a live countdown to lobby expiry (30 min without a conversation).
- **To start a conversation:** type the other person's exact pseudonym → `[ invite ]`. Result is either `invitation sent` or `no one by that name is here` — no partial matches, no suggestions, no list of who is online (D2).
- **Incoming invitation:** `quiet-heron-42 wants to talk. [ accept ] [ decline ] [ block ]`. Expires after 2 minutes. `block` prevents that pseudonym inviting you again for the life of your pseudonym.
- One conversation per pseudonym. While an invite is pending or a chat is open, you cannot send or receive other invites.

### 2.4 Verify
The chat channel is already encrypted at this point, but chat is locked. Only the verification panel is visible.

- **Safety code.** Both screens show the same short code, e.g. `ember · north · violin · tide · delta`. It is derived from both people's encryption keys. If the two of you can compare it by another channel (a call, in person, a message elsewhere), a match proves no one is sitting in the middle, including us. The UI says this in one sentence and lets people skip it.
- **Questions.** The initiator types a question; the invitee types an answer; the initiator sees the answer and marks it `✓ right` or `✗ wrong`. Repeat as many times as wanted. Per **D1** the invitee can ask questions the same way.
- A single `✗ wrong` does not end the chat automatically; the asker decides. `[ end ]` is always visible.
- **Go.** When the initiator presses `[ go ]` the chat opens. Per **D1** the chat opens only when *both* sides have pressed go (the invitee sees "waiting for quiet-heron-42 to open the chat", and vice versa). Before go, the initiator can optionally choose message fade time (D4).
- Verification has a 10-minute limit. After that the conversation ends automatically.

### 2.5 Chat
- Plain terminal-style transcript: `quiet-heron-42 > message`. Own lines dimmer or prefixed with `you >`.
- Text only in v1. Max 2,000 characters per message. No files, no images, no links preview (links render as plain text, not clickable, to avoid accidental navigation that leaks a referrer or IP).
- Status line: `● encrypted · safety code: ember north violin tide delta · 12:04 open`.
- Peer connection status: `peer lost connection, waiting 45s…` (D3). If they come back, the chat continues; if not, it ends.
- Optional typing indicator — not built in v1 (off by default — it leaks nothing to the server beyond timing it already sees, but some people find it intrusive).
- `[ end ]` always visible top-right. Also: pressing `Esc` twice within one second ends immediately ("panic").
- Idle limit: if no message in either direction for 30 minutes, the conversation ends.

### 2.6 Ended
- `conversation ended. nothing was kept.` Then back to Home after a few seconds.
- The reason is shown in neutral terms: `ended by you`, `ended by the other side`, `connection lost`, `timed out`.
- Pseudonyms are released. To talk again, both pick new names and start over.

## 3. Rules

| Rule | Value | Why |
|---|---|---|
| Pseudonym length | 3–24, `[a-z0-9_-]` | Easy to say out loud, safe to render |
| Pseudonym lifetime without a conversation | 30 min | Stops squatting |
| Invite lifetime | 2 min | Both people are supposed to be there right now |
| Verification phase limit | 10 min | Stops half-open sessions |
| Chat idle limit | 30 min | Forgotten tab on a shared computer |
| Reconnect grace | 45 s | Phones drop sockets when switching apps |
| Message size | 2,000 characters (and ≤ 6,000 bytes) | Text chat, not file transfer |
| Messages per second per side | 5 sustained, burst 20 | Anti-flood |
| Invites per pseudonym | 10 per 10 min | Anti-enumeration and spam |
| Pseudonym claims per IP | 20 per hour | Anti-squatting |

All values live in server config and can be tuned without code changes.

## 4. Look and feel — hacker theme

- **Palette** (CSS variables, dark only; there is no light theme):
  - `--bg #050805` near-black with a green tint
  - `--fg #8CF5A4` phosphor green, body text
  - `--accent #39FF6A` bright green, cursor, buttons, own pseudonym
  - `--dim #3E6B4A` timestamps, hints, borders
  - `--peer #E6FFE9` near-white for the other person's lines (easy to tell apart)
  - `--warn #FFB000` amber for grace windows and wrong answers
  - `--danger #FF4D4D` for end/panic
- **Font:** JetBrains Mono (SIL Open Font License), **self-hosted** as `woff2` in `public/fonts/`. No Google Fonts: an external font request tells a third party who is visiting and breaks the strict CSP (see SECURITY.md §5).
- **Details:** blinking block cursor on prompts, square brackets for buttons `[ go ]`, subtle scanline overlay (pure CSS, disabled under `prefers-reduced-motion`), no rounded corners except the icon.
- **Mobile:** layout uses `100dvh`, respects safe-area insets, keeps the input above the on-screen keyboard (`visualViewport` resize), inputs at 16px so iOS doesn't zoom. Tap targets ≥ 44px. The chat must be fully usable one-handed on a 360px-wide screen.
- **Privacy UX:**
  - When the tab/app goes to the background, the transcript is blurred (so the phone's app switcher preview doesn't show messages).
  - Browser tab title is always `tung` — never unread counts or names.
  - No system notifications with message content, ever. An optional sound-only ping on new message.
  - `autocomplete="off"`, `autocorrect="off"`, `spellcheck="false"` on the chat input to keep text out of keyboard learning where the platform respects it.

## 5. Home page quotes

- A bundled static file `src/content/quotes.json` in the app: `[{ "text": "...", "author": "Seneca", "work": "Letters to Lucilius", "translator": "Richard M. Gummere (1917)" }]`. No API call.
- One quote shown at random on load, rotating every ~20 seconds with a type-on effect (respecting reduced motion).
- Status 2026-09-29: 47 quotes in the file. Entries marked `"check": true` need their wording checked against the cited translation before launch; grow toward ~80–120 only with wording that can be verified.
- Target ~80–120 quotes: Heraclitus, Socrates (via Plato), Epicurus, Seneca, Epictetus, Marcus Aurelius, Lao Tzu, Zhuangzi, Montaigne, Pascal, Spinoza, Schopenhauer, Kierkegaard, Nietzsche, Thoreau, Emerson. Themes that fit the product: silence, trust, secrets, speech, impermanence.
- **Copyright:** the original authors are public domain, but many *translations* are not. Use only translations that are themselves public domain (e.g. George Long's Marcus Aurelius and Epictetus, Gummere's Seneca, Legge's Lao Tzu, Cotton's Montaigne, older Nietzsche translations) or authors who wrote in English (Thoreau, Emerson). Record the translator in each entry.
- With D5, an Albanian set can be added later as its own file.

## 6. Icon

Draft at `tung-chat-app/public/icon.svg`.

- A speech bubble drawn as a phosphor-green outline on the near-black background, with a terminal prompt inside: a `>` chevron and a `_` cursor. Reads as "chat" and "terminal" at the same time, and the cursor is the brand element shared with the wordmark `tung_`.
- Pure geometry (no text, no font dependency), so it renders identically everywhere and stays sharp at 16px.
- From it we generate at build time: `favicon.ico` (32/16), `apple-touch-icon.png` (180), `icon-192.png` and `icon-512.png` for the web manifest, plus a maskable variant with extra padding.
