// The interpreter pass in the API (interpreter plan B3), with declared fake
// languages and in-memory stores: no emulator, no language server.
import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { canonicalDigest } from "@graffiticode/common/canonical";
import { INTERPRETER_DECLARATIONS } from "@graffiticode/common/interpreter-manifest";
import { taskRequiresProtected } from "@graffiticode/common/protected-registry";
import { buildModelCache } from "./model-cache.js";
import { buildDataApi } from "./data.js";
import {
  NO_STORE, PERMANENT, combineRestrictions, getInterpreterLanguages, interpretedRestrictions, legacyRestrictions,
  permanent, sharable, stageCacheKey, withoutStageMetadata,
} from "./interpret.js";
import { buildMemoryStageResultStorer } from "./storage/stage-results.js";
import { buildMemoryArtifactStorer } from "./storage/artifacts.js";
import buildDataRoute from "./routes/data.js";
import buildCompileRoute from "./routes/compile.js";

// 0900, 0901 and 0902 are interpreters; 0000 is not declared, so it is legacy.
/** @type {Record<string, import("@graffiticode/common/interpreter-manifest").InterpreterDeclaration>} */
const DECLARATIONS = {
  "0900": { interpreter: "interpreter", cacheCaps: { evaluate: "immutable", present: "immutable" } },
  "0901": { interpreter: "interpreter", cacheCaps: { evaluate: "shared", present: "private" } },
  "0902": { interpreter: "interpreter", cacheCaps: { evaluate: "immutable", present: "immutable" } },
};
const ON = { INTERPRETER_L0900: "on", INTERPRETER_L0901: "on", INTERPRETER_L0902: "on" };

const program = name => ({ 1: { tag: "STR", elts: [name] }, root: 1 });
const task = (lang, name = `p-${lang}`) => ({ lang, code: program(name) });

const encodeId = taskIds => Buffer.from(JSON.stringify({ taskIds }), "utf8").toString("base64url");
const memoryTasks = () => {
  const tasks = new Map();
  return {
    async create({ task }) {
      const key = canonicalDigest(task).slice(0, 16);
      tasks.set(key, { lang: task.lang, code: task.code });
      return encodeId([key]);
    },
    async get({ id }) {
      return id.split(/[ +]/g)
        .flatMap(part => JSON.parse(Buffer.from(part, "base64url").toString("utf8")).taskIds)
        .map(key => tasks.get(key));
    },
  };
};
const memoryCompiles = () => {
  const entries = new Map();
  return {
    entries,
    async get({ id }) {
      return entries.get(id);
    },
    async create({ id, compile, overwrite = false }) {
      if (!entries.has(id) || overwrite) entries.set(id, JSON.parse(JSON.stringify(compile)));
      return id;
    },
  };
};

const NOW = Date.parse("2026-10-29T12:00:00Z");
const HOUR = 60 * 60 * 1000;

/** @param {any} [opts] */
const setup = ({ env = ON, generations = {}, compileReply, interpretReply, revisions = {}, now = () => NOW, ...rest } = {}) => {
  // The order every language server was called in.
  const calls = [];
  const stages = [];
  const compile = /** @type {any} */ (jest.fn(async ({ lang, code, data }) => {
    calls.push({ call: "compile", lang, data });
    return compileReply ? compileReply({ lang, code, data }) : { data: { by: lang, name: code[1].elts[0], from: data }, errors: [] };
  }));
  /** @type {any} */
  const interpreter = {
    model: jest.fn(async ({ lang, code }) => {
      calls.push({ call: "model", lang });
      return {
        model: { lang, kind: "plan", digest: canonicalDigest({ lang, code }), program: code },
        errors: [],
        revision: revisions[lang] ?? "r1",
      };
    }),
    interpret: jest.fn(async ({ lang, model, input, mode }) => {
      calls.push({ call: "interpret", lang, input, mode });
      const reply = interpretReply?.({ lang, model, input, mode });
      return reply ?? { data: { by: lang, name: model.program[1].elts[0], mode, from: input }, errors: [], revision: revisions[lang] ?? "r1" };
    }),
  };
  /** @type {any} */
  const stageResults = buildMemoryStageResultStorer({ now });
  jest.spyOn(stageResults, "get");
  jest.spyOn(stageResults, "put");
  const taskStorer = memoryTasks();
  const compileStorer = memoryCompiles();
  const dataApi = buildDataApi(/** @type {any} */ ({
    compile,
    interpreter,
    stageResults,
    getInterpreterLanguages: () => getInterpreterLanguages(env, DECLARATIONS),
    declarations: DECLARATIONS,
    getLanguageGenerations: () => generations,
    onStage: record => stages.push(record),
    now,
    ...rest,
  }));
  const chain = async tasks => (await Promise.all(tasks.map(t => taskStorer.create({ task: t })))).join("+");
  /** @type {(id: string, more?: any) => Promise<any>} */
  const get = (id, more = {}) => dataApi.get({ taskStorer, compileStorer, id, ...more });
  return { calls, stages, compile, interpreter, stageResults, taskStorer, compileStorer, dataApi, chain, get };
};

