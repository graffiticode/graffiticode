// SPDX-License-Identifier: MIT
// Client for the Graffiticode data/compile API. Uses the platform API host derived from
// the page's location (local console in dev, api.graffiticode.org in prod).

function getApiUrl(): string {
  const host = window.document.location.host;
  return host.indexOf("localhost") === 0
    ? "http://localhost:3100"
    : "https://api.graffiticode.org";
}

// `connection` views the caller's stored result for the item through that
// connection; `publication` views a published item's stored result. Either
// way the gateway serves a stored result and never runs the program.
export const getApiData = async ({
  accessToken,
  id,
  connection,
  publication,
}: {
  accessToken?: string;
  id: string;
  connection?: string;
  publication?: string;
}) => {
  const query = new URLSearchParams({ id });
  if (connection) query.set("connection", connection);
  if (publication) query.set("publication", publication);
  const resp = await fetch(`${getApiUrl()}/data?${query}`, {
    headers: { Authorization: accessToken || "" },
  });
  const { status, error, data } = await resp.json();
  if (status !== "success") {
    throw new Error(`failed to get data ${id}: ${error?.message}`);
  }
  return data;
};

export const postApiCompile = async ({
  accessToken,
  id,
  data,
}: {
  accessToken?: string;
  id: string;
  data: any;
}) => {
  const resp = await fetch(`${getApiUrl()}/compile`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: accessToken || "",
      "x-graffiticode-storage-type": "persistent",
    },
    body: JSON.stringify({ id, data }),
  });
  const out = await resp.json();
  if (out.status !== "success") {
    throw new Error(`failed to post compile ${id}: ${out.error?.message}`);
  }
  return out.data;
};
