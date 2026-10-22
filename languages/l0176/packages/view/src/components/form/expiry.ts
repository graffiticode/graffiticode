// SPDX-License-Identifier: MIT
// When a signed request stops being usable to START an assessment.
//
// Broker signs previews with an `expires` (10 minutes by default). Learnosity
// checks it when the SDK initializes; a preview already initialized keeps
// working after it passes (measured 2026-10-22: answer, validate and read
// responses all succeeded past `expires`). So expiry only matters for a request
// that hasn't been initialized yet, typically one replayed from earlier: an MCP
// widget handing a reopened chat's stored item to the /form frame.
//
// The Questions SDK puts the security fields at the top level of the signed
// request; the Items SDK nests them under `security`. Learnosity's time format
// is UTC to the minute, `YYYYMMDD-HHmm`.

/** Starting an assessment this close to `expires` risks it lapsing mid-init. */
export const EXPIRY_MARGIN_MS = 60_000;

/** Milliseconds since the epoch for a Learnosity `YYYYMMDD-HHmm` time, or null. */
export function parseLearnosityTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi);
  return Number.isFinite(ms) ? ms : null;
}

/** A signed request's `expires`, for either SDK's shape, or null when it has none. */
export function requestExpiresAt(request: any): number | null {
  return parseLearnosityTime(request?.expires ?? request?.security?.expires);
}

/** True when the request can no longer be relied on to initialize at `now`. */
export function isStaleRequest(request: any, now: number): boolean {
  const expiresAt = requestExpiresAt(request);
  return expiresAt !== null && expiresAt - now < EXPIRY_MARGIN_MS;
}
