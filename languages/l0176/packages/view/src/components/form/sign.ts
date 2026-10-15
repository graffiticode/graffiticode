// SPDX-License-Identifier: MIT
// Signs an activity the Form has resolved, through L0176's own language
// server: `POST /compile { code: init data {}, data: <activity> }`, as
// L0158's View posted its second `init data {}` compile (l0158
// packages/app/lib/swr/fetchers.js initRequest, lib/api.js postLangCompile).
//
// The compile carries no connection and no user token, so L0176 signs it
// under the system preview session (Broker, for l0176.graffiticode.org, the
// domain Learnosity checks against the page). `init` evaluates to the signed
// request, which has no `type`; the Form renders `{ type: activity.type,
// request }`. When signing is unavailable L0176 answers, by design, with no
// error and the activity carrying `signing: { unsigned, message }`.
import type { CompileError } from "@graffiticode/l0000-view";

// `init data {}..`, as @graffiticode/parser emits it (language 0176).
export const INIT_DATA_CODE = {
  3: { tag: "RECORD", elts: [] },
  6: { tag: "DATA", elts: [3] },
  8: { tag: "INIT", elts: [6] },
  10: { tag: "EXPRS", elts: [8] },
  11: { tag: "PROG", elts: [10] },
  root: 11,
};

export const UNSIGNED_MESSAGE = "This preview couldn't be signed.";

/** L0176's language server: the /form's own host in production, :50176 in dev. */
export function getLangUrl(): string {
  const host = window.document.location.host;
  return host.indexOf("localhost") === 0 ? "http://localhost:50176" : "https://l0176.graffiticode.org";
}

export interface SignResult {
  request?: any;
  message?: string;
  errors?: CompileError[];
}

const isPlainObject = (v: any): boolean => v !== null && typeof v === "object" && !Array.isArray(v);

export async function signActivity(activity: { type: string; data: any }, langUrl: string = getLangUrl()): Promise<SignResult> {
  let out: any;
  try {
    const resp = await fetch(`${langUrl}/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Only the activity: never a request or signing note it arrived with.
      body: JSON.stringify({ code: INIT_DATA_CODE, data: { type: activity.type, data: activity.data } }),
    });
    out = await resp.json();
  } catch (e: any) {
    return { message: `${UNSIGNED_MESSAGE} (${String(e?.message ?? e)})` };
  }
  if (Array.isArray(out?.errors) && out.errors.length > 0) {
    return {
      errors: out.errors.map((e: any) => (typeof e === "string" ? { message: e } : { ...e, message: String(e?.message ?? e) })),
    };
  }
  const data = out?.data;
  if (!isPlainObject(data)) {
    return { message: out?.error ? `${UNSIGNED_MESSAGE} (${String(out.error?.message ?? out.error)})` : UNSIGNED_MESSAGE };
  }
  // Unsigned: the activity came back, with or without a reason.
  if (data.signing !== undefined || (typeof data.type === "string" && isPlainObject(data.data))) {
    const message = typeof data.signing?.message === "string" && data.signing.message ? data.signing.message : UNSIGNED_MESSAGE;
    return { message };
  }
  return { request: data };
}
