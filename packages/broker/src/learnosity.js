// The broker's Learnosity Data API client (the only place that calls it on
// the brokered path). Throws on any non-success so a write step never reads as
// done when it was not.

export const buildLearnosityDataApi = ({ baseUrl, fetch: doFetch = fetch }) => async ({ route, request }) => {
  const res = await doFetch(`${baseUrl}${route}`, { method: "POST", body: new URLSearchParams(request) });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // fall through with a null body
  }
  if (!res.ok) throw new Error(`Learnosity Data API error: ${res.status} ${route}`);
  if (data?.meta?.status === false) throw new Error(`Learnosity Data API failed: ${route}`);
  return data;
};
