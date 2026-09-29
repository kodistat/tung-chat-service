import { z } from 'zod';

const MINUTE = 60_000;

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:5180,http://localhost:4173')
    .transform((v) =>
      v
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  TRUSTED_IP_HEADER: z
    .string()
    .optional()
    .transform((v) => (v ? v.trim().toLowerCase() : undefined)),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),

  // Timers (docs/PRODUCT.md §3, docs/PROTOCOL.md §6)
  HELLO_TIMEOUT_MS: z.coerce.number().default(10_000),
  CONNECTED_TTL_MS: z.coerce.number().default(2 * MINUTE),
  LOBBY_TTL_MS: z.coerce.number().default(30 * MINUTE),
  INVITE_TTL_MS: z.coerce.number().default(2 * MINUTE),
  VERIFY_TTL_MS: z.coerce.number().default(10 * MINUTE),
  PAIRED_IDLE_MS: z.coerce.number().default(30 * MINUTE),
  GRACE_MS: z.coerce.number().default(45_000),
  PING_INTERVAL_MS: z.coerce.number().default(20_000),
  SILENT_SOCKET_MS: z.coerce.number().default(60_000),

  // Caps and rate limits
  MAX_SESSIONS: z.coerce.number().default(20_000),
  MAX_CONNECTIONS_PER_IP: z.coerce.number().default(20),
  MAX_MESSAGE_BYTES: z.coerce.number().default(6_000),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = envSchema.parse(env);
  return {
    port: e.PORT,
    allowedOrigins: e.ALLOWED_ORIGINS,
    trustedIpHeader: e.TRUSTED_IP_HEADER,
    logLevel: e.LOG_LEVEL,
    timers: {
      helloTimeoutMs: e.HELLO_TIMEOUT_MS,
      connectedTtlMs: e.CONNECTED_TTL_MS,
      lobbyTtlMs: e.LOBBY_TTL_MS,
      inviteTtlMs: e.INVITE_TTL_MS,
      verifyTtlMs: e.VERIFY_TTL_MS,
      pairedIdleMs: e.PAIRED_IDLE_MS,
      graceMs: e.GRACE_MS,
      pingIntervalMs: e.PING_INTERVAL_MS,
      silentSocketMs: e.SILENT_SOCKET_MS,
    },
    caps: {
      maxSessions: e.MAX_SESSIONS,
      maxConnectionsPerIp: e.MAX_CONNECTIONS_PER_IP,
      maxMessageBytes: e.MAX_MESSAGE_BYTES,
    },
    // Token buckets: capacity and refill per second.
    rates: {
      framesPerConnection: { capacity: 40, perSecond: 10 },
      relayPerSession: { capacity: 20, perSecond: 5 },
      invitesPerSession: { capacity: 10, perSecond: 10 / 600 },
      invitesPerIp: { capacity: 30, perSecond: 30 / 600 },
      claimsPerIp: { capacity: 20, perSecond: 20 / 3600 },
    },
  };
}

export const CONFIG = Symbol('CONFIG');
