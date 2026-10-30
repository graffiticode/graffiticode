// SPDX-License-Identifier: MIT
// Signs an activity the Form has resolved, through the Graffiticode api's
// stateless `POST /preview/sign { activity }` (plan system-preview-rate-limit).
//
// The api compiles L0176's fixed `init data {}` program with the activity
// inline, as the api, with no connection, so L0176 signs it under the system
// preview session (Broker, for l0176.graffiticode.org, the domain Learnosity
// checks against the page). It stores nothing: not a task, not a compile.
//
// Never L0176's own `/compile`: L0176 signs a no-connection compile only for
// a verified api identity (gateway-only), so a direct one comes back unsigned.
// Never the api's `/compile` either: that stores the posted data as a task,
// public for an anonymous caller, which would publish an activity resolved
// from a private connection artifact.
//
// The api answers `{ request }` (the signed request, which has no `type`; the
// Form renders `{ type: activity.type, request }`), `{ signing: { unsigned,
// message } }` when it can't be signed, or a 4xx (429 when the per-client
// limit is reached).
import type { CompileError } from "@graffiticode/l0000-view";
import { getApiUrl } from "../../api-url";

export const UNSIGNED_MESSAGE = "This preview couldn't be signed.";

/** The system signing limits are reached: Policy's `rate-limited`, Broker's `session-exhausted`, or the api's 429. */
export const BUSY_MESSAGE = "Previews are busy right now; try again in a moment.";
const BUSY_REASONS = new Set(["rate-limited", "session-exhausted"]);

/** The api's signing endpoint: the api host the View loads data from. */
export const getSignUrl = (apiUrl: string = getApiUrl()): string => `${apiUrl}/preview/sign`;

export interface SignResult {
  request?: any;
  message?: string;
  errors?: CompileError[];
}

const isPlainObject = (v: any): boolean => v !== null && typeof v === "object" && !Array.isArray(v);

const detail = (error: any): string => String(error?.message ?? error);

export async function signActivity(activity: { type: string; data: any }, apiUrl: string = getApiUrl()): Promise<SignResult> {
  let resp: any;
  let out: any = null;
  try {
    resp = await fetch(getSignUrl(apiUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Only the activity: never a request or signing note it arrived with,
      // and no connection or user credential.
      body: JSON.stringify({ activity: { type: activity.type, data: activity.data } }),
    });
  } catch (e: any) {
    return { message: `${UNSIGNED_MESSAGE} (${detail(e)})` };
  }
  if (resp?.status === 429) {
    return { message: BUSY_MESSAGE };
  }
  try {
    out = await resp.json();
  } catch {
    // An unreadable body is handled below as "couldn't be signed".
  }
  // The platform's `{ status: "success", data }` envelope, if the api uses it.
  if (out?.status === "success" && isPlainObject(out.data)) {
    out = out.data;
  }
  if (Array.isArray(out?.errors) && out.errors.length > 0) {
    return {
      errors: out.errors.map((e: any) => (typeof e === "string" ? { message: e } : { ...e, message: detail(e) })),
    };
  }
  const reason = out?.signing?.unsigned ?? out?.error?.reason;
  if (typeof reason === "string" && BUSY_REASONS.has(reason)) {
    return { message: BUSY_MESSAGE };
  }
  if (resp?.ok === false) {
    return { message: out?.error ? `${UNSIGNED_MESSAGE} (${detail(out.error)})` : `${UNSIGNED_MESSAGE} (${resp.status})` };
  }
  if (isPlainObject(out?.request)) {
    return { request: out.request };
  }
  // Unsigned, with or without a reason.
  const message = typeof out?.signing?.message === "string" && out.signing.message ? out.signing.message : UNSIGNED_MESSAGE;
  return { message };
}
