// SPDX-License-Identifier: MIT
/**
 * Shared test harness: parse with the real parser against the real lexicon, then compile, with
 * a fixture fetcher installed — `https://example.org/<file>` and the served sample data
 * `https://l0185.graffiticode.org/data/<file>` both read `data/<file>` (the served sample data), or `fixtures/<file>` for test-only files. Tests never
 * touch the network.
 */
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon, setFetcher } from "./index.js";

const DATA = fileURLToPath(new URL("../data/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** URLs the fixture fetcher was asked for, in order — tests assert deduplication with it. */
export const fetched: string[] = [];

setFetcher(async (url: string) => {
  fetched.push(url);
  // The docs' sample data is served by the language server at /data/<file>; tests read the same files.
  const m = url.match(/^https:\/\/(?:example\.org|l0185\.graffiticode\.org\/data)\/(.+)$/);
  const file = !m ? "" : existsSync(`${DATA}${m[1]}`) ? `${DATA}${m[1]}` : `${FIXTURES}${m[1]}`;
  if (!m || !existsSync(file)) throw new Error(`fetch: fetching ${JSON.stringify(url)} failed: the server answered 404.`);
  const contentType = file.endsWith(".csv") ? "text/csv" : file.endsWith(".html") ? "text/html" : "application/json";
  return { text: readFileSync(file, "utf8"), contentType };
});

/** Compile `src`, appending the `..` terminator if it is missing. */
export async function compile(src: string, data: any = {}): Promise<any> {
  const code: any = await parser.parse(185, src.trim().endsWith("..") ? src : `${src}..`, lexicon);
  const perr: any = Object.values(code).find((n: any) => n && n.tag === "ERROR");
  if (perr) throw new Error(`parse error: ${JSON.stringify(perr.elts)}`);
  return await new Promise((resolve, reject) =>
    compiler.compile(code, data, {}, (e: any, v: any) => {
      const errs = Array.isArray(e) ? e.filter(Boolean) : e ? [e] : [];
      if (errs.length) reject(errs);
      else resolve(v);
    }),
  );
}

/** Compile expecting failure; return the first error message. */
export async function errorOf(src: string, data?: any): Promise<string> {
  try {
    await compile(src, data);
  } catch (e: any) {
    const errs = Array.isArray(e) ? e : [e];
    return String(errs[0]?.message ?? errs[0]);
  }
  throw new Error("expected a compile error, got none");
}
