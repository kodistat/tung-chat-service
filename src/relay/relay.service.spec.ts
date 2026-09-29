import { randomBytes } from 'node:crypto';
import { loadConfig } from '../config.js';
import { silentLogger } from '../common/logger.js';
import { CloseCode, type ServerFrame } from '../protocol/frames.js';
import { type ConnId, RelayService } from './relay.service.js';

const key = () => randomBytes(32).toString('base64url');

class Harness {
  now = 1_000_000;
  readonly cfg = loadConfig({});
  readonly sent = new Map<ConnId, ServerFrame[]>();
  readonly closed = new Map<ConnId, number>();
  readonly relay = new RelayService(this.cfg, { now: () => this.now }, silentLogger);
  private seq = 0;

  constructor() {
    this.relay.attach({
      send: (id, f) => this.sent.set(id, [...(this.sent.get(id) ?? []), f]),
      close: (id, code) => this.closed.set(id, code),
    });
  }

  connect(ip = '1.1.1.1'): Client {
    const id = `c${++this.seq}`;
    expect(this.relay.onConnect(id, ip)).toBe(true);
    return new Client(this, id);
  }

  advance(ms: number) {
    this.now += ms;
    this.relay.tick();
  }

  /** Lets `ms` pass in 20 s steps while the given clients keep pinging, like real ones do. */
  pass(ms: number, ...alive: Client[]) {
    for (let left = ms; left > 0; left -= 20_000) {
      for (const c of alive) c.send({ type: 'ping' });
      this.advance(Math.min(20_000, left));
    }
  }
}

class Client {
  token = '';
  constructor(
    private readonly h: Harness,
    readonly id: ConnId,
  ) {}

  send(frame: object | string) {
    this.h.relay.onFrame(this.id, typeof frame === 'string' ? frame : JSON.stringify(frame));
  }

  frames(): ServerFrame[] {
    return this.h.sent.get(this.id) ?? [];
  }

  last(): ServerFrame | undefined {
    return this.frames().at(-1);
  }

  of<T extends ServerFrame['type']>(type: T): Extract<ServerFrame, { type: T }>[] {
    return this.frames().filter((f) => f.type === type) as Extract<ServerFrame, { type: T }>[];
  }

  closedWith(): number | undefined {
    return this.h.closed.get(this.id);
  }

  hello(resume?: string) {
    this.send({ type: 'hello', v: 1, ...(resume ? { resume } : {}) });
    const f = this.last();
    if (f?.type === 'welcome' || f?.type === 'resumed') this.token = f.resumeToken;
    return this;
  }

  claim(pseudonym: string) {
    this.send({ type: 'claim', pseudonym });
    return this;
  }

  disconnect() {
    this.h.relay.onDisconnect(this.id);
  }
}

/** Two claimed clients, `a` invited `b`, `b` accepted, `a` revealed. */
function pairUp(h: Harness) {
  const a = h.connect('1.1.1.1').hello().claim('alice');
  const b = h.connect('2.2.2.2').hello().claim('bob');
  const pkA = key();
  const pkB = key();
  a.send({ type: 'invite', to: 'bob', commit: key() });
  const inviteId = b.of('invite_in')[0]!.inviteId;
  b.send({ type: 'accept', inviteId, pub: pkB });
  a.send({ type: 'reveal', pub: pkA });
  return { a, b, pkA, pkB, inviteId };
}

