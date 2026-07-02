// Timestamps are plain numbers in milliseconds, supplied entirely by the
// caller — never read from the system clock — so behavior is deterministic.

export class InvalidUserIdError extends Error {
  constructor(message = "userId must not be null or undefined") {
    super(message);
    this.name = "InvalidUserIdError";
  }
}

export class InvalidTimestampError extends Error {
  constructor(message = "timestamp must be a finite number") {
    super(message);
    this.name = "InvalidTimestampError";
  }
}

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;

  private readonly userHistories = new Map<string, number[]>();

  // Kept as its own field rather than a userHistories entry so a real
  // userId can never collide with the global key.
  private globalHistory: number[] = [];

  constructor(limit = 100, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(userId: string | null | undefined, timestamp: number): boolean {
    if (userId === null || userId === undefined) {
      throw new InvalidUserIdError();
    }

    if (!Number.isFinite(timestamp)) {
      throw new InvalidTimestampError();
    }

    const isGlobal = userId === "";
    const history = isGlobal ? this.globalHistory : this.userHistories.get(userId) ?? [];

    const cutoff = timestamp - this.windowMs;

    // Evaluated against this call's own window; entries a prior (later-
    // timestamped) call already evicted are not revived. See README.
    const fresh = history.filter((t) => t >= cutoff);

    // fresh may still hold entries > timestamp for out-of-order calls;
    // those don't count here but stay stored for later calls.
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
