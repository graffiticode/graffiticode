// SPDX-License-Identifier: MIT
// Client for the Graffiticode data/compile API. Uses the platform API host derived from
// the page's location (local console in dev, api.graffiticode.org in prod).

function getApiUrl(): string {
  const host = window.document.location.host;
  return host.indexOf("localhost") === 0
    ? "http://localhost:3100"
    : "https://api.graffiticode.org";
}

// The compile generations named by the data URL the api's /form redirect
// passes as `?url=` (interpreter plan B4): `generation`, L0158's requested
// generation, and `generations`, the switch generations the item's data is
// answered under. They're read only from a /data URL for this same id; no
// other URL is ever fetched. The data load carries them, so its URL (and the
// browser's and the CDN's copy of it) changes whenever they do.
export interface DataGenerations {
  generation?: string;
  generations?: string;
}

export function dataGenerationsFor(search: string, id: string): DataGenerations {
  const raw = new URLSearchParams(search).get("url");
  if (!raw) return {};
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {};
  }
  if (url.pathname !== "/data" || url.searchParams.get("id") !== id) return {};
  const out: DataGenerations = {};
  const generation = url.searchParams.get("generation");
  const generations = url.searchParams.get("generations");
  if (generation) out.generation = generation;
  if (generations) out.generations = generations;
  return out;
}

// `connection` views the caller's stored result for the item through that
// connection; `publication` views a published item's stored result. Either
// way the gateway serves a stored result and never runs the program.
// What a /data load returned: the payload, and the optional staleness deadline
// (`refreshAt`, epoch ms) the api names when the result expires. A fetcher that
// returns a bare payload instead (an older middleware) has no deadline.
export class DataLoad {
  constructor(
    readonly payload: any,
    readonly refreshAt?: number,
  ) {}
}

export const getApiData = async (args: {
  accessToken?: string;
  id: string;
  connection?: string;
  publication?: string;
} & DataGenerations) => (await getApiDataLoad(args)).payload;

export const getApiDataLoad = async ({
  accessToken,
  id,
  connection,
  publication,
  generation,
  generations,
}: {
  accessToken?: string;
  id: string;
  connection?: string;
  publication?: string;
} & DataGenerations) => {
  const query = new URLSearchParams({ id });
  if (connection) query.set("connection", connection);
  if (publication) query.set("publication", publication);
  if (generation) query.set("generation", generation);
  if (generations) query.set("generations", generations);
  const resp = await fetch(`${getApiUrl()}/data?${query}`, {
    headers: { Authorization: accessToken || "" },
  });
  const { status, error, data, refreshAt } = await resp.json();
  if (status !== "success") {
    throw new Error(`failed to get data ${id}: ${error?.message}`);
  }
  const deadline = typeof refreshAt === "string" ? Date.parse(refreshAt) : NaN;
  return new DataLoad(data, Number.isFinite(deadline) ? deadline : undefined);
};

// `generation` is L0158's requested generation from the data URL: recompiles
// stay in the namespace the initial load read (B4).
export const postApiCompile = async ({
  accessToken,
  id,
  data,
  generation,
}: {
  accessToken?: string;
  id: string;
  data: any;
  generation?: string;
}) => {
  const resp = await fetch(`${getApiUrl()}/compile`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: accessToken || "",
      "x-graffiticode-storage-type": "persistent",
    },
    body: JSON.stringify(generation ? { id, data, generation } : { id, data }),
  });
  const out = await resp.json();
  if (out.status !== "success") {
    throw new Error(`failed to post compile ${id}: ${out.error?.message}`);
  }
  return out.data;
};
