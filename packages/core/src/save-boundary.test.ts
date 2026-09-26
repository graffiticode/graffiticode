// SPDX-License-Identifier: MIT
// The item-bank write happens in exactly one place: `save-to-itembank`
// wrapping an activity, and only in a compile that selects a connection (see
// brokered.test.ts). Without one, the save is validated and reported as
// skipped, never executed. Building `items`/`questions` never writes, the
// literal legacy member is lowered to the wrapper, and any other way of setting
// the flag is refused. Global fetch is stubbed so any provider call would be
// observable; none may happen here.
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon, lowerLegacySave, Transformer } from "./index.js";

const CREDS = 'set-var "learnosity-key" "k" set-var "learnosity-secret" "ssssssssssssssssssss"';
const ITEM = "item [questions [mcq []] {}]";

let routes: string[];

beforeEach(() => {
  routes = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any) => {
    routes.push(new URL(String(url)).pathname.replace(/^.*\/itembank/, "/itembank"));
    return new Response(JSON.stringify({ meta: { status: true } }), { status: 200 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function compile(src: string): Promise<{ err: any[]; val: any }> {
  const code = await parser.parse(176, src, lexicon);
  return new Promise((resolve) =>
    compiler.compile(code, {}, {}, (err: any, val: any) => {
      const errors = Array.isArray(err) ? err.filter(Boolean) : err ? [err] : [];
      resolve({ err: errors, val });
    }),
  );
}

describe("building an activity never writes", () => {
  test.each([
    ["items", `set-var "lrn-id" "t" ${CREDS} items [${ITEM}] {}..`],
    ["questions", `set-var "lrn-id" "t" ${CREDS} questions [mcq []] {}..`],
  ])("%s without save-to-itembank", async (_, src) => {
    const { err, val } = await compile(src);
    expect(err).toEqual([]);
    expect(val.data.itemBank).toBeUndefined();
    expect(routes).toEqual([]);
  });
});

const SKIPPED = { skipped: "no-connection", fn: "save-to-itembank" };

describe("save-to-itembank <activity> without a connection", () => {
  test.each([
    ["items", `save-to-itembank items [${ITEM}] {}`],
    ["questions", "save-to-itembank questions [mcq []] {}"],
  ])("%s: validated, skipped, and the preview still renders", async (_, expr) => {
    const { err, val } = await compile(`set-var "lrn-id" "t" ${CREDS} ${expr}..`);
    expect(err).toEqual([]);
    expect(val.data.itemBank).toMatchObject(SKIPPED);
    expect(val.data.itemBank.occurrence).toMatch(/^SAVE_TO_ITEMBANK@/);
    expect(val.request).toBeDefined();
    expect(routes).toEqual([]);
  });

  test("the program's own credentials do not make it write", async () => {
    const { err, val } = await compile(`set-var "lrn-id" "t" ${CREDS} save-to-itembank items [${ITEM}] {}..`);
    expect(err).toEqual([]);
    expect(val.data.itemBank).toMatchObject(SKIPPED);
    expect(routes).toEqual([]);
  });

  test("with no credentials at all it still compiles", async () => {
    const { err, val } = await compile(`set-var "lrn-id" "t" save-to-itembank items [${ITEM}] {}..`);
    expect(err).toEqual([]);
    expect(val.data.itemBank).toMatchObject(SKIPPED);
    expect(routes).toEqual([]);
  });

  test("the author activity is left unsigned", async () => {
    const { err, val } = await compile(`set-var "lrn-id" "t" ${CREDS} author {}..`);
    expect(err).toEqual([]);
    expect(val.type).toBe("author");
    expect(val.request).toBeUndefined();
  });
});

describe("the legacy literal member is lowered to the wrapper", () => {
  test("items [save-to-itembank true, ...] becomes a save", async () => {
    const { err, val } = await compile(`set-var "lrn-id" "t" ${CREDS} items [save-to-itembank true, ${ITEM}] {}..`);
    expect(err).toEqual([]);
    expect(val.data.itemBank).toMatchObject(SKIPPED);
    expect(routes).toEqual([]);
  });

  test("questions [save-to-itembank true, ...] becomes a save", async () => {
    const { err, val } = await compile(`set-var "lrn-id" "t" ${CREDS} questions [save-to-itembank true, mcq []] {}..`);
    expect(err).toEqual([]);
    expect(val.data.itemBank).toMatchObject(SKIPPED);
    expect(routes).toEqual([]);
  });

  test("save-to-itembank false is dropped and nothing is written", async () => {
    const { err, val } = await compile(`set-var "lrn-id" "t" ${CREDS} items [save-to-itembank false, ${ITEM}] {}..`);
    expect(err).toEqual([]);
    expect(val.data.itemBank).toBeUndefined();
    expect(routes).toEqual([]);
  });

  test("lowering leaves no member-form save in the pool and does not mutate its input", async () => {
    const code = await parser.parse(176, `set-var "lrn-id" "t" items [save-to-itembank true, ${ITEM}] {}..`, lexicon);
    const before = JSON.stringify(code);
    const lowered = lowerLegacySave(code);
    expect(JSON.stringify(code)).toBe(before);
    const saves = Object.entries(lowered).filter(([k, n]: any) => k !== "root" && n.tag === "SAVE_TO_ITEMBANK");
    expect(saves).toHaveLength(1);
    const [, wrapper]: any = saves[0];
    expect((lowered as any)[wrapper.elts[0]].tag).toBe("ITEMS");
  });

  test("a program without the legacy member is returned unchanged", async () => {
    const code = await parser.parse(176, `set-var "lrn-id" "t" items [${ITEM}] {}..`, lexicon);
    expect(lowerLegacySave(code)).toBe(code);
  });
});

describe("any other way of requesting a save is refused", () => {
  test("a flag computed by another expression", async () => {
    const { err } = await compile(`set-var "lrn-id" "t" ${CREDS} set-var "s" true items [save-to-itembank get-var "s", ${ITEM}] {}..`);
    expect(err.map((e) => e.message ?? e).join()).toMatch(/save-to-itembank wraps the activity/);
    expect(routes).toEqual([]);
  });

  test("a record literal carrying the flag", async () => {
    const { err } = await compile(`set-var "lrn-id" "t" ${CREDS} items [{save_to_itembank: true}, ${ITEM}] {}..`);
    expect(err.length).toBeGreaterThan(0);
    expect(routes).toEqual([]);
  });

  test("wrapping something that is not a built activity", async () => {
    const { err } = await compile(`set-var "lrn-id" "t" ${CREDS} save-to-itembank {type: "questions", data: {questions: []}}..`);
    expect(err.map((e) => e.message ?? e).join()).toMatch(/must wrap an activity/);
    expect(routes).toEqual([]);
  });
});

describe("a save plan belongs to the invocation that built it", () => {
  // Build an activity in one Transformer (one compile), returning the actual
  // activity object that transformer produced — not a rendered copy.
  async function buildActivity() {
    const code = await parser.parse(176, `set-var "lrn-id" "t" items [${ITEM}] {}..`, lexicon);
    const t = new (Transformer as any)(code);
    const options: any = { data: {}, config: {}, result: "" };
    const activity = await new Promise<any>((resolve, reject) =>
      t.transform(options, (err: any, val: any) => (err?.length ? reject(err) : resolve(val))));
    return { t, activity };
  }

  // Run SAVE_TO_ITEMBANK on `t` with `activity` as its argument.
  function saveWith(t: any, activity: any) {
    t.RETAINED = (_n: any, _o: any, resume: any) => resume([], activity);
    t.nodePool[9001] = { tag: "RETAINED", elts: [] };
    t.nodePool[9002] = { tag: "SAVE_TO_ITEMBANK", elts: [9001] };
    const options: any = { "lrn-id": "t", "learnosity-key": "k", "learnosity-secret": "s".repeat(20) };
    return new Promise<{ err: any[]; val: any }>((resolve) =>
      t.visit(9002, options, (err: any, val: any) => resolve({ err: err ?? [], val })));
  }

  test("the building invocation can save it", async () => {
    const { t, activity } = await buildActivity();
    const { err, val } = await saveWith(t, activity);
    expect(err).toEqual([]);
    expect(val.data.itemBank).toMatchObject(SKIPPED);
    expect(routes).toEqual([]);
  });

  test("another invocation holding the same object cannot", async () => {
    const { activity } = await buildActivity();
    const code = await parser.parse(176, "1..", lexicon);
    const other = new (Transformer as any)(code);
    const { err } = await saveWith(other, activity);
    expect(err.map((e: any) => e.message ?? e).join()).toMatch(/must wrap an activity/);
    expect(routes).toEqual([]);
  });
});
