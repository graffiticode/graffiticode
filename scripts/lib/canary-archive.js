/* eslint-disable camelcase -- Learnosity wire fields are snake_case */
// Retires the drafts a canary run saved (registry v8 writes new records on
// every save). Learnosity's Data API has no delete or update on items, so each
// item is read back and written again with status "archived", as the AT-10
// harness does. Uses the development organisation's key from the environment
// (LRN_SANDBOX_KEY, LRN_SANDBOX_SECRET, LRN_SANDBOX_DOMAIN); never prints it.

const DATA_API = "https://data.learnosity.com/v2025.2.LTS";

export const createDraftArchiver = ({ sdk, key, secret, domain, fetch: doFetch = fetch, baseUrl = DATA_API }) => {
  const call = async (action, body) => {
    const request = sdk.init("data", { consumer_key: key, domain }, secret, body, action);
    const res = await doFetch(`${baseUrl}/itembank/items`, { method: "POST", body: new URLSearchParams(request), signal: AbortSignal.timeout(30_000) });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (!(res.ok && json?.meta?.status === true)) throw new Error(`Data API ${action} /itembank/items: ${res.status}`);
    return json.data;
  };
  return async references => {
    const rows = (await call("get", { references, limit: references.length })) ?? [];
    const found = (Array.isArray(rows) ? rows : []).filter(r => references.includes(r?.reference));
    if (found.length) await call("set", { items: found.map(r => ({ ...r, status: "archived" })) });
    return { archived: found.length, failed: references.length - found.length, ...(found.length < references.length ? { reason: `${references.length - found.length} not found` } : {}) };
  };
};
