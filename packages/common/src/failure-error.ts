// One base class for a failure with a reason (error handling proposal,
// step 2). Nothing imports it yet (PR 2a): the existing classes in errors.ts,
// and helpers such as checkArgument, stay as they are. A subclass is added
// only when a caller must catch it separately.
import { classify, FAILURE_CATEGORIES, type FailureCategory } from "./failures.js";

// Where a failure happened, as far as a caller may be told: a language, a
// chain stage, a protected function or a provider step.
export type FailureContext = Readonly<{ lang?: string, stage?: string, fn?: string, step?: string }>;
const CONTEXT_FIELDS = ["lang", "stage", "fn", "step"] as const;

export type FailureOptions = {
  // The internal message: logs and causes only, never a public response.
  message?: string;
  // A safe message a caller may be shown (public-error.ts prefers the
  // reason's own, from its spec).
  publicMessage?: string;
  // The category, when it was decided where the failure was read (a refusal
  // with no reason takes its status's). Otherwise the reason's.
  category?: FailureCategory;
  details?: Readonly<Record<string, unknown>>;
  context?: FailureContext;
  statusCode?: number;
  cause?: unknown;
};

const isCategory = (value: unknown): value is FailureCategory =>
  typeof value === "string" && (FAILURE_CATEGORIES as readonly string[]).includes(value);

// Only the known context fields, and only strings.
export const contextOf = (value: unknown): FailureContext | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const field of CONTEXT_FIELDS) {
    const v = (value as Record<string, unknown>)[field];
    if (typeof v === "string" && v) out[field] = v;
  }
  return Object.keys(out).length ? Object.freeze(out) : undefined;
};

export class FailureError extends Error {
  declare reason: string;
  declare category: FailureCategory;
  declare publicMessage: string | undefined;
  declare details: Readonly<Record<string, unknown>> | undefined;
  declare context: FailureContext | undefined;
  declare statusCode: number | undefined;

  constructor(reason: string, { message, publicMessage, category, details, context, statusCode, cause }: FailureOptions = {}) {
    super(message ?? reason, cause === undefined ? undefined : { cause });
    this.name = "FailureError";
    this.reason = reason;
    this.category = isCategory(category) ? category : classify(reason).category;
    this.publicMessage = publicMessage;
    this.details = details;
    this.context = contextOf(context);
    this.statusCode = statusCode;
  }
}

// A failure with more context. A FailureError keeps its reason, category,
// details, status and cause, and gains the context: it is copied, never
// wrapped in another FailureError, so a chain of wraps stays one level deep.
// Anything else becomes a FailureError whose cause it is, with its own string
// `reason` if it has one; without one the reason is `internal`, which is
// unregistered, so it reaches a caller only as its category.
export const wrap = (err: unknown, context: FailureContext = {}): FailureError => {
  if (err instanceof FailureError) {
    const merged = contextOf({ ...(err.context ?? {}), ...context });
    const same = JSON.stringify(merged ?? null) === JSON.stringify(err.context ?? null);
    if (same) return err;
    const copy = new FailureError(err.reason, {
      message: err.message,
      publicMessage: err.publicMessage,
      category: err.category,
      details: err.details,
      context: merged,
      statusCode: err.statusCode,
      cause: err.cause,
    });
    copy.stack = err.stack;
    return copy;
  }
  const reason = typeof (err as { reason?: unknown })?.reason === "string" ? (err as { reason: string }).reason : "internal";
  const message = err instanceof Error ? err.message : String(err);
  return new FailureError(reason, { message, context, cause: err });
};
