/**
 * Exponential backoff for transactions waiting on a missing reference.
 * attempt n (0-based) waits min(base * 2^n, max) ± jitter. After `maxAttempts` re-checks the
 * transaction is rejected with REFERENCE_NOT_FOUND.
 *
 * Defaults (2s base, 8 attempts, 5 min cap) give a ~8.5 min TTL: long enough to absorb
 * realistic provider reordering, short enough that a provider gets a definitive answer quickly.
 */
export class ReferenceRetryPolicy {
  constructor(
    readonly baseDelayMs = 2_000,
    readonly maxDelayMs = 300_000,
    readonly maxAttempts = 8,
    private readonly jitterRatio = 0.1,
    private readonly random: () => number = Math.random,
  ) {}

  isExhausted(attempts: number): boolean {
    return attempts >= this.maxAttempts;
  }

  nextCheckAt(attempts: number, now: Date): Date {
    const raw = Math.min(this.baseDelayMs * 2 ** attempts, this.maxDelayMs);
    const jitter = raw * this.jitterRatio * (this.random() * 2 - 1);
    return new Date(now.getTime() + Math.round(raw + jitter));
  }
}
