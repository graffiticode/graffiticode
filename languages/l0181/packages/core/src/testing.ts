// SPDX-License-Identifier: MIT
/** Shared test harness: parse with L0181's lexicon, then compile. Not shipped. */
import { parser } from "@graffiticode/parser";
import { compiler, lexicon } from "./index.js";

/** Compile a program, rejecting with the compiler's error array. */
export async function compile(src: string, data: any = {}): Promise<any> {
  const code: any = await parser.parse(181, src.trim().endsWith("..") ? src : `${src}..`, lexicon);
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

/**
 * The first error message a program produces.
 *
 * Error cases assert on MESSAGE TEXT, not merely that something failed: the program generator
 * is an LLM that reads these messages and retries, so a message that stops naming what was
 * wrong is a regression even though the program still fails.
 */
export async function errorOf(src: string): Promise<string> {
  try {
    const val = await compile(src);
    throw new Error(`expected a compile error, got ${JSON.stringify(val)}`);
  } catch (e: any) {
    if (e instanceof Error) throw e;
    const first = Array.isArray(e) ? e[0] : e;
    return String(first?.message ?? first);
  }
}
