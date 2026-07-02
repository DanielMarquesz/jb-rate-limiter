/**
 * Sliding-window rate limiter with per-user history.
 *
 * Timestamps are plain numbers in milliseconds, supplied entirely by the
 * caller — the limiter never reads the system clock, so behavior is fully
 * deterministic and testable.
 */

export class InvalidUserIdError extends Error {
  constructor(message = "userId must not be null or undefined") {
    super(message);
    this.name = "InvalidUserIdError";
  }
}

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;

  /** Per-user accepted-timestamp history. */
  private readonly userHistories = new Map<string, number[]>();

  /** Shared history for the "" (global) bucket, kept separate from
   * userHistories so a real userId can never collide with the global key. */
  private globalHistory: number[] = [];

  constructor(limit = 100, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(userId: string | null | undefined, timestamp: number): boolean {
    if (userId === null || userId === undefined) {
      throw new InvalidUserIdError();
    }

    const isGlobal = userId === "";
    const history = isGlobal ? this.globalHistory : this.userHistories.get(userId) ?? [];

    const cutoff = timestamp - this.windowMs;

    // Permanently drop entries below this call's own window — see README
    // "Out-of-order timestamps" for why we don't try to revive entries a
    // prior (later) call already evicted.
    const fresh = history.filter((t) => t >= cutoff);

    // Entries kept above may still be > timestamp (future-dated relative to
    // this out-of-order call); those don't count toward *this* call but stay
    // stored for later calls.
    const countInWindow = fresh.filter((t) => t <= timestamp).length;
    const accepted = countInWindow < this.limit;

    if (accepted) {
      fresh.push(timestamp);
    }

    if (isGlobal) {
      this.globalHistory = fresh;
    } else {
      this.userHistories.set(userId, fresh);
    }

    return accepted;
  }
}
