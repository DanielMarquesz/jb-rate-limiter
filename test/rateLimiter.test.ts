import { describe, expect, it } from "vitest";
import { InvalidTimestampError, InvalidUserIdError, RateLimiter } from "../src/rateLimiter.js";

describe("RateLimiter — spec example (limit 3 req / 60s)", () => {
  // The spec's example uses seconds (e.g. t=10, t=70). Our limiter takes
  // milliseconds, so every timestamp below is the spec's value * 1000.
  const SEC = 1000;

  it("reproduces every line of the spec transcript", () => {
    const limiter = new RateLimiter(3, 60 * SEC);

    expect(limiter.allow("alice", 10 * SEC)).toBe(true);
    expect(limiter.allow("alice", 10 * SEC)).toBe(true);
    expect(limiter.allow("alice", 70 * SEC)).toBe(true);
    expect(limiter.allow("alice", 70 * SEC)).toBe(false);
    expect(limiter.allow("alice", 71 * SEC)).toBe(true);

    // Out-of-order call (65 < 71): by this point the t=10 entries were
    // already evicted by the ts=71 call and aren't revived, so this is
    // evaluated against alice's stored [70, 71], neither <= 65.
    expect(limiter.allow("alice", 65 * SEC)).toBe(true);

    expect(limiter.allow("", 70 * SEC)).toBe(true);
  });
});

describe("RateLimiter — default limit (100 req / 60s window)", () => {
  it("allows exactly 100 requests in a window and rejects the 101st", () => {
    const limiter = new RateLimiter();

    for (let i = 0; i < 100; i++) {
      expect(limiter.allow("bob", 1_000 + i)).toBe(true);
    }
    expect(limiter.allow("bob", 1_100)).toBe(false);
  });

  it("treats the window boundary as inclusive on both ends", () => {
    const limiter = new RateLimiter(1, 60_000);

    expect(limiter.allow("carol", 0)).toBe(true);
    // Exactly 60_000ms later is still within the inclusive window.
    expect(limiter.allow("carol", 60_000)).toBe(false);
    expect(limiter.allow("carol", 60_001)).toBe(true);
  });
});

describe("RateLimiter — userId handling", () => {
  it("tracks independent counters for different users", () => {
    const limiter = new RateLimiter(1, 60_000);

    expect(limiter.allow("dave", 0)).toBe(true);
    expect(limiter.allow("dave", 0)).toBe(false);
    expect(limiter.allow("erin", 0)).toBe(true);
  });

  it("routes empty string to one shared global bucket, separate from named users", () => {
    const limiter = new RateLimiter(1, 60_000);

    expect(limiter.allow("frank", 0)).toBe(true);
    expect(limiter.allow("", 0)).toBe(true);
    expect(limiter.allow("frank", 0)).toBe(false);
    expect(limiter.allow("", 0)).toBe(false);
  });

  it("throws InvalidUserIdError for null or undefined userId, rather than returning false", () => {
    const limiter = new RateLimiter();

    expect(() => limiter.allow(null, 0)).toThrow(InvalidUserIdError);
    expect(() => limiter.allow(undefined, 0)).toThrow(InvalidUserIdError);
  });
});

describe("RateLimiter — invalid timestamp", () => {
  it("throws InvalidTimestampError for NaN, Infinity, and -Infinity, rather than returning false", () => {
    const limiter = new RateLimiter();

    expect(() => limiter.allow("bob", NaN)).toThrow(InvalidTimestampError);
    expect(() => limiter.allow("bob", Infinity)).toThrow(InvalidTimestampError);
    expect(() => limiter.allow("bob", -Infinity)).toThrow(InvalidTimestampError);
  });

  it("does not reset a user's history when a rejected NaN call is attempted", () => {
    const limiter = new RateLimiter(3, 60_000);

    expect(limiter.allow("bob", 0)).toBe(true);
    expect(limiter.allow("bob", 0)).toBe(true);
    expect(limiter.allow("bob", 0)).toBe(true);
    expect(limiter.allow("bob", 0)).toBe(false);

    // Without validation, cutoff = NaN would make every `t >= cutoff`
    // comparison false, wiping bob's history and resetting the limit.
    expect(() => limiter.allow("bob", NaN)).toThrow(InvalidTimestampError);

    expect(limiter.allow("bob", 0)).toBe(false);
  });
});

describe("RateLimiter — many concurrent users", () => {
  it("keeps every user's count correct and isolated", () => {
    const limiter = new RateLimiter(5, 60_000);
    const userCount = 500;

    for (let u = 0; u < userCount; u++) {
      const userId = `user-${u}`;
      for (let i = 0; i < 5; i++) {
        expect(limiter.allow(userId, 0)).toBe(true);
      }
      expect(limiter.allow(userId, 0)).toBe(false);
    }
  });
});
