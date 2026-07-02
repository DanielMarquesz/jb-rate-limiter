import { describe, expect, it } from "vitest";
import { InvalidUserIdError, RateLimiter } from "../src/rateLimiter.js";

describe("RateLimiter — spec example (limit 3 req / 60s)", () => {
  // The spec's example uses seconds (e.g. t=10, t=70). Our limiter takes
  // milliseconds, so every timestamp below is the spec's value * 1000.
  const SEC = 1000;

  it("reproduces every line of the spec transcript", () => {
    const limiter = new RateLimiter(3, 60 * SEC);

    expect(limiter.allow("alice", 10 * SEC)).toBe(true); // 1st
    expect(limiter.allow("alice", 10 * SEC)).toBe(true); // 2nd
    expect(limiter.allow("alice", 70 * SEC)).toBe(true); // 3rd
    expect(limiter.allow("alice", 70 * SEC)).toBe(false); // 4th rejected

    // Window has slid past t=10, freeing room.
    expect(limiter.allow("alice", 71 * SEC)).toBe(true);

    // Out-of-order: ts=65 is earlier than the previous call (71). Per our
    // documented "as-is" semantics, we count history within [65-60, 65]=[5,65]
    // using whatever survived prior evictions. At this point alice's stored
    // history is [70, 71] (the t=10 entries were evicted by the ts=71 call),
    // neither of which is <= 65, so the count in this call's window is 0 and
    // the request is accepted.
    expect(limiter.allow("alice", 65 * SEC)).toBe(true);

    // "" is a separate, shared global counter — independent of alice's count.
    expect(limiter.allow("", 70 * SEC)).toBe(true);
  });
});

describe("RateLimiter — default limit (100 req / 60s window)", () => {
  it("allows exactly 100 requests in a window and rejects the 101st", () => {
    const limiter = new RateLimiter();

    for (let i = 0; i < 100; i++) {
      expect(limiter.allow("bob", 1_000 + i)).toBe(true);
    }
    // A timestamp at or after all 100 prior ones sees the full count and is rejected.
    expect(limiter.allow("bob", 1_100)).toBe(false);
  });

  it("treats the window boundary as inclusive on both ends", () => {
    const limiter = new RateLimiter(1, 60_000);

    expect(limiter.allow("carol", 0)).toBe(true);
    // Exactly 60_000ms later — still within [ts-60000, ts], so still counted
    // and thus rejected (limit is 1).
    expect(limiter.allow("carol", 60_000)).toBe(false);
    // One ms further and the first entry (t=0) falls outside the window.
    expect(limiter.allow("carol", 60_001)).toBe(true);
  });
});

describe("RateLimiter — userId handling", () => {
  it("tracks independent counters for different users", () => {
    const limiter = new RateLimiter(1, 60_000);

    expect(limiter.allow("dave", 0)).toBe(true);
    expect(limiter.allow("dave", 0)).toBe(false);
    // A different user is unaffected by dave's usage.
    expect(limiter.allow("erin", 0)).toBe(true);
  });

  it("routes empty string to one shared global bucket, separate from named users", () => {
    const limiter = new RateLimiter(1, 60_000);

    expect(limiter.allow("frank", 0)).toBe(true);
    expect(limiter.allow("", 0)).toBe(true);
    // frank's own limit is already spent, but that must not affect "".
    expect(limiter.allow("frank", 0)).toBe(false);
    // and a second global call is now rejected on its own terms.
    expect(limiter.allow("", 0)).toBe(false);
  });

  it("throws InvalidUserIdError for null or undefined userId, rather than returning false", () => {
    const limiter = new RateLimiter();

    expect(() => limiter.allow(null, 0)).toThrow(InvalidUserIdError);
    expect(() => limiter.allow(undefined, 0)).toThrow(InvalidUserIdError);
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
