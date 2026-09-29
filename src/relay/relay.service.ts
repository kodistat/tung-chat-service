import { createHash, randomBytes } from 'node:crypto';
import type { Config } from '../config.js';
import type { EventLogger } from '../common/logger.js';
import { TokenBucket } from '../limits/token-bucket.js';
import {
  type ClientFrame,
  CloseCode,
  type EndReason,
  type ErrorCode,
  type Limits,
  type ServerFrame,
  type SessionState,
  clientFrameSchema,
  isValidPseudonym,
  normalizePseudonym,
  RELAY_MAX_CHARS,
} from '../protocol/frames.js';

// The relay's whole state machine (docs/PROTOCOL.md §2–4). Pure logic: sockets live in
// RelayServer and reach this class through the Transport interface, and time comes from
// the injected clock, so every transition can be tested without I/O.

export type ConnId = string;

export interface Transport {
  send(connId: ConnId, frame: ServerFrame): void;
  close(connId: ConnId, code: CloseCode): void;
}

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

interface Conn {
  id: ConnId;
  ipKey: string;
  sessionId: string | null;
  openedAt: number;
  lastSeen: number;
  frames: TokenBucket;
}

interface Session {
  id: string;
  connId: ConnId | null;
  tokenHash: string;
  pseudonym: string | null;
  state: SessionState;
  inviteId: string | null;
  pairId: string | null;
  blocked: Set<string>;
  expiresAt: number;
  graceUntil: number | null;
  relay: TokenBucket;
  invites: TokenBucket;
}

interface Invite {
  id: string;
  from: string;
  to: string;
  expiresAt: number;
}

interface Pair {
  id: string;
  initiator: string;
  invitee: string;
  revealed: boolean;
}

interface IpState {
  conns: number;
  claims: TokenBucket;
  invites: TokenBucket;
  lastUsed: number;
}

const IP_STATE_IDLE_MS = 60 * 60 * 1000;

const nullTransport: Transport = { send() {}, close() {} };

function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function closeCodeFor(reason: EndReason): CloseCode {
  if (reason === 'server_restart') return CloseCode.serverRestart;
  if (reason === 'idle' || reason === 'expired') return CloseCode.expired;
  return CloseCode.normal;
}

export class RelayService {
  private readonly conns = new Map<ConnId, Conn>();
  private readonly sessions = new Map<string, Session>();
  private readonly byToken = new Map<string, string>();
  private readonly byPseudonym = new Map<string, string>();
  private readonly invites = new Map<string, Invite>();
  private readonly pairs = new Map<string, Pair>();
  private readonly ips = new Map<string, IpState>();
  private transport: Transport = nullTransport;

  constructor(
    private readonly cfg: Config,
    private readonly clock: Clock,
    private readonly log: EventLogger,
  ) {}

  attach(transport: Transport): void {
    this.transport = transport;
  }

  stats() {
    return { connections: this.conns.size, sessions: this.sessions.size, pairs: this.pairs.size };
  }

  limits(): Limits {
    const t = this.cfg.timers;
    return {
      maxMessageBytes: this.cfg.caps.maxMessageBytes,
      relayMaxChars: RELAY_MAX_CHARS,
      graceMs: t.graceMs,
      inviteTtlMs: t.inviteTtlMs,
      lobbyTtlMs: t.lobbyTtlMs,
      verifyTtlMs: t.verifyTtlMs,
      pairedIdleMs: t.pairedIdleMs,
      pingIntervalMs: t.pingIntervalMs,
    };
  }

  // ── Connection lifecycle ────────────────────────────────────────────────

  /** Cheap pre-check before the WebSocket handshake. */
  canAccept(ipKey: string): boolean {
    if (this.conns.size >= this.cfg.caps.maxSessions) return false;
    return (this.ips.get(ipKey)?.conns ?? 0) < this.cfg.caps.maxConnectionsPerIp;
  }

