import { createHmac, randomBytes } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;

// Turns a client IP into an opaque key for rate limiting (docs/SECURITY.md §6).
// The salt is random, lives only in memory, and rotates daily, so keys can't be
// reversed after a restart or correlated across days.
export class IpKeyer {
  private salt = randomBytes(32);
  private rotatedAt: number;

  constructor(now: number) {
    this.rotatedAt = now;
  }

  key(ip: string, now: number): string {
    if (now - this.rotatedAt > DAY_MS) {
      this.salt = randomBytes(32);
      this.rotatedAt = now;
    }
    return createHmac('sha256', this.salt).update(ip).digest('base64url').slice(0, 22);
  }
}
