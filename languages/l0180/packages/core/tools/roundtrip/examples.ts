// SPDX-License-Identifier: MIT
/**
 * Which L0175 items the round trip runs over, and how to load each side of one.
 *
 * Separate from `run.ts` so the offline gate imports the corpus without importing a CLI —
 * a test that has to defeat an entry point's main() is a test that will one day run it.
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon } from "../../src/index.js";
import { readSourceItem, type SourceItem } from "./source.js";

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURES = join(here, "fixtures");
export const GENERATED = join(here, "generated");

/**
 * One example per delivered shape, drawn from three targets so the passages differ.
 * `L0175-CONFORMANCE.md` asks for T4, T9 and T8 so both hot-text shapes and both answer kinds
 * appear; these five cover every type in L0175's SCORING map.
 */
export const EXAMPLES = [
  "c1-t8-tm1-multiplechoice",
  "c1-t9-tm2-multiselect",
  "c1-t4-tm1-ebsr",
  "c1-t8-tm3-hottext",
  "c1-t9-tm5-shorttext",
];

export const fixturePath = (name: string) => join(FIXTURES, `${name}.l0175.json`);
export const generatedPath = (name: string) => join(GENERATED, `${name}.gc`);

/** What the platform returned for each generated program — item id and the language it routed to. */
export const manifestPath = () => join(GENERATED, "index.json");

/** The L0175 side: what its compiler emitted, as committed. */
export const loadFixture = (name: string): any =>
  JSON.parse(readFileSync(fixturePath(name), "utf-8"));

export const loadSource = (name: string): SourceItem => readSourceItem(loadFixture(name));

/** The L0180 side: compile a program the way the API would. */
export async function compileL0180(src: string): Promise<any> {
  const code: any = await parser.parse(180, src.trim().endsWith("..") ? src : `${src}..`, lexicon);
  const perr: any = Object.values(code).find((n: any) => n && n.tag === "ERROR");
  if (perr) throw new Error(`parse error: ${JSON.stringify(perr.elts)}`);
  return await new Promise((res, rej) =>
    compiler.compile(code, {}, {}, (e: any, v: any) => {
      const errs = Array.isArray(e) ? e.filter(Boolean) : e ? [e] : [];
      if (errs.length) rej(new Error(String(errs[0])));
      else res(v);
    }),
  );
}
