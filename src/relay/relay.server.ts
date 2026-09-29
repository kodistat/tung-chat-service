import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { WebSocket, WebSocketServer } from 'ws';
import { CONFIG, type Config } from '../config.js';
import { type EventLogger, LOGGER } from '../common/logger.js';
import { IpKeyer } from '../limits/ip-key.js';
import { CloseCode, MAX_FRAME_BYTES } from '../protocol/frames.js';
import { type ConnId, RelayService } from './relay.service.js';

const WS_PATH = '/ws';
const STATS_INTERVAL_MS = 5 * 60 * 1000;

// Owns the sockets. Attaches a raw `ws` server to Nest's HTTP server, checks the origin
// before upgrading, and hands text frames to RelayService.
@Injectable()
export class RelayServer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private wss?: WebSocketServer;
  private readonly sockets = new Map<ConnId, WebSocket>();
  private readonly keyer = new IpKeyer(Date.now());
  private timers: NodeJS.Timeout[] = [];

  constructor(
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
    @Inject(RelayService) private readonly relay: RelayService,
    @Inject(CONFIG) private readonly cfg: Config,
    @Inject(LOGGER) private readonly log: EventLogger,
  ) {}

  onApplicationBootstrap(): void {
    const server = this.host.httpAdapter.getHttpServer() as Server;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });

    this.relay.attach({
      send: (connId, frame) => {
        const ws = this.sockets.get(connId);
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
      },
      close: (connId, code) => {
        const ws = this.sockets.get(connId);
        this.sockets.delete(connId);
        ws?.close(code);
      },
    });

    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? '').split('?')[0];
      if (path !== WS_PATH) {
        socket.destroy();
        return;
      }
      const origin = req.headers.origin;
      if (!origin || !this.cfg.allowedOrigins.includes(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const ipKey = this.keyer.key(this.clientIp(req), Date.now());
      if (!this.relay.canAccept(ipKey)) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws, ipKey));
    });

    this.timers.push(setInterval(() => this.relay.tick(), 1000));
    this.timers.push(
      setInterval(() => {
        for (const ws of this.sockets.values()) if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, this.cfg.timers.pingIntervalMs),
    );
    this.timers.push(setInterval(() => this.log.info('stats', this.relay.stats()), STATS_INTERVAL_MS));
    for (const t of this.timers) t.unref();
    this.log.info('relay_started', { port: this.cfg.port });
  }

  beforeApplicationShutdown(): void {
    for (const t of this.timers) clearInterval(t);
    this.relay.shutdown();
    this.wss?.close();
    this.log.info('relay_stopped');
  }

  private onSocket(ws: WebSocket, ipKey: string): void {
    const connId = randomBytes(12).toString('base64url');
    if (!this.relay.onConnect(connId, ipKey)) {
      ws.close(CloseCode.rateLimited);
      return;
    }
    this.sockets.set(connId, ws);
    ws.on('message', (data, isBinary) => {
      // Binary frames are not part of the protocol; an empty string fails JSON parsing → 4001.
      this.relay.onFrame(connId, !isBinary && Buffer.isBuffer(data) ? data.toString('utf8') : '');
    });
    ws.on('pong', () => this.relay.touch(connId));
    ws.on('close', () => {
      this.sockets.delete(connId);
      this.relay.onDisconnect(connId);
    });
    ws.on('error', () => {
      // `close` follows; nothing to log that wouldn't be per-user metadata.
    });
  }

  private clientIp(req: IncomingMessage): string {
    const header = this.cfg.trustedIpHeader;
    if (header) {
      const value = req.headers[header];
      const first = (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }
}
