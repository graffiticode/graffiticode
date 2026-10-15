// SPDX-License-Identifier: MIT
//
// L0176's brokered path: when a compile selects a connection, every
// Learnosity authority (preview signing and item-bank writes) is
// exercised by the credential broker under policy-issued tokens, and the
// compiler never holds a credential. Without a selected connection, previews
// are still signed by the broker, through a SYSTEM preview session policy
// issues on a Graffiticode-owned connection (POST /v1/preview-session); that
// session can sign a preview and nothing else. The compiler holds no
// Learnosity secret on either path.
//
// The declarations below drive the compiler's early admission only. Authority
// itself is decided by policy and the broker from the reviewed registry
// (graffiticode packages/common/src/protected-registry.js); these must agree
// with it, and disagreeing can only cause refusals, never extra authority.

import type { ExecContext, Invoker } from "@graffiticode/l0000";

export const PROTECTED_FUNCTIONS = Object.freeze({
  INIT: { fn: "init", kind: "sign" as const },
  SAVE_TO_ITEMBANK: { fn: "save-to-itembank", kind: "write" as const },
});

// Every render is signed in PROG, so preview is required by every brokered
// compile.
export const IMPLICIT_PROTECTED_FUNCTIONS = Object.freeze([{ fn: "init", kind: "sign" as const }]);

// The fields a preview may carry to the broker, which refuses anything else.
const PREVIEW_KEYS = ["id", "name", "questions", "session_id", "dynamic_content_data"];

const pick = (obj: any, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));

const isPlainObject = (v: any) => v !== null && typeof v === "object" && !Array.isArray(v);
// Broker's isRef (graffiticode packages/broker/src/operations.ts); keep in step.
const isRef = (v: any) => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,250}$/.test(v);

const describeValue = (v: any) =>
  v === undefined ? "nothing" : v === null ? "null" : Array.isArray(v) ? "a list" :
  typeof v !== "object" ? `a ${typeof v}` : "type" in v ? `a "${String(v.type)}" record` :
  "a record with no type (a bare signed request is not an activity)";

const NOT_AN_ACTIVITY =
  "Error: init signs a Learnosity activity, `{ type: \"questions\" | \"items\", data: { questions, ... } }`; it was given ";

// Why `init` can't sign this value, or null when it can. `init` signs an
// activity arriving as data (an upstream compile's output, or a View's
// resolved activity): exactly what Broker's validatePreview accepts, checked
// here so a refusal is a compile error, not an unsigned preview. Nothing is
// adapted: a legacy `{ type, reference, data }` question, a bare signed
// request or any other value is refused.
export function activityRefusal(plain: any): string | null {
  if (!isPlainObject(plain) || (plain.type !== "questions" && plain.type !== "items") || !isPlainObject(plain.data)) {
    return NOT_AN_ACTIVITY + describeValue(plain) + ".";
  }
  const { questions } = plain.data;
  if (!Array.isArray(questions)) {
    return "Error: init: the activity's data.questions must be a list.";
  }
  const bad = questions.findIndex((q: any) => !isPlainObject(q) || typeof q.type !== "string" || !isRef(q.response_id));
  if (bad >= 0) {
    return `Error: init: questions[${bad}] needs a type and response_id. ` +
      "A legacy `{ type, reference, data }` question record is not accepted; recompile the program that made it.";
  }
  return null;
}

// The activity with any signing envelope it arrived with removed: an
// incoming `request` (signed elsewhere, perhaps for another domain) is never
// passed through, and a stale `signing` never outlives a new signature.
export const withoutSigning = (plain: any) => {
  const { request: _request, signing: _signing, ...activity } = plain;
  return activity;
};

export const isBrokered = (exec: ExecContext | undefined): exec is ExecContext =>
  Boolean(exec?.connectionId && exec.sessionToken);

// --- System preview sessions (compiles with no user connection) ---

export interface PreviewSession {
  allowed: string[];
  sessionToken: string;
}

// What the api wires in: a way to ask policy for a system preview session,
// and the same mint-then-broker invoker the connection path uses.
export interface SystemPreviewClient {
  getPreviewSession(args: { langID: string }): Promise<PreviewSession>;
  invoke: Invoker;
}

// Only preview signing ever runs on a system session, whatever a response
// claims; writes stay connection-only (they check
// isBrokered, which a system session never satisfies: it has no connection).
const SYSTEM_PREVIEW_FN = "init";

// Why a preview went out unsigned, reported beside the activity (never a
// compile error, so the item still compiles and the rest of the output is
// usable).
export interface UnsignedPreview {
  unsigned: string;
  message: string;
}

