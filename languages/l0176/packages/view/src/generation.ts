// SPDX-License-Identifier: MIT
// The compile generation of the data the api's /form route points at.
//
// The api's /form redirect passes the item's data URL as `?url=`. For an
// L0158 item rendered here (plan l0158-via-l0176) that URL carries
// `generation=<G>`, which scopes the api's compile store and caches so old
// L0158 outputs (Firestore, Redis, CDN and browser caches) are never read.
// The shared View (@graffiticode/l0000-view) builds its own `/data?id=` URL
// and ignores `?url=`, so without this the generation would be dropped and the
// View would load the old, unscoped result.
//
// This SWR middleware, installed around the View by the /form bundle, adds
// that generation to the View's one data load, and nothing else: the request
// still goes to the api host the View uses, with the View's own id,
// credential, connection and publication, and only when the `url` names the
// same id. No other URL is ever fetched. Without a generation the View loads
// exactly as before.
import type { Middleware } from "swr";

export function getApiUrl(): string {
  const host = window.document.location.host;
  return host.indexOf("localhost") === 0 ? "http://localhost:3100" : "https://api.graffiticode.org";
}

/** The generation in the page's `?url=`, if that URL is a /data URL for `id`. */
export function generationFor(search: string, id: string): string | null {
  const raw = new URLSearchParams(search).get("url");
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.pathname !== "/data" || url.searchParams.get("id") !== id) return null;
  const generation = url.searchParams.get("generation");
  return generation ? generation : null;
}

interface DataKey {
  accessToken?: string;
  id: string;
  connection?: string;
  publication?: string;
}

const isDataKey = (key: any): key is DataKey =>
  key !== null && typeof key === "object" && !Array.isArray(key) && typeof key.id === "string" && !("data" in key);

export const getGenerationData = async ({ accessToken, id, connection, publication }: DataKey, generation: string) => {
  const query = new URLSearchParams({ id });
  if (connection) query.set("connection", connection);
  if (publication) query.set("publication", publication);
  query.set("generation", generation);
  const resp = await fetch(`${getApiUrl()}/data?${query}`, {
    headers: { Authorization: accessToken || "" },
  });
  const { status, error, data } = await resp.json();
  if (status !== "success") {
    throw new Error(`failed to get data ${id}: ${error?.message}`);
  }
  return data;
};

export const generationMiddleware =
  (search: string = window.location.search): Middleware =>
  (useSWRNext) =>
  (key, fetcher, config) => {
    const generation = isDataKey(key) ? generationFor(search, key.id) : null;
    const next = generation && fetcher ? (k: any) => getGenerationData(k as DataKey, generation) : fetcher;
    return useSWRNext(key, next, config);
  };
