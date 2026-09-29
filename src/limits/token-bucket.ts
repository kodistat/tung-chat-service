export interface BucketSpec {
  capacity: number;
  perSecond: number;
}

export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly spec: BucketSpec,
    now: number,
  ) {
    this.tokens = spec.capacity;
    this.updatedAt = now;
  }

  take(now: number, cost = 1): boolean {
    const elapsed = Math.max(0, now - this.updatedAt) / 1000;
    this.tokens = Math.min(this.spec.capacity, this.tokens + elapsed * this.spec.perSecond);
    this.updatedAt = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}
