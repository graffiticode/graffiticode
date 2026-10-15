// A per-instance token bucket on system preview signing (the system-preview
// rate limits plan, design point 3): every execution token minted under a
// system preview session takes one token. Connection and publication mints
// never do.
//
// It is an approximate safeguard, not a hard ceiling: each Policy instance
// has its own bucket, starting full, so N instances allow roughly
// N x (burst + perMinute x minutes), and a restart refills one. Broker's
// per-session allowance (SYSTEM_SESSION_MAX_SIGNINGS) is the shared,
// durable accounting.
//
//   SYSTEM_SIGNINGS_PER_MINUTE  refill rate (default 120)
//   SYSTEM_SIGNINGS_BURST       capacity (default 60)

export const DEFAULT_SYSTEM_SIGNING: Readonly<{ perMinute: number, burst: number }> = Object.freeze({ perMinute: 120, burst: 60 });

// `now` is in milliseconds. take() -> { ok: true } or { ok: false,
// retryAfter } (whole seconds until one token is available, at least 1).
export const createTokenBucket = ({ perMinute, burst, now = () => Date.now() }: { perMinute: number, burst: number, now?: () => number }) => {
  if (!(Number.isInteger(perMinute) && perMinute > 0)) throw new Error("token bucket needs a positive integer perMinute");
  if (!(Number.isInteger(burst) && burst > 0)) throw new Error("token bucket needs a positive integer burst");
  // Whole numbers only: one token is 60,000 units, and each millisecond adds
  // `perMinute` units, so refills never drift.
  const UNIT = 60_000;
  const capacity = burst * UNIT;
  let units = capacity;
  let at = Math.floor(now());
  const refill = () => {
    const t = Math.floor(now());
    // A clock that steps back never drains the bucket.
    if (t > at) units = Math.min(capacity, units + (t - at) * perMinute);
    at = Math.max(at, t);
  };
  return {
    take() {
      refill();
      if (units >= UNIT) {
        units -= UNIT;
        return { ok: true as const };
      }
      return { ok: false as const, retryAfter: Math.max(1, Math.ceil((UNIT - units) / perMinute / 1000)) };
    },
  };
};