describe("interpret.js", () => {
  it("turns on only declared interpreters whose flag is on", () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect([...getInterpreterLanguages({}, DECLARATIONS)]).toEqual([]);
      expect([...getInterpreterLanguages({ INTERPRETER_L0900: "on", INTERPRETER_L0901: "off" }, DECLARATIONS)]).toEqual(["0900"]);
      // Not declared, or not "on": off.
      expect([...getInterpreterLanguages({ INTERPRETER_L0000: "on", INTERPRETER_L0900: "yes" }, DECLARATIONS)]).toEqual([]);
      // The production manifest: the C1 and C2 languages may be turned on; L0000 isn't declared (C7).
      expect([...getInterpreterLanguages({ INTERPRETER_L0003: "on", INTERPRETER_L0010: "on", INTERPRETER_L0014: "on", INTERPRETER_L0174: "on", INTERPRETER_L0175: "on", INTERPRETER_L0177: "on", INTERPRETER_L0178: "on", INTERPRETER_L0179: "on", INTERPRETER_L0180: "on", INTERPRETER_L0181: "on", INTERPRETER_L0183: "on", INTERPRETER_L0184: "on", INTERPRETER_L0186: "on", INTERPRETER_L0187: "on", INTERPRETER_L0000: "on" })].sort()).toEqual(["0003", "0010", "0014", "0174", "0175", "0177", "0178", "0179", "0180", "0181", "0183", "0184", "0186", "0187"]);
      expect([...getInterpreterLanguages({})]).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it("records each interpreted stage's model kind, and none for a stage that has no model", async () => {
    const t = setup({ interpretReply: ({ model }) => (model.kind === "value" ? { data: model.value, errors: [], revision: "r1" } : undefined) });
    t.interpreter.model.mockImplementationOnce(async ({ lang, code }) => ({
      model: { lang, kind: "value", digest: canonicalDigest({ lang, code, v: 1 }), value: { v: 1 } },
      errors: [],
      revision: "r1",
    }));
    await t.get(await t.chain([task("0900", "valued")]));
    expect(t.stages.map(s => s.kind)).toEqual(["value"]);
    t.stages.length = 0;
    await t.get(await t.chain([task("0900", "planned")]));
    expect(t.stages.map(s => s.kind)).toEqual(["plan"]);
    t.stages.length = 0;
    t.interpreter.model.mockImplementationOnce(async () => ({ errors: [{ message: "no" }], revision: "r1" }));
    await t.get(await t.chain([task("0900", "broken")]));
    expect(t.stages).toHaveLength(1);
    expect(t.stages[0].kind).toBeUndefined();
    expect(t.stages[0].outcome).toBe("compile-errors");
  });

  it("compiles a stage's model once, from the model cache after that, and never under an override", async () => {
    const modelCache = buildModelCache();
    const t = setup({ modelCache });
    const id = await t.chain([task("0900", "cached")]);
    const first = await t.get(id);
    await expect(t.get(id)).resolves.toEqual(first);
    expect(t.interpreter.model).toHaveBeenCalledTimes(1);
    expect(t.stages.map(s => s.modelCache)).toEqual(["miss", "hit"]);
    // A model served from the cache is not timed as a compile.
    expect(t.stages[1].ms.model).toBeUndefined();
    // Under an override, the model is compiled every time, and nothing is cached.
    const o = setup({ modelCache: buildModelCache(), langOverrideStorer: { get: async () => ({ bindings: { L0900: "https://override.example" } }) } });
    const oid = await o.chain([task("0900", "overridden")]);
    await o.get(oid, { auth: { uid: "tester" } });
    await o.get(oid, { auth: { uid: "tester" } });
    expect(o.interpreter.model).toHaveBeenCalledTimes(2);
    expect(o.stages.every(s => s.modelCache === "skip")).toBe(true);
  });

  it("drops a cached model when the service that interprets it names another revision", async () => {
    const modelCache = buildModelCache();
    const revisions = { "0900": "r1" };
    const t = setup({ modelCache, revisions });
    const id = await t.chain([task("0900", "deployed")]);
    await t.get(id);
    // A deploy: the service now answers as r2. The cached model (r1) is used once more, its
    // interpretation is fresh (another key), and the entry is dropped.
    revisions["0900"] = "r2";
    await t.get(id, { refresh: true });
    expect(t.interpreter.model).toHaveBeenCalledTimes(1);
    expect(modelCache.size).toBe(0);
    await t.get(id);
    expect(t.interpreter.model).toHaveBeenCalledTimes(2);
  });

  it("reads a stage's class and expiry, capped by its declaration", () => {
    expect(legacyRestrictions({ data: 1, cache: false })).toEqual(NO_STORE);
    expect(legacyRestrictions({ data: 1 })).toEqual(PERMANENT);
    expect(interpretedRestrictions({ data: 1 }, "0900", "present", DECLARATIONS)).toEqual(PERMANENT);
    expect(interpretedRestrictions({ cache: false }, "0900", "present", DECLARATIONS)).toEqual(NO_STORE);
    // A class looser than the cap is capped; a stricter one is kept.
    expect(interpretedRestrictions({ cache: "immutable" }, "0901", "evaluate", DECLARATIONS).cacheClass).toBe("shared");
    expect(interpretedRestrictions({ cache: "immutable" }, "0901", "present", DECLARATIONS).cacheClass).toBe("private");
    expect(interpretedRestrictions({ cache: "no-store" }, "0901", "evaluate", DECLARATIONS).cacheClass).toBe("no-store");
    // Something it doesn't know is the strictest.
    expect(interpretedRestrictions({ cache: "forever" }, "0900", "evaluate", DECLARATIONS).cacheClass).toBe("no-store");
    expect(interpretedRestrictions({ expiresAt: "2026-10-29T13:00:00Z" }, "0900", "evaluate", DECLARATIONS).expiresAt).toBe(NOW + HOUR);
    // An expiry that can't be read has passed.
    expect(interpretedRestrictions({ expiresAt: "soon" }, "0900", "evaluate", DECLARATIONS).expiresAt).toBe(0);
  });

  it("combines to the stricter class and the earlier expiry", () => {
    expect(combineRestrictions({ cacheClass: "shared", expiresAt: NOW + HOUR }, { cacheClass: "immutable", expiresAt: NOW + 2 * HOUR }))
      .toEqual({ cacheClass: "shared", expiresAt: NOW + HOUR });
    expect(combineRestrictions(PERMANENT, { cacheClass: "private", expiresAt: null })).toEqual({ cacheClass: "private", expiresAt: null });
    expect(sharable({ cacheClass: "shared", expiresAt: NOW + 1 }, NOW)).toBe(true);
    expect(sharable({ cacheClass: "shared", expiresAt: NOW }, NOW)).toBe(false);
    expect(sharable({ cacheClass: "private", expiresAt: null }, NOW)).toBe(false);
    expect(sharable(NO_STORE, NOW)).toBe(false);
    expect(permanent(PERMANENT)).toBe(true);
    expect(permanent({ cacheClass: "immutable", expiresAt: NOW + HOUR })).toBe(false);
  });

  it("keys a stage by everything that decides its result, key order included", () => {
    const model = { lang: "0900", kind: "value", digest: "m", value: { type: "connector", from: "a", to: "b", toSide: "auto" } };
    const base = { lang: "0900", interpreterLang: "0900", model, revision: "r1", options: {}, generation: { producer: null }, mode: "evaluate", authority: "anonymous", input: { data: 1, errors: [] } };
    const key = stageCacheKey(base);
    expect(stageCacheKey({ ...base, model: { ...model } })).toBe(key);
    // Results follow their model's and input's key order, so those orders are part of the key:
    // two L0186 connectors equal up to key order once shared an entry (the B5 drive, 2026-11-05).
    expect(stageCacheKey({ ...base, model: { ...model, value: { type: "connector", toSide: "auto", from: "a", to: "b" } } })).not.toBe(key);
    expect(stageCacheKey({ ...base, input: { errors: [], data: 1 } })).not.toBe(key);
    for (const change of [
      { lang: "0901" }, { interpreterLang: "0901" }, { model: { ...model, digest: "n" } }, { revision: "r2" }, { options: { a: 1 } },
      { generation: { producer: "g2" } }, { mode: "present" }, { authority: "user:u1" }, { input: { data: 2, errors: [] } },
    ]) {
      expect(stageCacheKey({ ...base, ...change })).not.toBe(key);
    }
  });

  it("keeps the API's metadata out of what it forwards", () => {
    expect(withoutStageMetadata({ data: 1, errors: [], cache: "shared", expiresAt: 5, revision: "r", responseLost: true, extra: 2 }))
      .toEqual({ data: 1, errors: [], extra: 2 });
  });
});

describe("getData with interpreted stages", () => {
  it("is inert when no language is turned on: legacy compiles and the whole-chain cache, as today", async () => {
    const t = setup({ env: {} });
    const id = await t.chain([task("0900"), task("0000")]);
    const first = await t.get(id);
    expect(t.interpreter.model).not.toHaveBeenCalled();
    expect(t.calls.map(c => `${c.call}:${c.lang}`)).toEqual(["compile:0000", "compile:0900"]);
    expect(t.compileStorer.entries.has(id)).toBe(true);
    // Answered from the whole-chain store.
    await expect(t.get(id)).resolves.toEqual(first);
    expect(t.compile).toHaveBeenCalledTimes(2);
    expect(t.stages).toEqual([]);
  });

  it("interprets the head over a legacy tail: the legacy envelope is its exact input, in present mode", async () => {
    // The legacy stage answers with an envelope carrying more than data and errors.
    const legacyEnvelope = { data: { x: 1 }, errors: [], note: "kept" };
    const t = setup({ compileReply: () => legacyEnvelope });
    const id = await t.chain([task("0900"), task("0000")]);
    const action = {};
    const result = await t.get(id, { action });
    expect(t.calls.map(c => `${c.call}:${c.lang}`)).toEqual(["compile:0000", "model:0900", "interpret:0900"]);
    expect(t.calls[0].data).toEqual({});
    expect(t.calls[2].input).toEqual(legacyEnvelope);
    expect(t.calls[2].mode).toBe("present");
    expect(result).toEqual({ data: { by: "0900", name: "p-0900", mode: "present", from: legacyEnvelope }, errors: [] });
    // Never in the whole-chain store, and never held by a browser or CDN yet.
    expect(t.compileStorer.entries.size).toBe(0);
    expect(action.noStore).toBe(true);
  });

  it("interprets a tail under a legacy head: the head receives the stage's envelope without the API's metadata", async () => {
    const t = setup({
      interpretReply: ({ input }) => ({ data: { y: 2, from: input }, errors: [], cache: "immutable", expiresAt: null, revision: "r1" }),
    });
    const id = await t.chain([task("0000"), task("0900")]);
    const result = await t.get(id);
    expect(t.calls.map(c => `${c.call}:${c.lang}`)).toEqual(["model:0900", "interpret:0900", "compile:0000"]);
    expect(t.calls[1].mode).toBe("evaluate");
    expect(t.calls[1].input).toEqual({});
    expect(t.calls[2].data).toEqual({ data: { y: 2, from: {} }, errors: [] });
    expect(result.data.from).toEqual({ data: { y: 2, from: {} }, errors: [] });
  });

  it("names stages by chain position, the same on every run, and presents only at the head", async () => {
    const t = setup();
    const id = await t.chain([task("0900", "a"), task("0000", "b"), task("0900", "c"), task("0901", "d")]);
    await t.get(id);
    const first = t.stages.map(({ stage, lang, run, mode }) => ({ stage, lang, run, mode }));
    expect(first).toEqual([
      { stage: "s3", lang: "0901", run: "interpret", mode: "evaluate" },
      { stage: "s2", lang: "0900", run: "interpret", mode: "evaluate" },
      { stage: "s1", lang: "0000", run: "legacy", mode: undefined },
      { stage: "s0", lang: "0900", run: "interpret", mode: "present" },
    ]);
    t.stages.length = 0;
    await t.get(id, { refresh: true });
    expect(t.stages.map(({ stage, lang, run, mode }) => ({ stage, lang, run, mode }))).toEqual(first);
    expect(t.interpreter.interpret.mock.calls.map(([c]) => c.mode)).toEqual(["evaluate", "evaluate", "present", "evaluate", "evaluate", "present"]);
  });

  it("answers a repeated stage from the stage cache, never the whole-chain store", async () => {
    const t = setup();
    const id = await t.chain([task("0900"), task("0900", "tail")]);
    // An entry the whole-chain store already holds for the id is never served.
    await t.compileStorer.create({ id, compile: { timestamp: 0, data: { stale: true } } });
    const first = await t.get(id);
    expect(first.stale).toBeUndefined();
    expect(t.interpreter.interpret).toHaveBeenCalledTimes(2);
    expect(t.stageResults.entries.size).toBe(2);
    t.stages.length = 0;
    await expect(t.get(id)).resolves.toEqual(first);
    // The models are compiled again (they name the revision); neither stage is interpreted again.
    expect(t.interpreter.interpret).toHaveBeenCalledTimes(2);
    expect(t.stages.map(s => s.cache)).toEqual(["hit", "hit"]);
    // A hit times its model compile and its lookup, and never interprets. It names the model's
    // kind, as a fresh interpretation does.
    for (const s of t.stages) {
      expect(Object.keys(s.ms).sort()).toEqual(["cache", "model"]);
      expect(typeof s.ms.model).toBe("number");
      expect(s.kind).toBe("plan");
    }
    expect((await t.compileStorer.get({ id })).data).toEqual({ stale: true });
  });

  it("misses for another revision, mode, caller, generation or configuration", async () => {
    const revisions = {};
    let generations = {};
    const t = setup({ revisions, getLanguageGenerations: () => generations });
    const id = await t.chain([task("0900")]);
    await t.get(id);
    expect(t.interpreter.interpret).toHaveBeenCalledTimes(1);
    revisions["0900"] = "r2";
    await t.get(id);
    expect(t.interpreter.interpret).toHaveBeenCalledTimes(2);
    await t.get(id, { auth: { uid: "u1" } });
    expect(t.interpreter.interpret).toHaveBeenCalledTimes(3);
    generations = { "0900": "g2" };
    await t.get(id);
    expect(t.interpreter.interpret).toHaveBeenCalledTimes(4);
    await t.get(id, { options: { lang: "fr" } });
    expect(t.interpreter.interpret).toHaveBeenCalledTimes(5);
    // The same program below the head is evaluated, not presented: another entry.
    const below = await t.chain([task("0000"), task("0900")]);
    await t.get(below);
    expect(t.interpreter.interpret).toHaveBeenCalledTimes(6);
    // And every one of them hits now.
    await t.get(id, { options: { lang: "fr" } });
    expect(t.interpreter.interpret).toHaveBeenCalledTimes(6);
  });

  it("doesn't store a result interpreted by another revision than the key names", async () => {
    const t = setup({ interpretReply: ({ input }) => ({ data: input, errors: [], revision: "r-new" }) });
    await t.get(await t.chain([task("0900")]));
    expect(t.stageResults.put).not.toHaveBeenCalled();
  });

  it("tightens a cached result for identical input that arrives more restricted", async () => {
    // 0902's revision moves between runs, so the tail is interpreted again and
    // answers the same bytes, now shared and expiring. The head's entry for
    // that input is still a hit, and its result takes the input's terms.
    const revisions = {};
    let tailTerms = {};
    const t = setup({
      revisions,
      interpretReply: ({ lang, input }) => (lang === "0902"
        ? { data: { same: "bytes" }, errors: [], revision: revisions[lang] ?? "r1", ...tailTerms }
        : { data: { head: true, from: input }, errors: [], revision: "r1" }),
    });
    const id = await t.chain([task("0900"), task("0902")]);
    const first = await t.get(id);
    expect(t.stages.find(s => s.stage === "s0")).toMatchObject({ cache: "miss", result: PERMANENT });
    t.stages.length = 0;
    revisions["0902"] = "r2";
    tailTerms = { cache: "shared", expiresAt: NOW + HOUR };
    const action = {};
    await expect(t.get(id, { action })).resolves.toEqual(first);
    expect(t.stages.map(s => `${s.stage}:${s.cache}`)).toEqual(["s1:miss", "s0:hit"]);
    const head = t.stages.find(s => s.stage === "s0");
    expect(head.own).toEqual(PERMANENT);
    expect(head.result).toEqual({ cacheClass: "shared", expiresAt: NOW + HOUR });
    expect(t.interpreter.interpret.mock.calls.filter(([c]) => c.lang === "0900")).toHaveLength(1);
    expect(action.noStore).toBe(true);
  });

  it("refuses a declared stage's no-store result as another stage's input", async () => {
    const t = setup({
      interpretReply: ({ lang }) => (lang === "0902"
        ? { data: { signed: "secret" }, errors: [], cache: false, revision: "r1" }
        : undefined),
    });
    // Under a legacy head and under an interpreted one: neither ever sees it.
    for (const head of [task("0000"), task("0900")]) {
      const id = await t.chain([head, task("0902")]);
      const action = {};
      const result = await t.get(id, { action });
      expect(result.data).toBeNull();
      expect(result.errors.map(e => e.code)).toEqual(["no-store-intermediate"]);
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(action.noStore).toBe(true);
    }
    expect(t.compile).not.toHaveBeenCalled();
    expect(t.interpreter.interpret.mock.calls.map(([c]) => c.lang)).toEqual(["0902", "0902"]);
    expect(t.stageResults.put).not.toHaveBeenCalled();
  });

  it("presents a declared stage's no-store result at the head, uncached", async () => {
    const t = setup({ interpretReply: () => ({ data: { signed: "preview" }, errors: [], cache: false, revision: "r1" }) });
    const action = {};
    await expect(t.get(await t.chain([task("0900")]), { action })).resolves.toEqual({ data: { signed: "preview" }, errors: [] });
    expect(action.noStore).toBe(true);
    expect(t.stageResults.put).not.toHaveBeenCalled();
  });

  it("applies the manifest's current caps to a cached result", async () => {
    const declarations = JSON.parse(JSON.stringify(DECLARATIONS));
    const t = setup({ declarations });
    const id = await t.chain([task("0900")]);
    await t.get(id);
    await t.get(id);
    expect(t.interpreter.interpret).toHaveBeenCalledTimes(1);
    // Tightened to shared: still a hit, now shared.
    declarations["0900"].cacheCaps.present = "shared";
    t.stages.length = 0;
    await t.get(id);
    expect(t.interpreter.interpret).toHaveBeenCalledTimes(1);
    expect(t.stages[0]).toMatchObject({ cache: "hit", own: { cacheClass: "shared", expiresAt: null } });
    // Tightened to private: the shared entry is no longer served, and the
    // private result isn't stored.
    declarations["0900"].cacheCaps.present = "private";
    t.stages.length = 0;
    t.stageResults.put.mockClear();
    await t.get(id);
    expect(t.interpreter.interpret).toHaveBeenCalledTimes(2);
    expect(t.stages[0]).toMatchObject({ cache: "miss", own: { cacheClass: "private", expiresAt: null } });
    expect(t.stageResults.put).not.toHaveBeenCalled();
  });

  it("stores a result under its input's restrictions as well as its own", async () => {
    const t = setup({
      interpretReply: ({ lang, input }) => (lang === "0902"
        ? { data: { soon: "gone" }, errors: [], cache: "shared", expiresAt: NOW + 60 * 1000, revision: "r1" }
        : { data: { from: input }, errors: [], revision: "r1" }),
    });
    await t.get(await t.chain([task("0900"), task("0902")]));
    const head = [...t.stageResults.entries.values()].find(e => e.lang === "0900");
    expect(head).toMatchObject({ cacheClass: "shared", expiresAt: NOW + 60 * 1000 });
  });

  it("neither looks up nor stores a stage whose input is private", async () => {
    const t = setup({
      interpretReply: ({ lang, input }) => (lang === "0902"
        ? { data: { secret: 1 }, errors: [], cache: "private", revision: "r1" }
        : { data: { from: input }, errors: [], revision: "r1" }),
    });
    const id = await t.chain([task("0900"), task("0902")]);
    await t.get(id);
    await t.get(id);
    // Only the tail, whose input is the chain's empty start, is looked up; its
    // private result is never stored, and the head over it never consults the cache.
    expect(t.stageResults.get).toHaveBeenCalledTimes(2);
    expect(t.stageResults.put).not.toHaveBeenCalled();
    expect(t.interpreter.interpret).toHaveBeenCalledTimes(4);
    expect(t.stages.filter(s => s.stage === "s0").map(s => [s.cache, s.result.cacheClass])).toEqual([["skip", "private"], ["skip", "private"]]);
  });

  it("neither looks up nor stores a stage whose input is no-store, and strips the legacy directive", async () => {
    const t = setup({ compileReply: () => ({ data: { signed: "preview" }, errors: [], cache: false }) });
    const id = await t.chain([task("0900"), task("0000")]);
    await t.get(id);
    await t.get(id);
    expect(t.stageResults.get).not.toHaveBeenCalled();
    expect(t.stageResults.put).not.toHaveBeenCalled();
    expect(t.interpreter.interpret).toHaveBeenCalledTimes(2);
    expect(t.calls.find(c => c.call === "interpret").input).toEqual({ data: { signed: "preview" }, errors: [] });
  });

  it("never stores a result its declaration caps at private", async () => {
    const t = setup();
    const id = await t.chain([task("0901")]);
    const action = {};
    await t.get(id, { action });
    expect(t.stageResults.put).not.toHaveBeenCalled();
    expect(t.stages[0].own).toEqual({ cacheClass: "private", expiresAt: null });
    expect(action.noStore).toBe(true);
  });

  it("treats an expired entry as a miss", async () => {
    let now = NOW;
    const t = setup({
      now: () => now,
      interpretReply: () => ({ data: 1, errors: [], expiresAt: NOW + HOUR, revision: "r1" }),
    });
    const id = await t.chain([task("0900")]);
    await t.get(id);
    await t.get(id);
    expect(t.interpreter.interpret).toHaveBeenCalledTimes(1);
    now = NOW + HOUR;
    await t.get(id);
    expect(t.interpreter.interpret).toHaveBeenCalledTimes(2);
  });

  it("keeps a stage with compile errors out of every cache, and forwards them as a legacy stage would", async () => {
    const t = setup();
    t.interpreter.model.mockResolvedValueOnce({ model: null, errors: [{ message: "bad", from: 0, to: 1 }], revision: "r1" });
    const id = await t.chain([task("0000"), task("0900")]);
    await t.get(id);
    expect(t.interpreter.interpret).not.toHaveBeenCalled();
    expect(t.calls.find(c => c.call === "compile").data).toEqual({ data: null, errors: [{ message: "bad", from: 0, to: 1 }] });
    expect(t.stageResults.put).not.toHaveBeenCalled();
  });

  it("never uses the stage cache for a user testing an override", async () => {
    const t = setup({ langOverrideStorer: { get: async () => ({ bindings: { L0900: "https://l0900-test.example" } }) } });
    const id = await t.chain([task("0900")]);
    await t.get(id, { auth: { uid: "tester" } });
    await t.get(id, { auth: { uid: "tester" } });
    expect(t.stageResults.get).not.toHaveBeenCalled();
    expect(t.stageResults.put).not.toHaveBeenCalled();
    expect(t.interpreter.model.mock.calls[0][0].baseUrl).toBe("https://l0900-test.example");
  });

  it("runs a compile through a connection as today, with the legacy adapter", async () => {
    const t = setup({
      allocateInvocation: /** @type {any} */ (jest.fn()).mockResolvedValue({ invocationToken: "inv.tok.en", invocationId: "inv-1", seq: 1, ownerUid: "owner" }),
      artifactStorer: buildMemoryArtifactStorer(),
    });
    const id = await t.chain([task("0900"), task("0901")]);
    await t.get(id, { auth: { uid: "u1" }, connectionId: "conn-1" });
    expect(t.interpreter.model).not.toHaveBeenCalled();
    expect(t.compile.mock.calls.map(([c]) => [c.lang, c.stage, c.connectionId])).toEqual([["0901", "s1", "conn-1"], ["0900", "s0", "conn-1"]]);
  });

  it("leaves a view through a connection or a publication on its stored artifact", async () => {
    const t = setup({ artifactStorer: buildMemoryArtifactStorer() });
    const id = await t.chain([task("0900")]);
    const viaConnection = await t.get(id, { auth: { uid: "u1" }, connectionId: "conn-1", read: true });
    const viaPublication = await t.get(id, { read: true, publicationId: "pub-1" });
    expect(viaConnection.errors?.length).toBeGreaterThan(0);
    expect(viaPublication.errors?.length).toBeGreaterThan(0);
    expect(t.interpreter.model).not.toHaveBeenCalled();
    expect(t.interpreter.interpret).not.toHaveBeenCalled();
    expect(t.compile).not.toHaveBeenCalled();
  });
});

// C6 part 2 (docs/c6-l0176-reads-plan.md): L0176 as the manifest declares it, a protected
// language (`init` is implicit), interpreted with no connection.
describe("L0176 interpreted (C6 part 2)", () => {
  const L0176 = INTERPRETER_DECLARATIONS["0176"];
  const declarations = { ...DECLARATIONS, "0176": L0176 };
  const env = { ...ON, INTERPRETER_L0176: "on" };
  let signatures = 0;
  // l0176r as slices 1 and 2 left it: present signs, afresh each time, and is `cache: false`;
  // evaluate is the activity unsigned, with no cache field.
  const l0176 = ({ lang, model, input, mode }) => {
    if (lang !== "0176") return undefined;
    const activity = { type: "questions", data: { id: `graffiticode-${model.program[1].elts[0]}`, questions: [], from: input?.data ?? null } };
    return mode === "present"
      ? { data: { ...activity, request: { signature: `sig-${++signatures}` } }, errors: [], cache: false, revision: "r1" }
      : { data: activity, errors: [], revision: "r1" };
  };
  const setup176 = (opts = {}) => setup({
    env,
    declarations,
    getInterpreterLanguages: () => getInterpreterLanguages(env, declarations),
    interpretReply: l0176,
    modelCache: buildModelCache(),
    ...opts,
  });

  it("is a protected language, declared evaluate immutable and present no-store", () => {
    expect(taskRequiresProtected(task("0176"))).toBe(true);
    expect(L0176).toEqual({ interpreter: "interpreter", cacheCaps: { evaluate: "immutable", present: "no-store" } });
  });

  it("caches an L0176 stage below the head unsigned, and signs the head afresh on every read, never storing it", async () => {
    const t = setup176();
    const id = await t.chain([task("0176", "head"), task("0176", "tail")]);
    const first = await t.get(id);
    expect(first.errors).toEqual([]);
    // The head is signed; what it received from the stage below was not.
    expect(first.data.request).toEqual({ signature: expect.stringMatching(/^sig-/) });
    expect(first.data.data.from).toEqual({ type: "questions", data: { id: "graffiticode-tail", questions: [], from: null } });
    expect(JSON.stringify(first.data.data.from)).not.toContain("signature");
    expect(t.interpreter.interpret.mock.calls.map(([c]) => [c.model.program[1].elts[0], c.mode])).toEqual([["tail", "evaluate"], ["head", "present"]]);
    // Only the evaluate result is stored, as immutable.
    expect([...t.stageResults.entries.values()].map(e => [e.lang, e.mode, e.cacheClass, e.expiresAt])).toEqual([["0176", "evaluate", "immutable", null]]);
    t.stages.length = 0;
    const second = await t.get(id);
    // The tail from the stage cache, the head interpreted and signed again.
    expect(t.stages.map(s => [s.stage, s.mode, s.cache])).toEqual([["s1", "evaluate", "hit"], ["s0", "present", "miss"]]);
    expect(second.data.request.signature).not.toEqual(first.data.request.signature);
    expect(t.stageResults.entries.size).toBe(1);
    // The models were compiled once each and then read from the model cache.
    expect(t.interpreter.model).toHaveBeenCalledTimes(2);
  });

  it("never trips no-store-intermediate for an L0176 stage below the head; a chain with L0176 is still never held over HTTP", async () => {
    const t = setup176();
    const action = {};
    const result = await t.get(await t.chain([task("0900"), task("0176")]), { action });
    expect(result.errors).toEqual([]);
    expect(result.data.from.data.data.id).toBe("graffiticode-p-0176");
    // The L0176 stage was cached, but the response isn't held: a chain with a protected
    // task is never cacheable as a whole (data.js `cacheable`), unchanged by this slice.
    expect([...t.stageResults.entries.values()].some(e => e.lang === "0176" && e.mode === "evaluate")).toBe(true);
    expect(action.noStore).toBe(true);
    // The same L0176 program at the head: signed and no-store.
    const head = {};
    const presented = await t.get(await t.chain([task("0176")]), { action: head });
    expect(presented.data.request).toBeDefined();
    expect(head.noStore).toBe(true);
  });

  it("caps a present result at no-store whatever it claims, and never stores it", async () => {
    // A server that forgot `cache: false` on present: the manifest still caps it.
    const t = setup176({ interpretReply: args => {
      const reply = l0176(args);
      if (!reply) return undefined;
      const { cache, ...rest } = reply;
      return rest;
    } });
    const action = {};
    await t.get(await t.chain([task("0176")]), { action });
    expect(action.noStore).toBe(true);
    expect(t.stageResults.put).not.toHaveBeenCalled();
    expect(t.stages[0].own).toEqual(NO_STORE);
  });

  it("keeps a cached L0176 evaluate result within its input's expiry (C3)", async () => {
    const t = setup176({ interpretReply: args => (args.lang === "0902"
      ? { data: { rows: [1] }, errors: [], cache: "shared", expiresAt: NOW + 60 * 1000, revision: "r1" }
      : l0176(args)) });
    await t.get(await t.chain([task("0900"), task("0176"), task("0902")]));
    const entry = [...t.stageResults.entries.values()].find(e => e.lang === "0176");
    expect(entry).toMatchObject({ mode: "evaluate", cacheClass: "shared", expiresAt: NOW + 60 * 1000 });
  });

  it("stays on the legacy compile with the flag off: no model, no interpretation, nothing stored", async () => {
    const t = setup176({ getInterpreterLanguages: () => getInterpreterLanguages(ON, declarations) });
    await t.get(await t.chain([task("0176", "head"), task("0176", "tail")]));
    expect(t.interpreter.model).not.toHaveBeenCalled();
    expect(t.compile.mock.calls.map(([c]) => c.lang)).toEqual(["0176", "0176"]);
    expect(t.stageResults.put).not.toHaveBeenCalled();
  });

  it("never interprets through a connection", async () => {
    const t = setup176({
      allocateInvocation: /** @type {any} */ (jest.fn()).mockResolvedValue({ invocationToken: "inv.tok.en", invocationId: "inv-1", seq: 1, ownerUid: "owner" }),
      artifactStorer: buildMemoryArtifactStorer(),
    });
    await t.get(await t.chain([task("0176")]), { auth: { uid: "u1" }, connectionId: "conn-1" });
    expect(t.interpreter.model).not.toHaveBeenCalled();
    expect(t.compile.mock.calls.map(([c]) => [c.lang, c.connectionId])).toEqual([["0176", "conn-1"]]);
  });
});

describe("the routes with interpreted stages", () => {
  const appFor = (t, { auth = null } = {}) => {
    const app = express();
    app.use(express.json());
    app.use((/** @type {any} */ req, _res, next) => {
      req.auth = { context: auth, token: auth ? "token" : null };
      next();
    });
    app.use("/data", buildDataRoute({ taskStorer: t.taskStorer, compileStorer: t.compileStorer, dataApi: t.dataApi }));
    app.use("/compile", buildCompileRoute({ taskStorer: t.taskStorer, compileStorer: t.compileStorer, dataApi: t.dataApi }));
    return app;
  };

  it("GET /data interprets the head, and isn't held as immutable", async () => {
    const t = setup();
    const id = await t.chain([task("0900"), task("0000")]);
    const res = await request(appFor(t)).get(`/data?id=${id}`).expect(200);
    expect(res.body.data).toEqual({ data: { by: "0900", name: "p-0900", mode: "present", from: { data: { by: "0000", name: "p-0000", from: {} }, errors: [] } }, errors: [] });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(t.stages.map(s => `${s.stage}:${s.run}`)).toEqual(["s1:legacy", "s0:interpret"]);
  });

  it("GET /data for a legacy chain is unchanged: immutable, from the whole-chain store", async () => {
    const t = setup();
    const id = await t.chain([task("0000")]);
    const res = await request(appFor(t)).get(`/data?id=${id}`).expect(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(t.compileStorer.entries.has(id)).toBe(true);
    expect(t.stages).toEqual([]);
  });

  it("GET /data holds an interpreted result as immutable only when its url names the current generations", async () => {
    const t = setup({ generations: { "0900": "g1" } });
    const id = await t.chain([task("0900")]);
    const app = appFor(t);
    const cacheControl = async query => (await request(app).get("/data").query({ id, ...query }).expect(200)).headers["cache-control"];
    expect(await cacheControl({ generations: "@L0900=g1" })).toBe("public, max-age=31536000, immutable");
    // A URL from before a switch or a rollback, or none.
    expect(await cacheControl({ generations: "@L0900=g0" })).toBe("no-store");
    expect(await cacheControl({})).toBe("no-store");
  });

  // C3, bounded caching: an interpreted result that is `shared` until a
  // future expiry is held until then (max-age, never immutable), public only
  // for an anonymous request. A result with errors, a URL that doesn't name
  // the current generations and a past expiry are no-store; across ids the
  // stricter class and the earliest expiry win.
  describe("bounded caching for shared results (C3)", () => {
    const SHARED = minutes => ({ cache: "shared", expiresAt: Date.now() + minutes * 60 * 1000 });
    /** @type {(terms?: (stage: { lang: string, model: any }) => object) => any} */
    const sharedSetup = (terms = () => SHARED(5)) => setup({
      generations: { "0900": "g1" },
      interpretReply: ({ lang, model, input, mode }) => ({
        data: { by: lang, name: model.program[1].elts[0], mode, from: input }, errors: [], revision: "r1", ...terms({ lang, model }),
      }),
    });
    const headers = async (app, query) => (await request(app).get("/data").query(query).expect(200)).headers["cache-control"];
    const maxAge = header => Number(/max-age=(\d+)/.exec(header)?.[1]);

    it("holds a shared result until it expires: public for an anonymous request", async () => {
      const t = sharedSetup();
      const id = await t.chain([task("0900")]);
      const header = await headers(appFor(t), { id, generations: "@L0900=g1" });
      expect(header).toMatch(/^public, max-age=\d+$/);
      expect(maxAge(header)).toBeGreaterThan(290);
      expect(maxAge(header)).toBeLessThanOrEqual(300);
    });

    it("a shared stage under an immutable one: the chain is shared until the stage's expiry", async () => {
      const t = setup({
        generations: { "0900": "g1", "0902": "g1" },
        interpretReply: ({ lang, input }) => (lang === "0902"
          ? { data: { rows: [1] }, errors: [], revision: "r1", ...SHARED(3) }
          : { data: { chart: input }, errors: [], revision: "r1" }),
      });
      const id = await t.chain([task("0900"), task("0902")]);
      const header = await headers(appFor(t), { id, generations: "@L0900=g1@L0902=g1" });
      expect(header).toMatch(/^public, max-age=\d+$/);
      expect(maxAge(header)).toBeGreaterThan(170);
      expect(maxAge(header)).toBeLessThanOrEqual(180);
    });

    it("is private for an authenticated request", async () => {
      const t = sharedSetup();
      const id = await t.chain([task("0900")]);
      const header = await headers(appFor(t, { auth: { uid: "u1" } }), { id, generations: "@L0900=g1" });
      expect(header).toMatch(/^private, max-age=\d+$/);
    });

    it("never holds an interpreted fetch failure", async () => {
      const t = setup({
        generations: { "0900": "g1" },
        interpretReply: () => ({ data: null, errors: [{ message: "fetch: the server answered 503." }], revision: "r1", ...SHARED(5) }),
      });
      const id = await t.chain([task("0900")]);
      expect(await headers(appFor(t), { id, generations: "@L0900=g1" })).toBe("no-store");
    });

    it("is no-store without the current generations in the URL, or once expired", async () => {
      const t = sharedSetup();
      const id = await t.chain([task("0900")]);
      expect(await headers(appFor(t), { id })).toBe("no-store");
      // Past by the route's clock, though not by the data api's (NOW is earlier).
      const expired = sharedSetup(() => ({ cache: "shared", expiresAt: NOW + HOUR }));
      const id2 = await expired.chain([task("0900", "expired")]);
      expect(await headers(appFor(expired), { id: id2, generations: "@L0900=g1" })).toBe("no-store");
    });

    it("combines a request's ids: shared and immutable is shared until the earliest expiry; any no-store wins", async () => {
      const name = model => model.program[1].elts[0];
      const t = sharedSetup(({ model }) => (name(model) === "fixed" ? {} : SHARED(name(model) === "soon" ? 2 : 5)));
      const fixed = await t.chain([task("0900", "fixed")]);
      const soon = await t.chain([task("0900", "soon")]);
      const later = await t.chain([task("0900", "later")]);
      const header = await headers(appFor(t), { id: [fixed, later, soon].join(","), generations: "@L0900=g1" });
      expect(header).toMatch(/^public, max-age=\d+$/);
      expect(maxAge(header)).toBeLessThanOrEqual(120);
      expect(await headers(appFor(t), { id: fixed, generations: "@L0900=g1" })).toBe("public, max-age=31536000, immutable");
      const failing = setup({
        generations: { "0900": "g1" },
        interpretReply: ({ model }) => (name(model) === "bad"
          ? { data: null, errors: [{ message: "fetch failed" }], revision: "r1", ...SHARED(5) }
          : { data: { ok: true }, errors: [], revision: "r1", ...SHARED(5) }),
      });
      const ok = await failing.chain([task("0900", "ok")]);
      const bad = await failing.chain([task("0900", "bad")]);
      expect(await headers(appFor(failing), { id: [ok, bad].join(","), generations: "@L0900=g1" })).toBe("no-store");
    });
  });

  it("GET /data never holds a url naming other generations, even for a legacy chain or a cache hit", async () => {
    // L0184 on legacy, with a switch generation; a URL names a future one.
    const t = setup({ env: {}, generations: { "0184": "rust-1" } });
    const id = await t.chain([task("0184")]);
    const app = appFor(t);
    const cacheControl = async query => (await request(app).get("/data").query({ id, ...query }).expect(200)).headers["cache-control"];
    expect(await cacheControl({ generations: "@L0184=interp-1" })).toBe("no-store");
    // Now answered from the whole-chain store: still not held.
    expect(t.compileStorer.entries.size).toBe(1);
    expect(await cacheControl({ generations: "@L0184=interp-1" })).toBe("no-store");
    expect(t.compile).toHaveBeenCalledTimes(1);
    // The current generations, or none named: as before.
    expect(await cacheControl({ generations: "@L0184=rust-1" })).toBe("public, max-age=31536000, immutable");
    expect(await cacheControl({})).toBe("public, max-age=31536000, immutable");
  });

  it("GET /data names when an expiring result should be loaded again", async () => {
    const t = setup({ interpretReply: () => ({ data: 1, errors: [], cache: "shared", expiresAt: NOW + HOUR, revision: "r1" }) });
    const id = await t.chain([task("0900")]);
    const res = await request(appFor(t)).get(`/data?id=${id}`).expect(200);
    expect(res.body).toEqual({ status: "success", data: { data: 1, errors: [] }, refreshAt: new Date(NOW + HOUR).toISOString() });
    // Nothing expires: no metadata, as before.
    const legacy = await t.chain([task("0000")]);
    expect((await request(appFor(t)).get(`/data?id=${legacy}`).expect(200)).body).not.toHaveProperty("refreshAt");
  });

  it("POST /compile presents the item over its data task", async () => {
    const t = setup();
    const res = await request(appFor(t)).post("/compile").send({ item: { ...task("0900"), data: { a: 1 } } }).expect(200);
    // The item's data is an L0000 data task below it, compiled by the legacy adapter.
    expect(t.calls.map(c => `${c.call}:${c.lang}`)).toEqual(["compile:0000", "model:0900", "interpret:0900"]);
    expect(t.calls[2].mode).toBe("present");
    expect(res.body.data.data.from).toEqual(t.calls[2].input);
    expect(res.headers["cache-control"]).toBe("no-store");
    await request(appFor(t)).post("/compile").send({ item: { ...task("0900"), data: { a: 1 } } }).expect(200);
    expect(t.interpreter.interpret).toHaveBeenCalledTimes(1);
  });
});

describe("recompiles under L0158's requested generation (B4)", () => {
  let saved;
  beforeEach(() => {
    saved = process.env.COMPILE_GENERATION_L0158;
    process.env.COMPILE_GENERATION_L0158 = "g1";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.COMPILE_GENERATION_L0158;
    else process.env.COMPILE_GENERATION_L0158 = saved;
  });
  const appFor = t => {
    const app = express();
    app.use(express.json());
    app.use((/** @type {any} */ req, _res, next) => {
      req.auth = { context: null, token: null };
      next();
    });
    app.use("/compile", buildCompileRoute({ taskStorer: t.taskStorer, compileStorer: t.compileStorer, dataApi: t.dataApi }));
    return app;
  };

  it("compiles an L0158 item's edit in the namespace its load read", async () => {
    const t = setup({ env: {} });
    const id = await t.chain([task("0158")]);
    await request(appFor(t)).post("/compile").send({ id, data: { a: 1 }, generation: "g1" }).expect(200);
    const keys = [...t.compileStorer.entries.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0].startsWith(`${id}+`)).toBe(true);
    expect(keys[0].endsWith("@g1")).toBe(true);
    // The data task the compile added is what the item's stage received.
    expect(t.calls.map(c => `${c.call}:${c.lang}`)).toEqual(["compile:0000", "compile:0158"]);
  });

  it("refuses another generation, a mixed item chain, or a connection", async () => {
    const t = setup({ env: {} });
    const app = appFor(t);
    const l0158 = await t.chain([task("0158")]);
    await request(app).post("/compile").send({ id: l0158, data: { a: 1 }, generation: "g0" }).expect(400);
    const mixed = await t.chain([task("0158"), task("0000")]);
    await request(app).post("/compile").send({ id: mixed, data: { a: 1 }, generation: "g1" }).expect(400);
    expect(t.compile).not.toHaveBeenCalled();
    expect(t.compileStorer.entries.size).toBe(0);
  });

  it("allows only the generated data task beyond the item's chain", async () => {
    const t = setup({ env: {} });
    // An ordinary L0000 program in the data task's place is not the exception.
    const id = await t.chain([task("0158"), task("0000")]);
    await expect(t.get(id, { generation: "g1", generationDataTask: true })).rejects.toThrow(/data task/);
    expect(t.compile).not.toHaveBeenCalled();
  });
});
