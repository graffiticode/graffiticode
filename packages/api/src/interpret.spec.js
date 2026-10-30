// The interpreter pass in the API (interpreter plan B3), with declared fake
// languages and in-memory stores: no emulator, no language server.
import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { canonicalDigest } from "@graffiticode/common/canonical";
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
      // The production manifest: L0184 may be turned on (C1); L0000 isn't declared (C7).
      expect([...getInterpreterLanguages({ INTERPRETER_L0184: "on", INTERPRETER_L0000: "on" })]).toEqual(["0184"]);
      expect([...getInterpreterLanguages({})]).toEqual([]);
    } finally {
      log.mockRestore();
    }
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

  it("keys a stage by everything that decides its result", () => {
    const base = { lang: "0900", interpreterLang: "0900", modelDigest: "m", revision: "r1", options: {}, generation: { producer: null }, mode: "evaluate", authority: "anonymous", input: { data: 1, errors: [] } };
    const key = stageCacheKey(base);
    expect(stageCacheKey({ ...base, input: { errors: [], data: 1 } })).toBe(key);
    for (const change of [
      { lang: "0901" }, { interpreterLang: "0901" }, { modelDigest: "n" }, { revision: "r2" }, { options: { a: 1 } },
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

describe("the routes with interpreted stages", () => {
  const appFor = t => {
    const app = express();
    app.use(express.json());
    app.use((/** @type {any} */ req, _res, next) => {
      req.auth = { context: null, token: null };
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
