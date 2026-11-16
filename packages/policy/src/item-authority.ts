// Item authority (docs/c5-l0013-commands-plan.md decision 3): who may act on
// one console item, decided by the console's own item store and asked over
// its internal route, `POST /api/internal/item-authority { itemId }`, as
// Policy's own service account. The route answers
//   { exists: false }
//   { exists: true, ownerUid, isPublic, taskId, lang }
//   { ambiguous: true }            (the id is held under two owners)
// and Policy decides from it:
//   - a private item, only its owner;
//   - a public item, also anyone else, under the registry's public-capture
//     exception for the function (decision 4), recorded as such.
// No answer (unreachable, a non-2xx, a malformed body, a timeout) is
// `item-authority-unavailable`: temporary, and never allowing.
//
//   lookup(itemId, { signal? }) -> answer   throws ItemAuthorityUnavailable

import { protectedFunctionsForLang } from "@graffiticode/common/protected-registry";
import { ANONYMOUS_SUBJECT } from "./provenance.js";

export class ItemAuthorityUnavailable extends Error {}

// An item id as a scope names it (contract.ts SCOPE_ID).
export const ITEM_ID_RE = /^[A-Za-z0-9_:.-]{1,200}$/;
export const ITEM_AUTHORITY_TIMEOUT_MS = 5000;

const answerOf = body => {
  if (body && body.ambiguous === true) return { ambiguous: true };
  if (body && body.exists === false) return { exists: false };
  if (body && body.exists === true && typeof body.ownerUid === "string" && body.ownerUid && typeof body.isPublic === "boolean") {
    return { exists: true, ownerUid: body.ownerUid, isPublic: body.isPublic, taskId: typeof body.taskId === "string" ? body.taskId : null, lang: typeof body.lang === "string" ? body.lang : null };
  }
  return null;
};

// Over HTTP: the route's URL, and an ID token for its audience (the console
// checks the token is policy-run's).
export const buildItemAuthority = ({ url, audience = url, idToken, fetch: doFetch = fetch, timeoutMs = ITEM_AUTHORITY_TIMEOUT_MS }) => {
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error("buildItemAuthority needs the route's URL");
  return async (itemId: string, { signal }: { signal?: AbortSignal } = {}) => {
    if (typeof itemId !== "string" || !ITEM_ID_RE.test(itemId)) throw new Error("not an item id");
    let res;
    try {
      const token = await idToken(audience);
      const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
      res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ itemId }),
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      throw new ItemAuthorityUnavailable(`item authority unreachable: ${String(e?.name || e?.message || e)}`);
    }
    if (!res.ok) throw new ItemAuthorityUnavailable(`item authority answered ${res.status}`);
    let body;
    try {
      body = await res.json();
    } catch {
      throw new ItemAuthorityUnavailable("item authority answered with no JSON");
    }
    // The console's envelope ({ status, data }) or the answer itself.
    const answer = answerOf(body?.data ?? body);
    if (!answer) throw new ItemAuthorityUnavailable("item authority answered something else");
    return answer;
  };
};

// For tests and embedders: items by id, `{ ownerUid, isPublic, taskId?, lang? }`,
// or `"ambiguous"`. `unavailable` makes every lookup fail.
export const createMemoryItemAuthority = (items: Record<string, unknown> = {}) => {
  const state = { items: new Map(Object.entries(items)), unavailable: false, lookups: [] as string[] };
  const lookup = async (itemId: string) => {
    state.lookups.push(itemId);
    if (state.unavailable) throw new ItemAuthorityUnavailable("unavailable");
    const item = state.items.get(itemId) as any;
    if (item === undefined) return { exists: false };
    if (item === "ambiguous") return { ambiguous: true };
    return { exists: true, ownerUid: item.ownerUid, isPublic: item.isPublic === true, taskId: item.taskId ?? null, lang: item.lang ?? null };
  };
  return Object.assign(lookup, { state });
};

// May `uid` (a user, or ANONYMOUS_SUBJECT) act on this item through `fn` of
// `lang`? Returns { refusal } or { owner: true } or { publicCapture: true }.
// Only an owner acts on a private item; a public one is open to anyone else
// only under the function's public-capture exception. Anonymous callers are
// never owners.
export type ItemAccess = {
  refusal?: string;
  owner?: boolean;
  publicCapture?: boolean;
  ownerUid?: string;
  isPublic?: boolean;
  taskId?: string | null;
};
export const itemAccess = async (lookup, { itemId, uid, lang, fn }): Promise<ItemAccess> => {
  if (!lookup) return { refusal: "item-authority-unavailable" };
  let answer;
  try {
    answer = await lookup(itemId);
  } catch {
    return { refusal: "item-authority-unavailable" };
  }
  if (answer.ambiguous) return { refusal: "item-ambiguous" };
  if (!answer.exists) return { refusal: "item-not-found" };
  // The item's publicity and task as the authority answered them: a private
  // capture's render grant pins that task (C5, render grants).
  const item = { ownerUid: answer.ownerUid, isPublic: answer.isPublic === true, taskId: typeof answer.taskId === "string" ? answer.taskId : null };
  if (uid !== ANONYMOUS_SUBJECT && answer.ownerUid === uid) return { owner: true, ...item };
  const exception = protectedFunctionsForLang(lang)?.[fn]?.publicCapture;
  if (answer.isPublic && exception) return { publicCapture: true, ...item };
  return { refusal: "not-owner" };
};
