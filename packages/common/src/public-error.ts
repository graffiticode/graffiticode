// The public shape of a failure (error handling proposal, step 2): what a
// caller may see of any error, whatever produced it. Nothing imports it yet
// (PR 2a); the translators adopt it additively in PR 2b.
//
//   version      the contract version of this shape
//   reason       the specific reason, when it is registered; otherwise null
//   category     its broad classification (FAIL-01)
//   message      a safe explanation: the reason's own, the error's public
//                message, or its category's; never an internal message
//   details      only the fields the reason's spec allows
//   context      language, stage, function or step, when known
//   recovery     { action, operation }: what may safely be done next
//   requestRef   the request's id, for support and correlation
//   retryable    compatibility only: true exactly when the action is
//                retry-same-key
//
// Stack traces, causes, credentials and upstream bodies never appear: every
// field is chosen here, nothing is copied through.
import { categoryForStatus, classify, canonicalReason, DETAIL_KINDS, FAILURE_CATEGORIES, recoveryFor, specOf, type FailureCategory, type RecoveryAction } from "./failures.js";
import { contextOf, type FailureContext } from "./failure-error.js";
import { currentRequestId } from "./request-context.js";

export const PUBLIC_ERROR_VERSION = 1;

export type PublicError = {
  version: number;
  reason: string | null;
  category: FailureCategory;
  message: string;
  details?: Record<string, unknown>;
  context?: FailureContext;
  recovery: { action: RecoveryAction, operation: string | null };
  requestRef?: string;
  retryable: boolean;
};

export const CATEGORY_MESSAGES: Readonly<Record<FailureCategory, string>> = Object.freeze({
  authentication: "The request's credentials weren't accepted.",
  permission: "The request isn't allowed.",
  malformed: "The request isn't valid.",
  conflict: "The request conflicts with what is already recorded.",
  unavailable: "The service couldn't handle the request now.",
});
const MESSAGE_LIMIT = 500;

const isCategory = (value: unknown): value is FailureCategory =>
  typeof value === "string" && (FAILURE_CATEGORIES as readonly string[]).includes(value);

// A reason an error carries: `reason`, or a diagnostic's string `code`.
const reasonOf = (err: Record<string, unknown>): string | null => {
  if (typeof err.reason === "string" && err.reason) return err.reason;
  if (typeof err.code === "string" && err.code) return err.code;
  return null;
};

export type PublicErrorOptions = {
  // "read" (no effects) or "write"; decides recovery for reasons whose rule
  // depends on it.
  operation?: string | null;
  // The operation's recorded state, when known ("uncertain" means reconcile).
  recordedState?: string | null;
  // Defaults to the current request's id (request-context.ts).
  requestRef?: string;
};

export const toPublicError = (error: unknown, { operation = null, recordedState = null, requestRef = currentRequestId() }: PublicErrorOptions = {}): PublicError => {
  const err = (error && typeof error === "object" ? error : {}) as Record<string, unknown>;
  const given = reasonOf(err);
  const spec = specOf(given);
  // An unregistered reason is another component's text: it isn't echoed.
  const reason = spec && given ? canonicalReason(given) : null;
  const statusCode = typeof err.statusCode === "number" ? err.statusCode : typeof err.status === "number" ? err.status : null;
  const category: FailureCategory = isCategory(err.category)
    ? err.category
    : given ? classify(given).category : statusCode ? categoryForStatus(statusCode) : "unavailable";
  const publicMessage = typeof err.publicMessage === "string" && err.publicMessage ? err.publicMessage.slice(0, MESSAGE_LIMIT) : null;
  const message = spec?.message ?? publicMessage ?? CATEGORY_MESSAGES[category];
  const rawDetails = (err.details ?? err.detail) as Record<string, unknown> | undefined;
  let details: Record<string, unknown> | undefined;
  if (spec?.details && rawDetails && typeof rawDetails === "object") {
    for (const [field, kind] of Object.entries(spec.details)) {
      const value = rawDetails[field];
      // Only a value of the field's kind: a nested or malformed one is dropped.
      if (DETAIL_KINDS[kind](value)) (details ??= {})[field] = value;
    }
  }
  const context = contextOf(err.context ?? err);
  const recovery = recoveryFor(reason, { operation, recordedState });
  return {
    version: PUBLIC_ERROR_VERSION,
    reason,
    category,
    message,
    ...(details ? { details } : {}),
    ...(context ? { context } : {}),
    recovery,
    ...(requestRef ? { requestRef } : {}),
    retryable: recovery.action === "retry-same-key",
  };
};