describe('RelayService', () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
  });

  describe('hello and claim', () => {
    it('welcomes with a resume token and limits', () => {
      const a = h.connect().hello();
      const w = a.of('welcome')[0]!;
      expect(w.resumeToken).toHaveLength(43);
      expect(w.limits.graceMs).toBe(45_000);
    });

    it('answers ping with pong', () => {
      const a = h.connect();
      a.send({ type: 'ping' });
      expect(a.last()).toEqual({ type: 'pong' });
    });

    it('closes when the first frame is not hello', () => {
      const a = h.connect();
      a.claim('alice');
      expect(a.closedWith()).toBe(CloseCode.protocol);
    });

    it('closes on malformed JSON, unknown types, and extra fields', () => {
      for (const bad of ['nope', { type: 'shout' }, { type: 'hello', v: 1, extra: true }]) {
        const c = h.connect();
        c.send(bad);
        expect(c.closedWith()).toBe(CloseCode.protocol);
      }
    });

    it('closes a connection that never says hello', () => {
      const a = h.connect();
      h.advance(10_000);
      expect(a.closedWith()).toBe(CloseCode.expired);
      expect(h.relay.stats().connections).toBe(0);
    });

    it('normalizes and claims a pseudonym', () => {
      const a = h.connect().hello().claim('  Quiet-Heron ');
      expect(a.last()).toMatchObject({ type: 'claimed', pseudonym: 'quiet-heron' });
    });

    it('rejects invalid names and taken names', () => {
      const a = h.connect().hello().claim('no spaces');
      expect(a.last()).toEqual({ type: 'error', code: 'invalid_name' });
      a.claim('ab');
      expect(a.last()).toEqual({ type: 'error', code: 'invalid_name' });
      a.claim('alice');
      const b = h.connect('9.9.9.9').hello().claim('ALICE');
      expect(b.last()).toEqual({ type: 'error', code: 'name_taken' });
    });

    it('allows only one claim per session', () => {
      const a = h.connect().hello().claim('alice').claim('alice2');
      expect(a.last()).toEqual({ type: 'error', code: 'busy' });
    });

    it('rate-limits claims per IP', () => {
      for (let i = 0; i < 20; i++) {
        const c = h.connect('5.5.5.5').hello().claim(`name-${i}`);
        expect(c.last()?.type).toBe('claimed');
        c.send({ type: 'end' }); // frees the connection slot, not the claim budget
      }
      const c = h.connect('5.5.5.5').hello().claim('one-more');
      expect(c.last()).toEqual({ type: 'error', code: 'rate_limited' });
      const other = h.connect('6.6.6.6').hello().claim('one-more');
      expect(other.last()?.type).toBe('claimed');
    });

    it('expires an idle lobby and releases the name', () => {
      const a = h.connect().hello().claim('alice');
      h.pass(29 * 60_000, a);
      expect(a.of('ended')).toEqual([]);
      h.pass(60_000, a);
      expect(a.of('ended')).toEqual([{ type: 'ended', reason: 'expired' }]);
      const b = h.connect('2.2.2.2').hello().claim('alice');
      expect(b.last()?.type).toBe('claimed');
    });
  });

  describe('invitations', () => {
    it('delivers an invite and the commitment', () => {
      const a = h.connect().hello().claim('alice');
      const b = h.connect('2.2.2.2').hello().claim('bob');
      const commit = key();
      a.send({ type: 'invite', to: ' BOB ', commit });
      const sent = a.of('invite_sent')[0]!;
      expect(b.of('invite_in')[0]).toMatchObject({ inviteId: sent.inviteId, from: 'alice', commit });
    });

    it('returns the same `unavailable` for missing, self, busy, and away targets', () => {
      const a = h.connect().hello().claim('alice');
      const b = h.connect('2.2.2.2').hello().claim('bob');
      const c = h.connect('3.3.3.3').hello().claim('carol');
      const d = h.connect('4.4.4.4').hello().claim('dave');

      a.send({ type: 'invite', to: 'nobody', commit: key() });
      expect(a.last()).toEqual({ type: 'error', code: 'unavailable' });
      a.send({ type: 'invite', to: 'alice', commit: key() });
      expect(a.last()).toEqual({ type: 'error', code: 'unavailable' });

      c.send({ type: 'invite', to: 'bob', commit: key() }); // bob now busy
      a.send({ type: 'invite', to: 'bob', commit: key() });
      expect(a.last()).toEqual({ type: 'error', code: 'unavailable' });

      d.disconnect(); // dave in grace
      a.send({ type: 'invite', to: 'dave', commit: key() });
      expect(a.last()).toEqual({ type: 'error', code: 'unavailable' });
      expect(b.of('invite_in')).toHaveLength(1);
    });

    it('allows one pending invite at a time', () => {
      const a = h.connect().hello().claim('alice');
      h.connect('2.2.2.2').hello().claim('bob');
      h.connect('3.3.3.3').hello().claim('carol');
      a.send({ type: 'invite', to: 'bob', commit: key() });
      a.send({ type: 'invite', to: 'carol', commit: key() });
      expect(a.last()).toEqual({ type: 'error', code: 'busy' });
    });

    it('decline notifies the sender, block stops further invites', () => {
      const a = h.connect().hello().claim('alice');
      const b = h.connect('2.2.2.2').hello().claim('bob');
      a.send({ type: 'invite', to: 'bob', commit: key() });
      const inviteId = b.of('invite_in')[0]!.inviteId;
      b.send({ type: 'decline', inviteId, block: true });
      expect(a.last()).toEqual({ type: 'invite_declined', inviteId });
      a.send({ type: 'invite', to: 'bob', commit: key() });
      expect(a.last()).toEqual({ type: 'error', code: 'unavailable' });
    });

    it('cancel notifies both sides and frees them', () => {
      const a = h.connect().hello().claim('alice');
      const b = h.connect('2.2.2.2').hello().claim('bob');
      a.send({ type: 'invite', to: 'bob', commit: key() });
      const inviteId = a.of('invite_sent')[0]!.inviteId;
      a.send({ type: 'invite_cancel', inviteId });
      expect(b.last()).toEqual({ type: 'invite_cancelled', inviteId });
      b.send({ type: 'invite', to: 'alice', commit: key() });
      expect(b.last()?.type).toBe('invite_sent');
    });

    it('expires after two minutes and both return to the lobby', () => {
      const a = h.connect().hello().claim('alice');
      const b = h.connect('2.2.2.2').hello().claim('bob');
      a.send({ type: 'invite', to: 'bob', commit: key() });
      h.pass(119_000, a, b);
      expect(a.of('invite_expired')).toHaveLength(0);
      h.pass(1_000, a, b);
      expect(a.of('invite_expired')).toHaveLength(1);
      expect(b.of('invite_expired')).toHaveLength(1);
      a.send({ type: 'invite', to: 'bob', commit: key() });
      expect(a.last()?.type).toBe('invite_sent');
    });

    it('only the invitee can accept', () => {
      const a = h.connect().hello().claim('alice');
      h.connect('2.2.2.2').hello().claim('bob');
      a.send({ type: 'invite', to: 'bob', commit: key() });
      const inviteId = a.of('invite_sent')[0]!.inviteId;
      a.send({ type: 'accept', inviteId, pub: key() });
      expect(a.last()).toEqual({ type: 'error', code: 'expired' });
    });

    it('rate-limits invites per session', () => {
      const a = h.connect().hello().claim('alice');
      for (let i = 0; i < 10; i++) a.send({ type: 'invite', to: `ghost-${i}`, commit: key() });
      a.send({ type: 'invite', to: 'ghost-x', commit: key() });
      expect(a.last()).toEqual({ type: 'error', code: 'rate_limited' });
    });
  });

  describe('pairing and relay', () => {
    it('sends the invitee key to the initiator only, then reveals the initiator key', () => {
      const { a, b, pkA, pkB } = pairUp(h);
      const pa = a.of('paired')[0]!;
      const pb = b.of('paired')[0]!;
      expect(pa).toMatchObject({ peer: 'bob', pub: pkB });
      expect(pb.pub).toBeUndefined();
      expect(pb).toMatchObject({ peer: 'alice', pairId: pa.pairId });
      expect(b.of('peer_reveal')).toEqual([{ type: 'peer_reveal', pub: pkA }]);
    });

    it('forwards relay frames opaquely in both directions', () => {
      const { a, b } = pairUp(h);
      a.send({ type: 'relay', c: 'AAAA' });
      b.send({ type: 'relay', c: 'BBBB' });
      expect(b.last()).toEqual({ type: 'frame', c: 'AAAA' });
      expect(a.last()).toEqual({ type: 'frame', c: 'BBBB' });
    });

    it('treats relay before reveal as a violation and ends both sides', () => {
      const a = h.connect().hello().claim('alice');
      const b = h.connect('2.2.2.2').hello().claim('bob');
      a.send({ type: 'invite', to: 'bob', commit: key() });
      b.send({ type: 'accept', inviteId: b.of('invite_in')[0]!.inviteId, pub: key() });
      b.send({ type: 'relay', c: 'AAAA' });
      expect(b.closedWith()).toBe(CloseCode.protocol);
      expect(a.last()).toEqual({ type: 'ended', reason: 'peer_lost' });
    });

    it('only the initiator may reveal; repeats are forwarded again', () => {
      const { a, b, pkA } = pairUp(h);
      a.send({ type: 'reveal', pub: pkA });
      expect(a.closedWith()).toBeUndefined();
      expect(b.of('peer_reveal')).toHaveLength(2);

      const h2 = new Harness();
      const x = h2.connect().hello().claim('alice');
      const y = h2.connect('2.2.2.2').hello().claim('bob');
      x.send({ type: 'invite', to: 'bob', commit: key() });
      y.send({ type: 'accept', inviteId: y.of('invite_in')[0]!.inviteId, pub: key() });
      y.send({ type: 'reveal', pub: key() });
      expect(y.closedWith()).toBe(CloseCode.protocol);
    });

    it('end tears down both sides and releases both names', () => {
      const { a, b } = pairUp(h);
      a.send({ type: 'end' });
      expect(a.closedWith()).toBe(CloseCode.normal);
      expect(b.last()).toEqual({ type: 'ended', reason: 'peer_end' });
      expect(h.relay.stats()).toEqual({ connections: 0, sessions: 0, pairs: 0 });
      const c = h.connect('3.3.3.3').hello().claim('alice');
      expect(c.last()?.type).toBe('claimed');
    });

    it('ends an idle pair after 30 minutes without relay traffic', () => {
      const { a, b } = pairUp(h);
      h.pass(29 * 60_000, a, b);
      expect(a.of('ended')).toEqual([]);
      h.pass(60_000, a, b);
      expect(a.last()).toEqual({ type: 'ended', reason: 'idle' });
      expect(b.last()).toEqual({ type: 'ended', reason: 'idle' });
    });

    it('rate-limits relay frames per session', () => {
      const { a, b } = pairUp(h);
      for (let i = 0; i < 20; i++) a.send({ type: 'relay', c: 'AAAA' });
      expect(b.of('frame')).toHaveLength(20);
      a.send({ type: 'relay', c: 'AAAA' });
      // The per-connection flood bucket (40) is not reached; the relay bucket (20) is.
      expect(a.last()).toEqual({ type: 'error', code: 'rate_limited' });
    });
  });

  describe('reconnection', () => {
    it('tells the peer, resumes with a rotated token, and tells the peer again', () => {
      const { a, b } = pairUp(h);
      const oldToken = b.token;
      b.disconnect();
      expect(a.last()).toMatchObject({ type: 'peer_away' });

      a.send({ type: 'relay', c: 'AAAA' });
      expect(a.last()).toEqual({ type: 'undeliverable' });

      const b2 = h.connect('2.2.2.2').hello(oldToken);
      expect(b2.of('resumed')[0]).toMatchObject({ state: 'paired', pseudonym: 'bob', peer: 'alice' });
      expect(b2.token).not.toBe(oldToken);
      expect(a.last()).toEqual({ type: 'peer_back' });

      a.send({ type: 'relay', c: 'CCCC' });
      expect(b2.last()).toEqual({ type: 'frame', c: 'CCCC' });

      const stale = h.connect('2.2.2.2');
      stale.hello(oldToken);
      expect(stale.of('resume_failed')).toHaveLength(1);
    });

    it('ends the conversation when grace runs out', () => {
      const { a, b } = pairUp(h);
      b.disconnect();
      h.advance(20_000);
      a.send({ type: 'ping' });
      h.advance(25_000);
      expect(a.last()).toEqual({ type: 'ended', reason: 'peer_lost' });
      expect(h.relay.stats().sessions).toBe(0);
    });

    it('a resume from a second socket replaces the first', () => {
      const a = h.connect().hello().claim('alice');
      const a2 = h.connect().hello(a.token);
      expect(a.closedWith()).toBe(CloseCode.replaced);
      expect(a2.of('resumed')[0]).toMatchObject({ state: 'claimed', pseudonym: 'alice' });
    });

    it('reveal to an away invitee is undeliverable and can be retried', () => {
      const a = h.connect().hello().claim('alice');
      const b = h.connect('2.2.2.2').hello().claim('bob');
      a.send({ type: 'invite', to: 'bob', commit: key() });
      b.send({ type: 'accept', inviteId: b.of('invite_in')[0]!.inviteId, pub: key() });
      b.disconnect();
      const pkA = key();
      a.send({ type: 'reveal', pub: pkA });
      expect(a.last()).toEqual({ type: 'undeliverable' });
      const b2 = h.connect('2.2.2.2').hello(b.token);
      a.send({ type: 'reveal', pub: pkA });
      expect(b2.last()).toEqual({ type: 'peer_reveal', pub: pkA });
    });

    it('protocol-level pongs keep a socket alive without app pings', () => {
      const { a, b } = pairUp(h);
      for (let i = 0; i < 6; i++) {
        h.relay.touch(b.id);
        a.send({ type: 'ping' });
        h.advance(20_000);
      }
      expect(b.closedWith()).toBeUndefined();
      expect(a.of('peer_away')).toHaveLength(0);
    });

    it('drops silent sockets into grace', () => {
      const { a, b } = pairUp(h);
      a.send({ type: 'ping' });
      h.advance(30_000);
      a.send({ type: 'ping' });
      h.advance(30_000);
      expect(b.closedWith()).toBe(CloseCode.expired);
      expect(a.last()).toMatchObject({ type: 'peer_away' });
    });
  });

  describe('caps and shutdown', () => {
    it('caps concurrent connections per IP', () => {
      for (let i = 0; i < 20; i++) h.connect('8.8.8.8');
      expect(h.relay.onConnect('one-too-many', '8.8.8.8')).toBe(false);
    });

    it('closes flooding connections', () => {
      const a = h.connect().hello();
      for (let i = 0; i < 50; i++) a.send({ type: 'ping' });
      expect(a.closedWith()).toBe(CloseCode.rateLimited);
    });

    it('ends everything with server_restart on shutdown', () => {
      const { a, b } = pairUp(h);
      h.relay.shutdown();
      for (const c of [a, b]) {
        expect(c.last()).toEqual({ type: 'ended', reason: 'server_restart' });
        expect(c.closedWith()).toBe(CloseCode.serverRestart);
      }
      expect(h.relay.stats()).toEqual({ connections: 0, sessions: 0, pairs: 0 });
    });
  });
});
