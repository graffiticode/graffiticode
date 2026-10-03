// The broker's Learnosity Data API client (the only place that calls it on
// the brokered path). Only a recognized success returns. Only a recognized
// rejection (a 2xx or 4xx whose Learnosity body says meta.status false)
// throws ProviderRejected. Anything else (network error, timeout, 5xx, a 4xx
// such as 499 without a Learnosity body, an unreadable or unrecognized body)
// throws a plain Error, which the broker records as uncertain, never as
// failed. A request still unanswered after `timeoutMs` is abandoned; that is
// a timeout, so it is uncertain too.

import { ProviderRejected } from "./operations.js";

export const buildLearnosityDataApi = ({ baseUrl, fetch: doFetch = fetch }) => async ({ route, request, timeoutMs }) => {
  if (!(Number.isInteger(timeoutMs) && timeoutMs > 0)) throw new Error("a provider call needs a positive timeout");
  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await doFetch(`${baseUrl}${route}`, { method: "POST", body: new URLSearchParams(request), signal });
  } catch (e) {
    // Network failure or timeout (an abort is a DOMException): uncertain.
    throw new Error(`Learnosity Data API request failed: ${e?.name || "error"} ${route}`);
  }
  let data = null;
  try {
    // Reading the body is part of the call: the same signal bounds it.
    data = await res.json();
  } catch {
    // fall through with a null body (an abort lands here too, and is
    // uncertain below)
  }
  const answered = res.ok || (res.status >= 400 && res.status < 500);
  // @ts-expect-error TS-MIGRATE: parsed JSON response is untyped
  if (answered && data?.meta?.status === false) {
    throw new ProviderRejected(`Learnosity Data API rejected: ${res.status} ${route}`);
  }
  // @ts-expect-error TS-MIGRATE: parsed JSON response is untyped
  if (res.ok && data?.meta?.status === true) return data;
  throw new Error(`Learnosity Data API unrecognized response: ${res.status} ${route}`);
};
