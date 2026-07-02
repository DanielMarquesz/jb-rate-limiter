# Rate Limiter with History

A sliding-window rate limiter: `allow(userId, timestamp) -> boolean`, capping
each user (or a shared global bucket for `""`) to a configurable number of
requests per configurable time window (default: **100 requests / 60 seconds**).

## Running it

```bash
npm install
npm test          # runs the test suite (vitest)
npm run typecheck # tsc --noEmit
```

There's no CLI/server — this is a library, used like:

```ts
import { RateLimiter } from "./src/rateLimiter.js";

const limiter = new RateLimiter(); // 100 req / 60_000 ms
limiter.allow("alice", Date.now()); // -> true / false
```

## Timestamp unit

**Milliseconds.** The default window is `60_000`. The spec allowed either
seconds or milliseconds; milliseconds were chosen because they match
`Date.now()` and give finer-grained boundary behavior. The class itself is
unit-agnostic — `windowMs` just needs to be expressed in the same unit as
the timestamps you pass in — but the default and all "real" usage assume
milliseconds.

## Data structure, and why

`src/rateLimiter.ts` keeps one **array of accepted timestamps** per bucket:

- `userHistories: Map<string, number[]>` — one array per named user.
- `globalHistory: number[]` — a single dedicated array for the `""` bucket,
  kept as its own field rather than a map entry, so a real userId can never
  collide with a "global" sentinel key.

On every `allow(userId, timestamp)` call:

1. `cutoff = timestamp - windowMs`. Filter the bucket's array down to
   entries `>= cutoff` — this both prunes memory (stale entries are dropped
   for GC) and is the basis for step 2.
2. Count the remaining entries that are `<= timestamp`. This is exactly the
   count of prior requests inside `[cutoff, timestamp]`, i.e. the current
   sliding window.
3. If that count is below the limit, push `timestamp` onto the array and
   return `true`; otherwise return `false` (and still keep the pruned array —
   the rejected timestamp is not stored).

**Why a plain array instead of a queue/deque or a sorted/tree structure:**

- The limit is small and fixed (100), so each bucket's array almost never
  holds more than ~100 entries in normal (roughly time-ordered) usage — a
  linear filter/scan per call is trivial (worst case ~200 comparisons).
- A FIFO/deque with "pop from the front while stale" would be marginally
  cheaper, but it silently assumes timestamps arrive in non-decreasing
  order — which the spec explicitly says is *not* guaranteed (see the
  `allow("alice", 65)` example after `allow("alice", 71)`). A full filter
  instead of front-only popping keeps the limiter correct even when a call's
  timestamp is older than one that was already accepted.
- If the limit were much larger (say, tens of thousands), this would be
  worth revisiting — a sorted structure with binary search, or a fixed-size
  ring buffer, would turn the O(n) filter into O(log n) or O(1) amortized.

**Concurrency:** Node.js runs this synchronously on a single thread, so
"correct for many users at the same time" is satisfied by each bucket having
its own independent array with no shared mutable state across users — there's
no locking/race-condition concern to design around in this environment. (If
this were ported to a multi-threaded runtime or used across processes, the
per-key mutation in step 3 would need a lock or an atomic/CAS structure per
key, or to move to something like Redis with `ZADD`/`ZRANGEBYSCORE` +
expiry.)

## ~10,000 active users: memory and production considerations

**Memory complexity:** `O(users × limit)` in the worst case — each of the
(up to) 10,000 users can hold up to `limit` (100) numbers in their array at
once, so worst case is `10,000 × 100 = 1,000,000` numbers (JS numbers are
8 bytes, so roughly 8 MB of raw payload, plus per-array/per-map-entry
overhead — call it a low tens-of-MB ceiling). That's perfectly fine for
10k users.

**What breaks over a long production run:** the `userHistories` map entry for
a user is created on first use but is **never removed**, even once that
user's array empties out (e.g. they made one request and never came back).
For a service with high user churn (bots, one-off signups, rotating API
keys, etc.) over months, `userHistories` grows unbounded — a slow memory
leak, not a spike. 10,000 *concurrently active* users is fine; 10,000,000
*distinct* users seen over a year, each leaving a near-empty map entry
behind, is not.

What I'd change for a long-running production deployment:

