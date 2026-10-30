// SPDX-License-Identifier: MIT
// The api host the View loads data from: the local api in dev, api.graffiticode.org otherwise.
export function getApiUrl(): string {
  const host = window.document.location.host;
  return host.indexOf("localhost") === 0 ? "http://localhost:3100" : "https://api.graffiticode.org";
}
