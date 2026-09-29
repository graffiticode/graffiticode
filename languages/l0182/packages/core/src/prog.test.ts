// SPDX-License-Identifier: MIT
/**
 * What PROG does with the `data` it is handed.
 *
 * It ignores it, and that is the point of this file. L0182 used to merge `options.data` into
 * the compiled value because the React player wrote the participant's answer back through it —
 * which forced the compiler to unwrap the `{data, errors}` envelope storage wraps a stored
 * model in, in a loop, because a second layer appeared after the first round trip. The response
 * is authored in code now. The shapes below are what `GET /data?id=` really returns for a
 * stored task, and none of them may reach the output.
 */
import { describe, expect, it } from "vitest";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon, setSource } from "./index.js";

const SRC = `survey [ id "fixture" ]..`;

setSource(async (id) => ({
  instance: `${id}-1`,
  data: { style: "ranked-choice", title: "T", options: ["one", "two"] },
}));

/** Compile with an explicit `data`, the way a round trip does. */
async function compileWith(data: any): Promise<any> {
  const code: any = await parser.parse(182, SRC, lexicon);
  return await new Promise((resolve, reject) =>
    compiler.compile(code, data, {}, (e: any, v: any) => {
      const errs = Array.isArray(e) ? e.filter(Boolean) : e ? [e] : [];
      if (errs.length) reject(errs);
      else resolve(v);
    }),
  );
}

describe("PROG and the data it is handed", () => {
  it("emits the compiled value and nothing else", async () => {
    const out = await compileWith({});
    expect(Object.keys(out)).toEqual(["survey"]);
    expect(out.survey.title).toBe("T");
  });

  it("does not let a stored response in data become the response", async () => {
    // Whoever answers writes it in code. A response arriving as data is a leftover from the
    // language's previous shape, and letting it through would resurrect a model nothing writes.
    const out = await compileWith({ response: { choices: ["o0"] } });
    expect(out.response).toBeUndefined();
  });

  it("does not let a stale compile carried in data shadow the fresh one", async () => {
    const out = await compileWith({ survey: { title: "STALE", options: [] } });
    expect(out.survey.title).toBe("T");
    expect(out.survey.options).toHaveLength(2);
  });

  it("is untouched by the { data, errors } envelope, singly or doubly wrapped", async () => {
    for (const d of [
      { data: { survey: { title: "STALE" } }, errors: [] },
      { data: { data: { survey: { title: "STALE" } }, errors: [] }, errors: [] },
    ]) {
      const out = await compileWith(d);
      expect(out.survey.title).toBe("T");
      expect(out.data).toBeUndefined();
      expect(out.errors).toBeUndefined();
    }
  });

  it("survives data that is absent, empty, or not an object", async () => {
    for (const d of [undefined, {}, null, "nope", []]) {
      const out = await compileWith(d as any);
      expect(out.survey.options).toHaveLength(2);
    }
  });
});
