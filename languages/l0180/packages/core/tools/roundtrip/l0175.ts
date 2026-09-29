// SPDX-License-Identifier: MIT
/**
 * Compile an L0175 example with L0175's own compiler.
 *
 * The sibling repo is not a dependency and must not become one: L0180 delivers items, and a
 * delivery language that cannot build without the content language that fed it is the coupling
 * the split exists to avoid. So this loads `l0175/packages/core/dist` by path, and says plainly
 * what is missing when it is not there. Only the fixture step needs it; the comparison itself
 * reads the compiled JSON that this wrote.
 */
import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { parser } from "@graffiticode/parser";

const here = dirname(fileURLToPath(import.meta.url));

/** Where the sibling repo is. `L0175_DIR` overrides the guess that it sits beside this one. */
export const l0175Dir = (): string =>
  resolve(process.env.L0175_DIR || join(here, "../../../../../l0175"));

export const examplesDir = (): string => join(l0175Dir(), "packages/core/spec/examples");

export async function compileExample(name: string): Promise<any> {
  const dist = join(l0175Dir(), "packages/core/dist/index.js");
  let l0175: any;
  try {
    l0175 = await import(dist);
  } catch (e: any) {
    throw new Error(
      `cannot load L0175 from ${dist} — clone it beside this repo and run its build, or set ` +
        `L0175_DIR. (${e?.message ?? e})`,
      { cause: e },
    );
  }
  const src = readFileSync(join(examplesDir(), name.endsWith(".gc") ? name : `${name}.gc`), "utf-8");
  const code: any = await parser.parse(175, src, l0175.lexicon);
  const perr: any = Object.values(code).find((n: any) => n && n.tag === "ERROR");
  if (perr) throw new Error(`L0175 parse error in ${name}: ${JSON.stringify(perr.elts)}`);
  return await new Promise((res, rej) =>
    l0175.compiler.compile(code, {}, {}, (e: any, v: any) => {
      const errs = Array.isArray(e) ? e.filter(Boolean) : e ? [e] : [];
      if (errs.length) rej(new Error(`L0175 compile error in ${name}: ${errs.join("; ")}`));
      else res(v);
    }),
  );
}
