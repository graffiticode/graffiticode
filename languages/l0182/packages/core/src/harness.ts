// SPDX-License-Identifier: MIT
/** Shared test harness: parse with the real parser, then compile. */
import { parser } from "@graffiticode/parser";
import { compiler, lexicon } from "./index.js";

/**
 * Public values are folded into the AST at PARSE time, so `get-val-public "itemId"` reaches the
 * compiler as the value itself. The console supplies the item id; tests supply whatever they
 * are testing with, and a program that reads a name nothing answers gets an empty string —
 * which `session-id` treats as no session, exactly as an unresolved value should behave.
 */
export function publicValues(values: Record<string, string> = {}) {
  return { GET_VAL_PUBLIC: (name: string) => values[name] ?? "" };
}

export async function compile(src: string, values?: Record<string, string>): Promise<any> {
  const code: any = await parser.parse(
    182,
    src.trim().endsWith("..") ? src : `${src}..`,
    lexicon,
    publicValues(values),
  );
  const perr: any = Object.values(code).find((n: any) => n && n.tag === "ERROR");
  if (perr) throw new Error(`parse error: ${JSON.stringify(perr.elts)}`);
  return await new Promise((resolve, reject) =>
    compiler.compile(code, {}, {}, (e: any, v: any) => {
      const errs = Array.isArray(e) ? e.filter(Boolean) : e ? [e] : [];
      if (errs.length) reject(errs);
      else resolve(v);
    }),
  );
}

/** Compile expecting failure; return the first error message. */
export async function errorOf(src: string, values?: Record<string, string>): Promise<string> {
  try {
    await compile(src, values);
  } catch (e: any) {
    const errs = Array.isArray(e) ? e : [e];
    return String(errs[0]?.message ?? errs[0]);
  }
  throw new Error("expected a compile error, got none");
}
