// The broker's Learnosity Data API client (the only place that calls it on
// the brokered path). Only a recognized success returns. Only a recognized
// rejection (a 2xx or 4xx whose Learnosity body says meta.status false)
// throws ProviderRejected. Anything else (network error, timeout, 5xx, a 4xx
// such as 499 without a Learnosity body, an unreadable or unrecognized body)
// throws a plain Error, which the broker records as uncertain, never as
// failed.

import { ProviderRejected } from "./operations.js";

export const buildLearnosityDataApi = ({ baseUrl, fetch: doFetch = fetch }) => async ({ route, request }) => {
  const res = await doFetch(`${baseUrl}${route}`, { method: "POST", body: new URLSearchParams(request) });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // fall through with a null body
  }
  const answered = res.ok || (res.status >= 400 && res.status < 500);
  if (answered && data?.meta?.status === false) {
    throw new ProviderRejected(`Learnosity Data API rejected: ${res.status} ${route}`);
  }
  if (res.ok && data?.meta?.status === true) return data;
  throw new Error(`Learnosity Data API unrecognized response: ${res.status} ${route}`);
};
