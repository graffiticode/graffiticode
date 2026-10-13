// SPDX-License-Identifier: MIT
/**
 * Where fetched data comes from. Core never touches the network itself: the API server installs
 * a guarded fetcher (`packages/api/src/fetch.ts`), and the test harness installs fixtures. With
 * none installed, `fetch` is an error rather than an unguarded request.
 */
import Papa from "papaparse";

export interface FetchResult {
  text: string;
  contentType: string;
}

export type Fetcher = (url: string) => Promise<FetchResult>;

let current: Fetcher | null = null;

export function setFetcher(fetcher: Fetcher | null): void {
  current = fetcher;
}

export function getFetcher(): Fetcher {
  if (!current) throw new Error("fetch: fetching is not available here.");
  return current;
}

/** Turn a fetched body into data: by `parse`, else the content type, else a sniff. */
export function parseBody(url: string, body: FetchResult, format?: string): any {
  const ct = (body.contentType || "").toLowerCase();
  const text = body.text.replace(/^\uFEFF/, "");
  const head = text.trimStart().slice(0, 1);
  const html = ct.includes("text/html") || /^<(!doctype|html)/i.test(text.trimStart());
  if (html && format !== "CSV") {
    throw new Error(`fetch: ${JSON.stringify(url)} returned an HTML page, not JSON or CSV.`);
  }
  const kind =
    format ?? (ct.includes("json") ? "JSON" : ct.includes("csv") ? "CSV" : head === "[" || head === "{" ? "JSON" : "CSV");
  if (kind === "JSON") {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`fetch: ${JSON.stringify(url)} is not valid JSON. If it is CSV, write parse CSV to its right.`);
    }
  }
  const parsed = Papa.parse(text, { header: true, dynamicTyping: true, skipEmptyLines: "greedy" });
  if (parsed.errors.length && !parsed.data.length) {
    throw new Error(`fetch: ${JSON.stringify(url)} could not be read as CSV: ${parsed.errors[0].message}.`);
  }
  return parsed.data;
}
