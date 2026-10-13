// SPDX-License-Identifier: MIT
/** Shared test harness: parse with the real parser against the real lexicon, then compile. */
import { parser } from "@graffiticode/parser";
import { compiler, lexicon } from "./index.js";

/** Compile `src`, appending the `..` terminator if it is missing. */
export async function compile(src: string, data: any = {}): Promise<any> {
  const code: any = await parser.parse(184, src.trim().endsWith("..") ? src : `${src}..`, lexicon);
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
