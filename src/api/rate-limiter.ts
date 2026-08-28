import { serviceError } from '../application/service-error.js';

type Bucket = { startedAt: number; count: number };

export class FixedWindowRateLimiter {
  readonly #buckets = new Map<string, Bucket>();

  public constructor(
    private readonly limit = 120,
    private readonly windowMilliseconds = 60_000,
    private readonly now: () => number = Date.now,
    private readonly maximumBuckets = 1_024,
  ) {}

  public get bucketCount(): number {
    return this.#buckets.size;
  }

  public consume(key: string): void {
    const current = this.now();
    const bucket = this.#buckets.get(key);
    if (bucket === undefined || current - bucket.startedAt >= this.windowMilliseconds) {
      for (const [candidate, existing] of this.#buckets) {
        if (current - existing.startedAt >= this.windowMilliseconds) this.#buckets.delete(candidate);
      }
      if (!this.#buckets.has(key) && this.#buckets.size >= this.maximumBuckets) {
        const oldest = this.#buckets.keys().next().value;
        if (oldest !== undefined) this.#buckets.delete(oldest);
      }
      this.#buckets.set(key, { startedAt: current, count: 1 });
      return;
    }
    bucket.count += 1;
    if (bucket.count > this.limit) {
      throw serviceError(429, 'rate_limited', 'The request rate limit was exceeded.');
    }
  }
}