// The viewer-facing text for the system signing limits (plan
// system-preview-rate-limit): Policy's per-instance mint bucket refuses
// `rate-limited`, Broker's per-session allowance `session-exhausted`. The
// View shows the same words for the api's 429.
export const BUSY_MESSAGE = "Previews are busy right now; try again in a moment.";

// Refusals that mean the system signing limits are reached, not that signing
// is broken: each becomes its own unsigned reason, with the busy message.
const BUSY_REASONS = new Set(["rate-limited", "session-exhausted"]);

const UNSIGNED_MESSAGES: Record<string, string> = {
  "not-configured": "Preview not signed: this server has no system preview signing configured. Select a Learnosity connection to sign it.",
  unavailable: "Preview not signed: no system preview session is available. Select a Learnosity connection to sign it.",
  "signing-failed": "Preview not signed: the system preview signing failed. Select a Learnosity connection to sign it.",
  "gateway-only": "Preview not signed: a preview without a connection is signed only through the Graffiticode api. Select a Learnosity connection to sign it.",
  "rate-limited": BUSY_MESSAGE,
  "session-exhausted": BUSY_MESSAGE,
};

export const unsignedPreview = (unsigned: string, reason?: string): UnsignedPreview => ({
  unsigned,
  message: UNSIGNED_MESSAGES[unsigned] + (reason ? ` (${reason})` : ""),
});

// A refusal as the unsigned preview it becomes: a busy limit under its own
// reason, anything else under `fallback` with the reason appended. The
// reason is a ProtectedCallError's `reason` (policy or the broker refused
// the call) or a refused outcome's `code` (ProtectedFailure).
const unsignedFor = (fallback: string, e: any): UnsignedPreview => {
  const reason = text(e?.reason) ?? text(e?.code);
  return reason && BUSY_REASONS.has(reason) ? unsignedPreview(reason) : unsignedPreview(fallback, reason);
};

// One system session per compile, shared by every signing in it (INIT and
// PROG may both sign). Keyed by the invocation's ExecContext.
const systemSessions = new WeakMap<ExecContext, Promise<UnsignedPreview | null>>();

// Installs a system preview session on this compile's ExecContext, once.
// Resolves to null when installed, or to the reason signing cannot happen.
// Only for compiles with no connection: a connection compile has its own
// session and never reaches here.
//
// `permitted` is the server's decision that this compile may sign on the
// system path at all (gateway-only, plan system-preview-rate-limit): true
// only when the request's `X-Caller-Identity` verified as the api's, or the
// server runs with SYSTEM_PREVIEW_DIRECT=1. It is fixed by the compile's
// dispatch (L0176Compiler.compile), never by program input or a request
// body. Without it policy is never asked, and the preview goes out unsigned,
// `gateway-only`.
export function ensureSystemPreviewSession(
  exec: ExecContext | undefined,
  client: SystemPreviewClient | null,
  permitted = false,
): Promise<UnsignedPreview | null> {
  if (!exec || exec.connectionId) {
    return Promise.resolve(unsignedPreview("not-configured"));
  }
  let pending = systemSessions.get(exec);
  if (!pending) {
    pending = (async () => {
      if (!client) return unsignedPreview("not-configured");
      if (permitted !== true) return unsignedPreview("gateway-only");
      let session: PreviewSession;
      try {
        session = await client.getPreviewSession({ langID: "0176" });
      } catch (e: any) {
        return unsignedFor("unavailable", e);
      }
      if (!session || typeof session.sessionToken !== "string" || !Array.isArray(session.allowed) ||
          !session.allowed.includes(SYSTEM_PREVIEW_FN)) {
        return unsignedPreview("unavailable", "no-preview-permission");
      }
      exec.setSessionToken(session.sessionToken);
      exec.setSnapshot(Object.freeze({ allowed: Object.freeze([SYSTEM_PREVIEW_FN]) }));
      exec.bindInvoker(client.invoke);
      return null;
    })();
    systemSessions.set(exec, pending);
  }
  return pending;
}

// Signs a questions/items preview through the system session. Returns the
// activity with `request`, or with `signing: { unsigned, message }` when it
// cannot be signed. Never throws for a signing failure: Policy's
// `rate-limited` (at the mint) and Broker's `session-exhausted` (at execute)
// come back as `signing: { unsigned: <reason>, message: BUSY_MESSAGE }`.
export async function systemPreviewSign(
  exec: ExecContext | undefined,
  client: SystemPreviewClient | null,
  plain: any,
  occurrenceKey: string,
  permitted = false,
): Promise<any> {
  const refusal = await ensureSystemPreviewSession(exec, client, permitted);
  if (refusal) {
    return { ...plain, signing: refusal };
  }
  try {
    const request = await brokeredSign(exec as ExecContext, plain, occurrenceKey);
    return request ? { ...plain, request } : plain;
  } catch (e: any) {
    return { ...plain, signing: unsignedFor("signing-failed", e) };
  }
}

