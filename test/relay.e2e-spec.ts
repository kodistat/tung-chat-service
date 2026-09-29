import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.factory.js';
import { silentLogger } from '../src/common/logger.js';
import { loadConfig } from '../src/config.js';
import type { ServerFrame } from '../src/protocol/frames.js';

const ORIGIN = 'http://tung.test';
const key = () => randomBytes(32).toString('base64url');

class Client {
  readonly ws: WebSocket;
  private readonly inbox: ServerFrame[] = [];
  private waiters: Array<() => void> = [];
  closeCode: Promise<number>;
  token = '';

  constructor(url: string, origin = ORIGIN) {
    this.ws = new WebSocket(url, { origin });
    this.ws.on('message', (data) => {
      this.inbox.push(JSON.parse(String(data)) as ServerFrame);
      for (const w of this.waiters.splice(0)) w();
    });
    this.closeCode = new Promise((resolve) => this.ws.on('close', (code) => resolve(code)));
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  send(frame: object | string | Buffer) {
    this.ws.send(typeof frame === 'object' && !Buffer.isBuffer(frame) ? JSON.stringify(frame) : frame);
  }

  /** Resolves with the next frame of this type, consuming frames before it. */
  async next<T extends ServerFrame['type']>(type: T, timeoutMs = 3000): Promise<Extract<ServerFrame, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.inbox.findIndex((f) => f.type === type);
      if (i >= 0) return this.inbox.splice(0, i + 1).at(-1) as Extract<ServerFrame, { type: T }>;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${type}; inbox: ${JSON.stringify(this.inbox)}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  async hello(resume?: string) {
    this.send({ type: 'hello', v: 1, ...(resume ? { resume } : {}) });
    const f = resume ? await this.next('resumed') : await this.next('welcome');
    this.token = f.resumeToken;
    return this;
  }
}

describe('relay (e2e)', () => {
  let app: INestApplication;
  let base: string;
  let wsUrl: string;
  const clients: Client[] = [];

  const connect = async (origin?: string) => {
    const c = new Client(wsUrl, origin);
    clients.push(c);
    await c.opened();
    return c;
  };

  beforeEach(async () => {
    const config = loadConfig({ ALLOWED_ORIGINS: ORIGIN, LOG_LEVEL: 'silent' });
    app = await createApp(config, silentLogger);
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    wsUrl = `ws://127.0.0.1:${port}/ws`;
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.ws.terminate();
    await app.close();
  });

  it('serves a health check without counts', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
  });

  it('refuses other origins and other paths', async () => {
    await expect(connect('https://evil.example')).rejects.toThrow(/403/);
    const wrongPath = new WebSocket(wsUrl.replace('/ws', '/other'), { origin: ORIGIN });
    await expect(
      new Promise((resolve, reject) => {
        wrongPath.once('open', resolve);
        wrongPath.once('error', reject);
      }),
    ).rejects.toThrow();
  });

  it('runs a whole conversation: claim, invite, accept, reveal, relay, end', async () => {
    const a = await (await connect()).hello();
    const b = await (await connect()).hello();
    a.send({ type: 'claim', pseudonym: 'Alice' });
    b.send({ type: 'claim', pseudonym: 'bob' });
    await a.next('claimed');
    await b.next('claimed');

    const pkA = key();
    const pkB = key();
    const commit = key();
    a.send({ type: 'invite', to: 'bob', commit });
    const invite = await b.next('invite_in');
    expect(invite).toMatchObject({ from: 'alice', commit });

    b.send({ type: 'accept', inviteId: invite.inviteId, pub: pkB });
    expect(await a.next('paired')).toMatchObject({ peer: 'bob', pub: pkB });
    expect((await b.next('paired')).pub).toBeUndefined();

    a.send({ type: 'reveal', pub: pkA });
    expect((await b.next('peer_reveal')).pub).toBe(pkA);

    a.send({ type: 'relay', c: 'Y2lwaGVydGV4dC1h' });
    b.send({ type: 'relay', c: 'Y2lwaGVydGV4dC1i' });
    expect((await b.next('frame')).c).toBe('Y2lwaGVydGV4dC1h');
    expect((await a.next('frame')).c).toBe('Y2lwaGVydGV4dC1i');

    b.send({ type: 'end' });
    expect((await a.next('ended')).reason).toBe('peer_end');
    expect(await a.closeCode).toBe(4000);
    expect(await b.closeCode).toBe(4000);
  });

  it('survives a dropped socket via resume', async () => {
    const a = await (await connect()).hello();
    const b = await (await connect()).hello();
    a.send({ type: 'claim', pseudonym: 'alice' });
    b.send({ type: 'claim', pseudonym: 'bob' });
    await a.next('claimed');
    await b.next('claimed');
    a.send({ type: 'invite', to: 'bob', commit: key() });
    const invite = await b.next('invite_in');
    b.send({ type: 'accept', inviteId: invite.inviteId, pub: key() });
    await a.next('paired');
    a.send({ type: 'reveal', pub: key() });
    await b.next('peer_reveal');

    b.ws.terminate();
    await a.next('peer_away');
    a.send({ type: 'relay', c: 'QUFBQQ' });
    await a.next('undeliverable');

    const b2 = await (await connect()).hello(b.token);
    await a.next('peer_back');
    a.send({ type: 'relay', c: 'QkJCQg' });
    expect((await b2.next('frame')).c).toBe('QkJCQg');
  });

  it('keeps a socket that answers protocol pings but sends nothing', async () => {
    await app.close();
    app = await createApp(
      loadConfig({ ALLOWED_ORIGINS: ORIGIN, LOG_LEVEL: 'silent', PING_INTERVAL_MS: '200', SILENT_SOCKET_MS: '1000' }),
      silentLogger,
    );
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    wsUrl = `ws://127.0.0.1:${port}/ws`;
    const a = await (await connect()).hello(); // `ws` answers pings automatically, like browsers
    await new Promise((r) => setTimeout(r, 2500));
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('closes on binary frames and on oversized frames', async () => {
    const a = await (await connect()).hello();
    a.send(Buffer.from([1, 2, 3]));
    expect(await a.closeCode).toBe(4001);

    const b = await (await connect()).hello();
    b.send('x'.repeat(13 * 1024));
    expect(await b.closeCode).toBe(1009);
  });

  it('ends conversations with server_restart on shutdown', async () => {
    const a = await (await connect()).hello();
    a.send({ type: 'claim', pseudonym: 'alice' });
    await a.next('claimed');
    const closed = a.closeCode;
    const ended = a.next('ended');
    await app.close();
    expect((await ended).reason).toBe('server_restart');
    expect(await closed).toBe(4005);
    // afterEach closes again; make that a no-op.
    app = { close: async () => {} } as unknown as INestApplication;
  });
});