- **Evict empty buckets on access**: after step 3, if a user's array ends up
  empty, delete the map key instead of storing an empty array. This bounds
  the map to users with at least one timestamp still in-window. It
  self-heals, but still leaves one stale entry per lapsed user until their
  next call (or forever, if they never come back — see next point).
- **Bound total memory with an LRU cache** (e.g. cap `userHistories` at some
  max key count, evicting least-recently-used keys) so worst-case memory is
  a hard ceiling regardless of how many distinct users have ever connected.
- **A periodic sweep** (e.g. every few minutes) that walks the map and drops
  any key whose latest timestamp is older than `now - windowMs`, for
  deployments where "on access" eviction isn't enough because inactive users
  never call `allow` again to trigger it.
- If this needs to scale beyond a single process (multiple app instances
  behind a load balancer), the whole approach would move to a shared store
  like Redis, using a sorted set per user (`ZADD`/`ZREMRANGEBYSCORE`) with a
  `TTL`/`EXPIRE` on the key so idle users clean themselves up automatically
  without a custom sweep.

## Things that were unclear or required an assumption

- **Timestamp unit (seconds vs. milliseconds):** the spec explicitly left
  this open. Chose milliseconds (see above); the class is otherwise
  unit-agnostic.
- **Out-of-order timestamps** (`allow("alice", 65)` called after
  `allow("alice", 71)`): the spec deliberately doesn't say what should
  happen, just that it should be "deliberate." I chose to evaluate every
  call strictly against its *own* `[timestamp - windowMs, timestamp]` window,
  using whatever history remains at that moment. In other words, I do
  **not** try to "revive" entries that an earlier (chronologically later)
  call already evicted for being outside *its* window. This is the
  simplest, most literal reading of "sliding window relative to the given
  timestamp," and it keeps memory bounded by always pruning strictly-older
  entries rather than keeping full unbounded history "just in case" an
  even-earlier call shows up later.

  The tradeoff: a pathological interleaving of far-future and far-past
  out-of-order calls could, in theory, undercount slightly relative to
  "true" full-history semantics, since some entries get pruned before a
  later-arriving-but-earlier-timestamped call could see them. For realistic
  usage — timestamps only occasionally out of order, e.g. due to clock skew
  or reordered network delivery — this doesn't come up.
- **Window boundary inclusivity:** the spec's own example implies both ends
  of the `[timestamp - 60, timestamp]` window are inclusive — at limit 3,
  `allow("alice", 10)`, `allow("alice", 10)`, `allow("alice", 70)` are all
  counted together (70 − 10 = exactly 60), and the 4th call at `70` is
  rejected. I implemented `>= cutoff` and `<= timestamp` to match this
  exactly (see the boundary test in `test/rateLimiter.test.ts`).
- **Error type for invalid `userId`:** the spec says "throw an exception /
  return an error appropriate for your language — not `false`." I added a
  dedicated `InvalidUserIdError extends Error` class rather than a generic
  `Error` or a sentinel return value, so callers can `instanceof`-check it
  distinctly from other failures.
- **Non-finite `timestamp` (`NaN`/`Infinity`/`-Infinity`):** not mentioned by
  the spec, but these break the arithmetic in ways worth guarding against:
  - `NaN` makes `cutoff = timestamp - windowMs` also `NaN`, and every
    `t >= NaN` comparison is `false` — silently wiping a user's entire
    history instead of just the stale portion, which resets their rate
    limit.
  - `Infinity` is milder but still real: it gets accepted as an entry that
    satisfies `t >= cutoff` forever but never `t <= timestamp` for any
    later finite call, permanently occupying a slot.

  Both are handled the same way as an invalid `userId` — reject with a
  dedicated `InvalidTimestampError` rather than silently corrupting state or
  returning `false`.
- **Non-string / malformed `userId`** (e.g. a number, an object, or a
  whitespace-only string like `" "`): the spec only calls out non-empty
  string, empty string, and null/missing. I treat anything that is neither
  `null` nor `undefined` as a valid key as-is (so `" "` is a normal,
  non-global per-user key, distinct from `""`) — no extra validation beyond
  what's specified.
- **"Must work correctly for many users at the same time":** interpreted as
  correctness/isolation of per-user state under many distinct users, not
  multi-threaded concurrency — see the "Concurrency" note above for why that
  distinction matters for a single-threaded Node.js implementation.
