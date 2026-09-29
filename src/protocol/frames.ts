// Outer frames of the tung.chat protocol (docs/PROTOCOL.md §3).
// Source of truth for both repos: tung-chat-app keeps a synced copy of this file.
// Keep it dependency-free apart from zod.
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

export const PSEUDONYM_PATTERN = /^[a-z0-9_-]{3,24}$/;

// Largest padded inner frame is 8192 bytes; + 8-byte counter + 16-byte GCM tag = 8216 bytes,
// which is 10955 base64url characters.
export const RELAY_MAX_CHARS = 11_000;

// Maximum size of a single WebSocket message in bytes. A `relay` frame at RELAY_MAX_CHARS
// plus its JSON envelope must fit.
export const MAX_FRAME_BYTES = 12 * 1024;

export function normalizePseudonym(input: string): string {
  return input.trim().toLowerCase();
}

export function isValidPseudonym(normalized: string): boolean {
  return PSEUDONYM_PATTERN.test(normalized);
}

const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
// 32 raw bytes (X25519 public key, SHA-256 commitment, resume token) → 43 base64url chars.
const bytes32 = b64url.length(43);
const opaqueId = b64url.min(16).max(32);
const pseudonymInput = z.string().min(1).max(64);

export const clientFrameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('hello'), v: z.literal(PROTOCOL_VERSION), resume: bytes32.optional() }),
  z.strictObject({ type: z.literal('claim'), pseudonym: pseudonymInput }),
  z.strictObject({ type: z.literal('invite'), to: pseudonymInput, commit: bytes32 }),
  z.strictObject({ type: z.literal('invite_cancel'), inviteId: opaqueId }),
  z.strictObject({ type: z.literal('accept'), inviteId: opaqueId, pub: bytes32 }),
  z.strictObject({ type: z.literal('decline'), inviteId: opaqueId, block: z.boolean().optional() }),
  z.strictObject({ type: z.literal('reveal'), pub: bytes32 }),
  z.strictObject({ type: z.literal('relay'), c: b64url.max(RELAY_MAX_CHARS) }),
  z.strictObject({ type: z.literal('end') }),
  z.strictObject({ type: z.literal('ping') }),
]);

export type ClientFrame = z.infer<typeof clientFrameSchema>;

export const sessionStateSchema = z.enum(['connected', 'claimed', 'inviting', 'invited', 'paired']);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const endReasonSchema = z.enum(['peer_end', 'peer_lost', 'idle', 'expired', 'server_restart']);
export type EndReason = z.infer<typeof endReasonSchema>;

export const errorCodeSchema = z.enum([
  'invalid_name',
  'name_taken',
  'unavailable',
  'busy',
  'not_paired',
  'rate_limited',
  'expired',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const limitsSchema = z.object({
  maxMessageBytes: z.number(),
  relayMaxChars: z.number(),
  graceMs: z.number(),
  inviteTtlMs: z.number(),
  lobbyTtlMs: z.number(),
  verifyTtlMs: z.number(),
  pairedIdleMs: z.number(),
  pingIntervalMs: z.number(),
});
export type Limits = z.infer<typeof limitsSchema>;

export const serverFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), resumeToken: bytes32, limits: limitsSchema }),
  z.object({
    type: z.literal('resumed'),
    resumeToken: bytes32,
    state: sessionStateSchema,
    pseudonym: z.string().nullable(),
    peer: z.string().nullable(),
    pairId: z.string().nullable(),
  }),
  z.object({ type: z.literal('resume_failed') }),
  z.object({ type: z.literal('claimed'), pseudonym: z.string(), expiresAt: z.number() }),
  z.object({ type: z.literal('invite_sent'), inviteId: opaqueId, expiresAt: z.number() }),
  z.object({
    type: z.literal('invite_in'),
    inviteId: opaqueId,
    from: z.string(),
    commit: bytes32,
    expiresAt: z.number(),
  }),
  z.object({ type: z.literal('invite_declined'), inviteId: opaqueId }),
  z.object({ type: z.literal('invite_expired'), inviteId: opaqueId }),
  z.object({ type: z.literal('invite_cancelled'), inviteId: opaqueId }),
  z.object({ type: z.literal('paired'), pairId: opaqueId, peer: z.string(), pub: bytes32.optional() }),
  z.object({ type: z.literal('peer_reveal'), pub: bytes32 }),
  z.object({ type: z.literal('frame'), c: b64url.max(RELAY_MAX_CHARS) }),
  z.object({ type: z.literal('undeliverable') }),
  z.object({ type: z.literal('peer_away'), graceUntil: z.number() }),
  z.object({ type: z.literal('peer_back') }),
  z.object({ type: z.literal('ended'), reason: endReasonSchema }),
  z.object({ type: z.literal('error'), code: errorCodeSchema }),
  z.object({ type: z.literal('pong') }),
]);

export type ServerFrame = z.infer<typeof serverFrameSchema>;

export const CloseCode = {
  normal: 4000,
  protocol: 4001,
  rateLimited: 4002,
  expired: 4003,
  replaced: 4004,
  serverRestart: 4005,
} as const;
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];