  /** Returns false when the connection must be refused (caps reached). */
  onConnect(connId: ConnId, ipKey: string): boolean {
    const now = this.clock.now();
    if (!this.canAccept(ipKey)) return false;
    const ip = this.ipState(ipKey, now);
    ip.conns++;
    this.conns.set(connId, {
      id: connId,
      ipKey,
      sessionId: null,
      openedAt: now,
      lastSeen: now,
      frames: new TokenBucket(this.cfg.rates.framesPerConnection, now),
    });
    return true;
  }

  /** A protocol-level pong. Browsers answer pings without running JS, so this keeps
   *  throttled background tabs alive where the app-level `ping` can't. */
  touch(connId: ConnId): void {
    const conn = this.conns.get(connId);
    if (conn) conn.lastSeen = this.clock.now();
  }

  onDisconnect(connId: ConnId): void {
    const conn = this.conns.get(connId);
    if (!conn) return;
    this.forgetConn(conn);
    const s = conn.sessionId ? this.sessions.get(conn.sessionId) : undefined;
    if (s && s.connId === connId) this.goAway(s);
  }

  onFrame(connId: ConnId, raw: string): void {
    const conn = this.conns.get(connId);
    if (!conn) return;
    const now = this.clock.now();
    conn.lastSeen = now;
    if (!conn.frames.take(now)) return this.violation(conn, CloseCode.rateLimited);

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return this.violation(conn, CloseCode.protocol);
    }
    const parsed = clientFrameSchema.safeParse(json);
    if (!parsed.success) return this.violation(conn, CloseCode.protocol);
    const frame = parsed.data;

    if (frame.type === 'ping') return this.transport.send(connId, { type: 'pong' });

    if (!conn.sessionId) {
      if (frame.type !== 'hello') return this.violation(conn, CloseCode.protocol);
      return this.hello(conn, frame, now);
    }
    const s = this.sessions.get(conn.sessionId);
    if (!s) return this.violation(conn, CloseCode.protocol);

