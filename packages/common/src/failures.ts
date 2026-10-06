// One vocabulary for why a request failed (spec FAIL-01): every refusal a
// caller can see carries a category beside its reason.
//
//   authentication  who is asking isn't established (no or bad credentials)
//   permission      who is asking is known, and isn't allowed
//   malformed       the request itself is wrong
//   conflict        it collides with recorded state (replays, reused ids, versions)
//   unavailable     a dependency or the service can't decide now; try again later
//
// A category describes the failure only. It never decides whether anything
// is retried: retry behavior stays where it is (idempotency keys, receipts).

export const FAILURE_CATEGORIES = Object.freeze(["authentication", "permission", "malformed", "conflict", "unavailable"] as const);
export type FailureCategory = typeof FAILURE_CATEGORIES[number];

const cat = (category: FailureCategory, reasons: string[]) => reasons.map(r => [r, category] as const);

// Every refusal reason Policy, Broker and api emit. A reason missing here is a
// test failure (scripts/test/failures-inventory.test.js), not a silent
// category.
export const REASON_CATEGORIES: Readonly<Record<string, FailureCategory>> = Object.freeze(Object.fromEntries([
  ...cat("authentication", [
    "bad-token", "token-expired", "bad-session", "bad-invocation", "no-user", "caller-rejected",
  ]),
  ...cat("permission", [
    "not-granted", "not-owner", "not-publisher", "self-grant", "publish-not-granted",
    "fn-not-enabled", "fn-not-in-session", "not-view-safe", "not-system-preview",
    "operation-not-allowed", "operation-not-enabled", "bad-provenance",
    // At Policy, a step the registry doesn't list for this operation; at Broker,
    // a step its own definition doesn't register. Refused either way.
    "step-not-registered",
    "caller-language-mismatch", "caller-not-broker", "caller-not-entry-point", "route-not-allowed-for-caller",
    "connection-disabled", "connection-not-found", "owner-changed", "backend-changed",
    "system-connection", "not-system-connection", "publication-not-found", "publication-mismatch",
    "no-credential", "credential-binding-mismatch",
  ]),
  ...cat("malformed", [
    "bad-request", "args-mismatch", "payload-rejected", "operation-mismatch", "bad-permissions",
    "bad-credential", "unknown-backend", "grant-not-found",
  ]),
  ...cat("conflict", [
    "token-replayed", "token-expiring", "operation-id-reused", "idempotency-key-reused",
    "provider-account-changed", "registry-version-changed", "registry-version-mismatch",
    "receipt-registry-version-mismatch",
  ]),
  ...cat("unavailable", [
    "maintenance", "authorization-unavailable", "deadline-exceeded", "unavailable",
    "no-system-connection", "no-system-preview-functions",
  ]),
  // api: artifacts and reads through a connection or publication.
  // (`signed-content` and `storage-failed` detail why an artifact wasn't stored.)
  ...cat("unavailable", ["artifact-storage-unavailable", "connections-unavailable", "publications-unavailable", "policy-unavailable", "storage-failed"]),
  ...cat("conflict", ["artifact-rejected", "artifact-incompatible", "published-artifact-unavailable", "signed-content"]),
  ...cat("malformed", ["artifact-not-found", "publication-other-item"]),
]));

// Broker wraps Policy's reason (`authorization-denied:<reason>`); the category
// is the underlying reason's, so a wrapped `token-expired` is authentication
// and a wrapped `maintenance` unavailable, not a blanket permission denial.
const WRAPPERS = ["authorization-denied:"];
export const underlyingReason = (reason: string): string => {
  for (const prefix of WRAPPERS) {
    if (reason.startsWith(prefix)) return underlyingReason(reason.slice(prefix.length));
  }
  return reason;
};

// The category of a reason. An unknown reason is `unavailable`, never a
// permission denial that would hide an outage, and `classified: false` asks
// the caller to report it (without echoing the value, which may be untrusted).
export const classify = (reason: unknown): { category: FailureCategory, classified: boolean } => {
  if (typeof reason === "string") {
    const category = REASON_CATEGORIES[underlyingReason(reason)];
    if (category) return { category, classified: true };
  }
  return { category: "unavailable", classified: false };
};

// For responses without a reason: the HTTP status's category.
export const categoryForStatus = (status: number): FailureCategory => {
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 409) return "conflict";
  if (status >= 400 && status < 500 && status !== 429) return "malformed";
  return "unavailable";
};

// A request body the JSON parser rejected (express.json / body-parser) is the
// caller's malformed request, whatever status the handler answers with.
export const isMalformedBody = (err: unknown): boolean => {
  const type = (err as { type?: unknown })?.type;
  return type === "entity.parse.failed" || type === "entity.too.large" || type === "encoding.unsupported" || type === "charset.unsupported";
};
