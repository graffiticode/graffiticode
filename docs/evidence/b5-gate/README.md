# B5 usage gate: passed 2026-11-06

Plan "Gates for B5 and B6". `gate-verdict.json` combines drive 6 (`2026-11-06-run6/report.json`, 68 of 69 checks) with the rollback rehearsal (`rehearsal/rehearsal.json`, criterion 9): **69 of 69**.

Each drive ran `scripts/interpret-soak.js` on L0184, L0186, L0175, L0179 and L0181. That's 2000 misses and 2000 repeats per language at concurrency 16, with bursts, chains and the View loop, about 128,000 requests per drive. Each drive found something, and each was fixed before the next:

| Drive | Found | Fixed by |
|---|---|---|
| trials | `ECONNRESET` on model calls; the latency criterion compared the api with a direct compile | #292 (retry), #291 (budget against the api's legacy path) |
| 1 (`2026-11-05`) | Misses slow (a model call on every request). Stage-cache key collision: key-sorted digests let L0186 programs share answers. Resets survived one retry. | #293 (model cache), #296 (exact-text key), #295 (two retries, with backoff) |
| 2 (`-run2`) | Legacy calls through the Cloudflare-proxied domains reset and answered 401 | #297 (the api reaches services by Cloud Run host; browsers keep the domains) |
| 3 (`-run3`) | The Rust server answered 401 whenever the auth service was slow or unreachable, and checked the token on every call | #298 (kernel: 503 when unavailable, token cache bounded by `exp`), all 19 Rust services released |
| 4 (`-run4`) | Requests hung until Cloud Run's 300 s limit (no deadline on api-to-language calls); `l0184` at min 0 since its rename | #299 (deadlines), `l0184` set to min 1 |
| 5 (`2026-11-06-run5`) | Only first-language latency: scale-out right after a release | #300 (unmeasured warm-up, criterion 8) |
| 6 (`-run6`) | Everything passes but criterion 9 | the rehearsal |

**Rehearsal (criterion 9), L0179:**
- **Off, then on:**
  1. `INTERPRETER_L0179` off with `rust-3` (#302).
  2. Back on with `interp-2` (#303).

  Each was an api release, and each was checked with `rehearsal/rehearsal.mjs`.
- **Finding:** removing a flag from `deploy.json` doesn't turn it off (#301). The deploy CLI keeps variables it isn't given, so flags are turned off by value.
- **Finding:** Cloudflare caches `/form` redirects for an hour, so after a flip, browsers can be sent previous-generation data URLs. Those are answered `no-store` and correct.

Both findings are follow-ups.