    switch (frame.type) {
      case 'hello':
        return this.violation(conn, CloseCode.protocol);
      case 'claim':
        return this.claim(s, conn, frame.pseudonym, now);
      case 'invite':
        return this.invite(s, conn, frame.to, frame.commit, now);
      case 'invite_cancel':
        return this.cancelInvite(s, frame.inviteId);
      case 'accept':
        return this.accept(s, frame.inviteId, frame.pub, now);
      case 'decline':
        return this.decline(s, frame.inviteId, frame.block ?? false);
      case 'reveal':
        return this.reveal(s, conn, frame.pub);
      case 'relay':
        return this.relay(s, frame.c, now);
      case 'end':
        return this.teardown(s, null, CloseCode.normal, 'peer_end');
    }
  }

  /** Sweeper: expires timers. Called every second by RelayServer, manually in tests. */
  tick(): void {
    const now = this.clock.now();
    const t = this.cfg.timers;

    // Snapshots (Array.from) because teardown removes entries while we iterate.
    for (const conn of Array.from(this.conns.values())) {
      if (!conn.sessionId && now - conn.openedAt >= t.helloTimeoutMs) {
        this.transport.close(conn.id, CloseCode.expired);
        this.forgetConn(conn);
      } else if (now - conn.lastSeen >= t.silentSocketMs) {
        this.transport.close(conn.id, CloseCode.expired);
        this.onDisconnect(conn.id);
      }
    }

    for (const inv of Array.from(this.invites.values())) {
      if (now >= inv.expiresAt) this.dropInvite(inv, 'invite_expired');
    }

    for (const s of Array.from(this.sessions.values())) {
      if (!this.sessions.has(s.id)) continue; // already torn down as someone's peer
      if (s.graceUntil !== null && now >= s.graceUntil) {
        this.teardown(s, null, CloseCode.normal, 'peer_lost');
      } else if (now >= s.expiresAt) {
        const reason: EndReason = s.state === 'paired' ? 'idle' : 'expired';
        this.teardown(s, reason, CloseCode.expired, reason);
      }
    }

    for (const [key, ip] of this.ips) {
      if (ip.conns === 0 && now - ip.lastUsed > IP_STATE_IDLE_MS) this.ips.delete(key);
    }
  }

  /** Ends every conversation; called on SIGTERM (deploys). */
  shutdown(): void {
    for (const s of this.sessions.values()) {
      if (!s.connId) continue;
      this.transport.send(s.connId, { type: 'ended', reason: 'server_restart' });
      this.transport.close(s.connId, CloseCode.serverRestart);
    }
    for (const conn of this.conns.values()) {
      if (!conn.sessionId) this.transport.close(conn.id, CloseCode.serverRestart);
    }
    this.conns.clear();
    this.sessions.clear();
    this.byToken.clear();
    this.byPseudonym.clear();
    this.invites.clear();
    this.pairs.clear();
    this.ips.clear();
  }

  // ── Frame handlers ──────────────────────────────────────────────────────

  private hello(conn: Conn, frame: Extract<ClientFrame, { type: 'hello' }>, now: number): void {
    if (frame.resume) {
      const sid = this.byToken.get(sha256(frame.resume));
      const s = sid ? this.sessions.get(sid) : undefined;
      if (!s) {
        this.transport.send(conn.id, { type: 'resume_failed' });
        this.transport.close(conn.id, CloseCode.expired);
        this.forgetConn(conn);
        return;
      }
      if (s.connId) {
        const old = this.conns.get(s.connId);
        this.transport.close(s.connId, CloseCode.replaced);
        if (old) this.forgetConn(old);
      }
      const wasAway = s.graceUntil !== null;
      s.connId = conn.id;
      s.graceUntil = null;
      conn.sessionId = s.id;
      const peer = this.peerOf(s);
      this.transport.send(conn.id, {
        type: 'resumed',
        resumeToken: this.issueToken(s),
        state: s.state,
        pseudonym: s.pseudonym,
        peer: peer?.pseudonym ?? null,
        pairId: s.pairId,
      });
      if (wasAway && peer) this.send(peer, { type: 'peer_back' });
      return;
    }

    if (this.sessions.size >= this.cfg.caps.maxSessions) {
      return this.violation(conn, CloseCode.rateLimited);
    }
    const s: Session = {
      id: randomId(),
      connId: conn.id,
      tokenHash: '',
      pseudonym: null,
      state: 'connected',
      inviteId: null,
      pairId: null,
      blocked: new Set(),
      expiresAt: now + this.cfg.timers.connectedTtlMs,
      graceUntil: null,
      relay: new TokenBucket(this.cfg.rates.relayPerSession, now),
      invites: new TokenBucket(this.cfg.rates.invitesPerSession, now),
    };
    this.sessions.set(s.id, s);
    conn.sessionId = s.id;
    this.transport.send(conn.id, { type: 'welcome', resumeToken: this.issueToken(s), limits: this.limits() });
  }

  private claim(s: Session, conn: Conn, input: string, now: number): void {
    if (s.state !== 'connected') return this.error(s, 'busy');
    const name = normalizePseudonym(input);
    if (!isValidPseudonym(name)) return this.error(s, 'invalid_name');
    if (!this.ipState(conn.ipKey, now).claims.take(now)) return this.error(s, 'rate_limited');
    if (this.byPseudonym.has(name)) return this.error(s, 'name_taken');

    this.byPseudonym.set(name, s.id);
    s.pseudonym = name;
    s.state = 'claimed';
    s.expiresAt = now + this.cfg.timers.lobbyTtlMs;
    this.send(s, { type: 'claimed', pseudonym: name, expiresAt: s.expiresAt });
  }

  private invite(s: Session, conn: Conn, toInput: string, commit: string, now: number): void {
    if (s.state !== 'claimed' || !s.pseudonym) return this.error(s, 'busy');
    if (!s.invites.take(now) || !this.ipState(conn.ipKey, now).invites.take(now)) {
      return this.error(s, 'rate_limited');
    }
    const targetId = this.byPseudonym.get(normalizePseudonym(toInput));
    const target = targetId ? this.sessions.get(targetId) : undefined;
    // Busy, blocked, away, self, and nonexistent all look the same to the sender.
    if (
      !target ||
      target === s ||
      target.state !== 'claimed' ||
      target.connId === null ||
      target.blocked.has(s.pseudonym)
    ) {
      return this.error(s, 'unavailable');
    }

    const inv: Invite = { id: randomId(), from: s.id, to: target.id, expiresAt: now + this.cfg.timers.inviteTtlMs };
    this.invites.set(inv.id, inv);
    s.state = 'inviting';
    s.inviteId = inv.id;
    target.state = 'invited';
    target.inviteId = inv.id;
    this.send(s, { type: 'invite_sent', inviteId: inv.id, expiresAt: inv.expiresAt });
    this.send(target, { type: 'invite_in', inviteId: inv.id, from: s.pseudonym, commit, expiresAt: inv.expiresAt });
  }

  private cancelInvite(s: Session, inviteId: string): void {
    const inv = this.invites.get(inviteId);
    if (!inv || inv.from !== s.id) return this.error(s, 'expired');
    this.dropInvite(inv, 'invite_cancelled');
  }

  private decline(s: Session, inviteId: string, block: boolean): void {
    const inv = this.invites.get(inviteId);
    if (!inv || inv.to !== s.id) return this.error(s, 'expired');
    const from = this.sessions.get(inv.from);
    if (block && from?.pseudonym) s.blocked.add(from.pseudonym);
    this.dropInvite(inv, 'invite_declined');
  }

  private accept(s: Session, inviteId: string, pub: string, now: number): void {
    const inv = this.invites.get(inviteId);
    if (!inv || inv.to !== s.id) return this.error(s, 'expired');
    const initiator = this.sessions.get(inv.from);
    // The initiator must be connected to receive `paired`; the invitee may retry until expiry.
    if (!initiator || initiator.connId === null) return this.error(s, 'unavailable');

    this.invites.delete(inv.id);
    const pair: Pair = { id: randomId(), initiator: initiator.id, invitee: s.id, revealed: false };
    this.pairs.set(pair.id, pair);
    for (const member of [initiator, s]) {
      member.state = 'paired';
      member.inviteId = null;
      member.pairId = pair.id;
      member.expiresAt = now + this.cfg.timers.pairedIdleMs;
    }
    this.send(initiator, { type: 'paired', pairId: pair.id, peer: s.pseudonym!, pub });
    this.send(s, { type: 'paired', pairId: pair.id, peer: initiator.pseudonym! });
  }

  private reveal(s: Session, conn: Conn, pub: string): void {
    const pair = s.pairId ? this.pairs.get(s.pairId) : undefined;
    if (!pair) return this.error(s, 'not_paired');
    // Only the initiator reveals. Repeats are forwarded again (the initiator re-sends after a
    // reconnect because it can't know whether the first one arrived); the invitee ignores duplicates.
    if (pair.initiator !== s.id) return this.violation(conn, CloseCode.protocol);
    const invitee = this.sessions.get(pair.invitee);
    if (!invitee?.connId) return this.send(s, { type: 'undeliverable' });
    pair.revealed = true;
    this.send(invitee, { type: 'peer_reveal', pub });
  }

  private relay(s: Session, c: string, now: number): void {
    const pair = s.pairId ? this.pairs.get(s.pairId) : undefined;
    if (!pair) return this.error(s, 'not_paired');
    if (!pair.revealed) {
      const conn = s.connId ? this.conns.get(s.connId) : undefined;
      if (conn) this.violation(conn, CloseCode.protocol);
      return;
    }
    if (!s.relay.take(now)) return this.error(s, 'rate_limited');
    const peer = this.peerOf(s);
    if (!peer?.connId) return this.send(s, { type: 'undeliverable' });
    this.send(peer, { type: 'frame', c });
    s.expiresAt = peer.expiresAt = now + this.cfg.timers.pairedIdleMs;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private send(s: Session, frame: ServerFrame): void {
    if (s.connId) this.transport.send(s.connId, frame);
  }

  private error(s: Session, code: ErrorCode): void {
    this.send(s, { type: 'error', code });
  }

  private violation(conn: Conn, code: CloseCode): void {
    const s = conn.sessionId ? this.sessions.get(conn.sessionId) : undefined;
    this.log.warn('violation', { code });
    if (s) {
      this.teardown(s, null, code, 'peer_lost');
    } else {
      this.transport.close(conn.id, code);
      this.forgetConn(conn);
    }
  }

  private goAway(s: Session): void {
    s.connId = null;
    s.graceUntil = this.clock.now() + this.cfg.timers.graceMs;
    const peer = this.peerOf(s);
    if (peer) this.send(peer, { type: 'peer_away', graceUntil: s.graceUntil });
  }

  private peerOf(s: Session): Session | undefined {
    const pair = s.pairId ? this.pairs.get(s.pairId) : undefined;
    if (!pair) return undefined;
    return this.sessions.get(pair.initiator === s.id ? pair.invitee : pair.initiator);
  }

  private issueToken(s: Session): string {
    if (s.tokenHash) this.byToken.delete(s.tokenHash);
    const token = randomId(32);
    s.tokenHash = sha256(token);
    this.byToken.set(s.tokenHash, s.id);
    return token;
  }

  private dropInvite(
    inv: Invite,
    notify: 'invite_cancelled' | 'invite_declined' | 'invite_expired',
    skipSessionId?: string,
  ): void {
    this.invites.delete(inv.id);
    for (const sid of [inv.from, inv.to]) {
      const member = this.sessions.get(sid);
      if (!member || member.inviteId !== inv.id) continue;
      member.inviteId = null;
      if (member.state === 'inviting' || member.state === 'invited') member.state = 'claimed';
      if (sid !== skipSessionId) this.send(member, { type: notify, inviteId: inv.id });
    }
  }

  /** Ends a session and, if paired, its peer. Nothing about either survives. */
  private teardown(s: Session, selfReason: EndReason | null, selfCode: CloseCode, peerReason: EndReason): void {
    if (s.inviteId) {
      const inv = this.invites.get(s.inviteId);
      if (inv) this.dropInvite(inv, 'invite_cancelled', s.id);
    }
    const pair = s.pairId ? this.pairs.get(s.pairId) : undefined;
    if (pair) {
      this.pairs.delete(pair.id);
      const peer = this.sessions.get(pair.initiator === s.id ? pair.invitee : pair.initiator);
      if (peer) this.destroy(peer, peerReason, closeCodeFor(peerReason));
    }
    this.destroy(s, selfReason, selfCode);
  }

  private destroy(s: Session, reason: EndReason | null, code: CloseCode): void {
    this.sessions.delete(s.id);
    this.byToken.delete(s.tokenHash);
    if (s.pseudonym && this.byPseudonym.get(s.pseudonym) === s.id) this.byPseudonym.delete(s.pseudonym);
    if (s.connId) {
      const conn = this.conns.get(s.connId);
      if (reason) this.transport.send(s.connId, { type: 'ended', reason });
      this.transport.close(s.connId, code);
      if (conn) this.forgetConn(conn);
    }
    s.connId = null;
    s.pairId = null;
    s.inviteId = null;
  }

  private forgetConn(conn: Conn): void {
    if (!this.conns.delete(conn.id)) return;
    const ip = this.ips.get(conn.ipKey);
    if (ip) ip.conns = Math.max(0, ip.conns - 1);
  }

  private ipState(ipKey: string, now: number): IpState {
    let ip = this.ips.get(ipKey);
    if (!ip) {
      ip = {
        conns: 0,
        claims: new TokenBucket(this.cfg.rates.claimsPerIp, now),
        invites: new TokenBucket(this.cfg.rates.invitesPerIp, now),
        lastUsed: now,
      };
      this.ips.set(ipKey, ip);
    }
    ip.lastUsed = now;
    return ip;
  }
}