// An uncertain write may or may not have landed. Retrying with the same
// idempotency key keeps returning this; only the caller may decide to run it
// again, knowing it may repeat.
const UNCERTAIN_GUIDANCE =
  " — it may or may not have been written. Check the item bank; to save again anyway, " +
  "rerun with a new idempotency key (the write may repeat).";

// A protected call that did not succeed, with what the caller needs beside
// the message (spec FAIL-01): the reason as `code`, its category, and the
// function and step that failed. Policy and the broker supply them; an older
// service may not, and then they are absent.
export class ProtectedFailure extends Error {
  code?: string;
  category?: string;
  fn?: string;
  step?: string;
  constructor(message: string, { code, category, fn, step }: { code?: string; category?: string; fn?: string; step?: string } = {}) {
    super(message);
    this.code = code;
    this.category = category;
    this.fn = fn;
    this.step = step;
  }
}

const text = (v: unknown) => (typeof v === "string" && v ? v : undefined);

const expectSucceeded = (out: any, what: string, fn: string) => {
  if (out?.status !== "succeeded") {
    const detail = out?.error ? `: ${out.error}` : "";
    const guidance = out?.status === "uncertain" ? UNCERTAIN_GUIDANCE : "";
    throw new ProtectedFailure(`${what} ${out?.status ?? "failed"}${detail}${guidance}`, {
      code: text(out?.reason),
      category: text(out?.category),
      fn,
      step: text(out?.failedStep),
    });
  }
  return out.result;
};

// A refusal from policy or the broker (ProtectedCallError: reason, category)
// names the function it refused.
const invoking = async (exec: ExecContext, call: any) => {
  try {
    return await exec.invoke(call);
  } catch (e: any) {
    if (e && typeof e === "object" && e.fn === undefined) e.fn = call.fn;
    throw e;
  }
};

// A compile error for a failed protected call: the same message as always,
// plus its code, category, stage, function and step when it has them. An
// error with none of these (not from a protected call) stays a plain message.
export function protectedError(e: any, exec?: ExecContext): any {
  const message = `Error: ${String((e && e.message) || e)}`;
  const code = text(e?.code) ?? text(e?.reason);
  const fn = text(e?.fn);
  if (!code && !fn) {
    return message;
  }
  return Object.fromEntries(Object.entries({
    message,
    from: -1,
    to: -1,
    code,
    category: text(e?.category),
    stage: text(exec?.stage),
    fn,
    step: text(e?.step),
  }).filter(([, v]) => v !== undefined));
}

// Signs a `{ type, data }` activity through the broker. Returns the signed
// request, or undefined for a value that is not a Learnosity activity.
export async function brokeredSign(exec: ExecContext, plain: any, occurrenceKey: string): Promise<any> {
  let call;
  switch (plain?.type) {
  case "questions":
    call = { fn: "init", op: "learnosity.sign-questions-preview", payload: pick(plain.data, PREVIEW_KEYS) };
    break;
  case "items":
    call = { fn: "init", op: "learnosity.sign-items-preview", payload: pick(plain.data, PREVIEW_KEYS) };
    break;
  default:
    return undefined;
  }
  const out = await invoking(exec, { ...call, occurrenceId: exec.nextOccurrence(occurrenceKey) });
  return expectSucceeded(out, "Learnosity signing", call.fn).request;
}

// Writes a save plan through the broker. A retry of the same invocation (same
// idempotency key) returns the recorded outcome instead of writing again; a
// save whose outcome is uncertain or partial is reported, never silently
// re-run.
export async function brokeredSave(exec: ExecContext, plan: any, occurrenceKey: string): Promise<any> {
  let out;
  try {
    out = await invoking(exec, {
      fn: "save-to-itembank",
      op: "learnosity.write-items",
      payload: plan,
      occurrenceId: exec.nextOccurrence(occurrenceKey),
    });
  } catch (e: any) {
    // The broker was asked to write and its answer was lost: as uncertain as
    // an uncertain outcome, and the caller is told the same.
    if (e?.effectUnknown === true) {
      throw new ProtectedFailure(`Item bank save uncertain: ${e.message}${UNCERTAIN_GUIDANCE}`, { fn: "save-to-itembank" });
    }
    throw e;
  }
  const result = expectSucceeded(out, "Item bank save", "save-to-itembank");
  return out.replayed ? { ...result, replayed: true } : result;
}
