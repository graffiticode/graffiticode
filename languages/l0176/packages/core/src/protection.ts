// SPDX-License-Identifier: MIT
//
// L0176's brokered path: when a compile selects a connection, every
// Learnosity authority (preview signing, Author signing, item-bank writes) is
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
  INIT: { fn: "preview-itembank", kind: "sign" as const },
  SAVE_TO_ITEMBANK: { fn: "save-to-itembank", kind: "write" as const },
  AUTHOR: { fn: "author-itembank", kind: "sign" as const },
});

// Every render is signed in PROG, so preview is required by every brokered
// compile.
export const IMPLICIT_PROTECTED_FUNCTIONS = Object.freeze([{ fn: "preview-itembank", kind: "sign" as const }]);

// The fields a preview may carry to the broker, which refuses anything else.
const PREVIEW_KEYS = ["id", "name", "questions", "session_id", "dynamic_content_data"];

const pick = (obj: any, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));

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
// claims; writes and Author signing stay connection-only (they check
// isBrokered, which a system session never satisfies: it has no connection).
const SYSTEM_PREVIEW_FN = "preview-itembank";

// Why a preview went out unsigned, reported beside the activity (never a
// compile error, so the item still compiles and the rest of the output is
// usable).
export interface UnsignedPreview {
  unsigned: string;
  message: string;
}

const UNSIGNED_MESSAGES: Record<string, string> = {
  "not-configured": "Preview not signed: this server has no system preview signing configured. Select a Learnosity connection to sign it.",
  unavailable: "Preview not signed: no system preview session is available. Select a Learnosity connection to sign it.",
  "signing-failed": "Preview not signed: the system preview signing failed. Select a Learnosity connection to sign it.",
};

export const unsignedPreview = (unsigned: string, reason?: string): UnsignedPreview => ({
  unsigned,
  message: UNSIGNED_MESSAGES[unsigned] + (reason ? ` (${reason})` : ""),
});

// One system session per compile, shared by every signing in it (INIT and
// PROG may both sign). Keyed by the invocation's ExecContext.
const systemSessions = new WeakMap<ExecContext, Promise<UnsignedPreview | null>>();

// Installs a system preview session on this compile's ExecContext, once.
// Resolves to null when installed, or to the reason signing cannot happen.
// Only for compiles with no connection: a connection compile has its own
// session and never reaches here.
export function ensureSystemPreviewSession(
  exec: ExecContext | undefined,
  client: SystemPreviewClient | null,
): Promise<UnsignedPreview | null> {
  if (!exec || exec.connectionId) {
    return Promise.resolve(unsignedPreview("not-configured"));
  }
  let pending = systemSessions.get(exec);
  if (!pending) {
    pending = (async () => {
      if (!client) return unsignedPreview("not-configured");
      let session: PreviewSession;
      try {
        session = await client.getPreviewSession({ langID: "0176" });
      } catch (e: any) {
        return unsignedPreview("unavailable", typeof e?.reason === "string" ? e.reason : undefined);
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
// cannot be signed. Never throws for a signing failure.
export async function systemPreviewSign(
  exec: ExecContext | undefined,
  client: SystemPreviewClient | null,
  plain: any,
  occurrenceKey: string,
): Promise<any> {
  const refusal = await ensureSystemPreviewSession(exec, client);
  if (refusal) {
    return { ...plain, signing: refusal };
  }
  try {
    const request = await brokeredSign(exec as ExecContext, plain, occurrenceKey);
    return request ? { ...plain, request } : plain;
  } catch (e: any) {
    return { ...plain, signing: unsignedPreview("signing-failed", typeof e?.reason === "string" ? e.reason : undefined) };
  }
}

// An uncertain write may or may not have landed. Retrying with the same
// idempotency key keeps returning this; only the caller may decide to run it
// again, knowing it may repeat.
const UNCERTAIN_GUIDANCE =
  " — it may or may not have been written. Check the item bank; to save again anyway, " +
  "rerun with a new idempotency key (the write may repeat).";

const expectSucceeded = (out: any, what: string) => {
  if (out?.status !== "succeeded") {
    const detail = out?.error ? `: ${out.error}` : "";
    const guidance = out?.status === "uncertain" ? UNCERTAIN_GUIDANCE : "";
    throw new Error(`${what} ${out?.status ?? "failed"}${detail}${guidance}`);
  }
  return out.result;
};

// Signs a `{ type, data }` activity through the broker. Returns the signed
// request, or undefined for a value that is not a Learnosity activity.
export async function brokeredSign(exec: ExecContext, plain: any, occurrenceKey: string): Promise<any> {
  let call;
  switch (plain?.type) {
  case "questions":
    call = { fn: "preview-itembank", op: "learnosity.sign-questions-preview", payload: pick(plain.data, PREVIEW_KEYS) };
    break;
  case "items":
    call = { fn: "preview-itembank", op: "learnosity.sign-items-preview", payload: pick(plain.data, PREVIEW_KEYS) };
    break;
  case "author":
    // The broker builds the Author request itself from the reference alone.
    call = { fn: "author-itembank", op: "learnosity.sign-author", payload: { reference: plain.data?.reference } };
    break;
  default:
    return undefined;
  }
  const out = await exec.invoke({ ...call, occurrenceId: exec.nextOccurrence(occurrenceKey) });
  return expectSucceeded(out, "Learnosity signing").request;
}

// Writes a save plan through the broker. A retry of the same invocation (same
// idempotency key) returns the recorded outcome instead of writing again; a
// save whose outcome is uncertain or partial is reported, never silently
// re-run.
export async function brokeredSave(exec: ExecContext, plan: any, occurrenceKey: string): Promise<any> {
  const out = await exec.invoke({
    fn: "save-to-itembank",
    op: "learnosity.write-items",
    payload: plan,
    occurrenceId: exec.nextOccurrence(occurrenceKey),
  });
  const result = expectSucceeded(out, "Item bank save");
  return out.replayed ? { ...result, replayed: true } : result;
}
