// SPDX-License-Identifier: MIT
//
// L0176's brokered path: when a compile selects a connection, every
// Learnosity authority (preview signing, Author signing, item-bank writes) is
// exercised by the credential broker under policy-issued tokens, and the
// compiler never holds a credential. Without a selected connection, the legacy
// path (program-supplied or server credentials) still applies until it is
// retired.
//
// The declarations below drive the compiler's early admission only. Authority
// itself is decided by policy and the broker from the reviewed registry
// (graffiticode packages/common/src/protected-registry.js); these must agree
// with it, and disagreeing can only cause refusals, never extra authority.

import type { ExecContext } from "@graffiticode/l0000";

export const PROTECTED_FUNCTIONS = Object.freeze({
  INIT: { fn: "preview-itembank", kind: "sign" as const },
  SAVE_TO_ITEMBANK: { fn: "save-to-itembank", kind: "write" as const, modes: ["save" as const] },
  AUTHOR: { fn: "author-itembank", kind: "sign" as const, modes: ["author" as const] },
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
