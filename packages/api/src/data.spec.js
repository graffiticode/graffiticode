import { jest } from "@jest/globals";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { buildDataApi } from "./data.js";
import { createStorers } from "./storage/index.js";
import { buildLangOverrideStorer } from "./storage/lang-override.js";
import { buildGetBaseUrlForLanguage } from "./lang/base-url.js";
import { buildCompile as buildLangCompile } from "./lang/compile.js";
import { buildGetAsset } from "./lang/get-asset.js";
import { buildValidateOutput } from "./lang/validate-output.js";
import { buildCompile } from "./comp.js";
import { isNonEmptyString } from "./util.js";
import { admin } from "./storage/firebase.js";
import { clearFirestore } from "./testing/firestore.js";
import { DATA1, DATA2, TASK1, TASK2 } from "./testing/fixture.js";

describe("data", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  let taskStorer;
  let compileStorer;
  let compile;
  let dataApi;
  beforeEach(() => {
    const storers = createStorers();
    taskStorer = storers.taskStorer;
    compileStorer = storers.compileStorer;
    compile = jest.fn();
    // @ts-expect-error TS-MIGRATE: jest mock typed as an untyped function
    dataApi = buildDataApi({ compile });
  });

  const mockCompileData = data =>
    compile.mockResolvedValueOnce(data);

  it("should compile a created task", async () => {
    const id = await taskStorer.create({ task: TASK1 });
    mockCompileData(DATA1);

    await expect(dataApi.get({ taskStorer, compileStorer, id })).resolves.toStrictEqual(DATA1);

    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        lang: TASK1.lang,
        code: TASK1.code
      })
    );
  });

  // A compile through a connection runs under an invocation from policy.
  // @ts-expect-error TS-MIGRATE: jest mock typed as an untyped function
  const withInvocation = () => buildDataApi({
    compile,
    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
    allocateInvocation: jest.fn().mockResolvedValue({ invocationToken: "inv.tok.en", invocationId: "inv-1", seq: 1, ownerUid: "owner" })
  });

  it("should forward a selected connection and bypass the shared cache", async () => {
    dataApi = withInvocation();
    const id = await taskStorer.create({ task: TASK1 });
    // A cached result exists for this id...
    mockCompileData(DATA1);
    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
    await dataApi.get({ taskStorer, compileStorer, id });
    // ...but a compile through a connection must not answer from it.
    mockCompileData(DATA2);

    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
    await expect(dataApi.get({ taskStorer, compileStorer, id, connectionId: "conn-1" }))
      .resolves.toStrictEqual(DATA2);

    expect(compile).toHaveBeenCalledTimes(2);
    expect(compile).toHaveBeenNthCalledWith(2, expect.objectContaining({ connectionId: "conn-1" }));
    // And it must not overwrite the shared cache with this caller's output.
    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
    await expect(dataApi.get({ taskStorer, compileStorer, id })).resolves.toStrictEqual(DATA1);
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it("should not cache a first compile through a selected connection", async () => {
    dataApi = withInvocation();
    const id = await taskStorer.create({ task: TASK1 });
    mockCompileData(DATA2);
    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
    await dataApi.get({ taskStorer, compileStorer, id, connectionId: "conn-1" });
    mockCompileData(DATA1);

    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
    await expect(dataApi.get({ taskStorer, compileStorer, id })).resolves.toStrictEqual(DATA1);
    expect(compile).toHaveBeenCalledTimes(2);
  });

  const PROTECTED_TASK = { lang: "0176", code: { 1: { tag: "NUM", elts: ["1"] }, root: 1 } };

  it("should never answer a protected task from an existing cache entry", async () => {
    const id = await taskStorer.create({ task: PROTECTED_TASK });
    // An entry written before the language's functions were registered.
    await compileStorer.create({ id, compile: { timestamp: Date.now(), data: DATA1 } });
    mockCompileData(DATA2);

    await expect(dataApi.get({ taskStorer, compileStorer, id })).resolves.toStrictEqual(DATA2);

    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("should never cache a protected task, even without a selected connection", async () => {
    const id = await taskStorer.create({ task: PROTECTED_TASK });
    mockCompileData(DATA1);
    const action = {};
    await dataApi.get({ taskStorer, compileStorer, id, action });
    mockCompileData(DATA2);

    await expect(dataApi.get({ taskStorer, compileStorer, id })).resolves.toStrictEqual(DATA2);
    expect(compile).toHaveBeenCalledTimes(2);
    expect(action.noStore).toBe(true);
  });

  const CODE_AS_DATA = { a: 1 };
  const TASK_WITH_CODE_AS_DATA = { lang: "1", code: CODE_AS_DATA };
  it("should not compile a created task with data as code", async () => {
    const id = await taskStorer.create({ task: TASK_WITH_CODE_AS_DATA });
    mockCompileData(CODE_AS_DATA);
    await expect(dataApi.get({ taskStorer, compileStorer, id })).resolves.toStrictEqual(CODE_AS_DATA);
    expect(compile).toHaveBeenCalledTimes(1);
    // FIXME
    // expect(compile).toHaveBeenNthCalledWith(
    //   1,
    //   expect.objectContaining({
    //     lang: TASK_WITH_CODE_AS_DATA.lang,
    //     code: TASK_WITH_CODE_AS_DATA.code
    //   })
    // );
  });

  it("should compile created tasks", async () => {
    const id1 = await taskStorer.create({ task: TASK1 });
    const id2 = await taskStorer.create({ task: TASK2 });
    const id = taskStorer.appendIds(id1, id2);
    mockCompileData(DATA1);
    mockCompileData(DATA2);

    await expect(dataApi.get({ taskStorer, compileStorer, id })).resolves.toStrictEqual(DATA2);

    expect(compile).toHaveBeenCalledTimes(2);
    expect(compile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        lang: TASK2.lang,
        code: TASK2.code
      })
    );
    expect(compile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        lang: TASK1.lang,
        code: TASK1.code
      })
    );
  });

  describe("a language that answers cache: false", () => {
    it("should strip the directive and not cache the compile", async () => {
      const id = await taskStorer.create({ task: TASK1 });
      mockCompileData({ ...DATA1, cache: false });
      const action = {};

      await expect(dataApi.get({ taskStorer, compileStorer, id, action }))
        .resolves.toStrictEqual(DATA1);

      expect(action.noStore).toBe(true);
      await expect(compileStorer.get({ id })).resolves.toBeUndefined();
    });

    it("should recompile on every get", async () => {
      const id = await taskStorer.create({ task: TASK1 });
      mockCompileData({ ...DATA1, cache: false });
      mockCompileData({ ...DATA1, cache: false });

      await dataApi.get({ taskStorer, compileStorer, id });
      await dataApi.get({ taskStorer, compileStorer, id });

      expect(compile).toHaveBeenCalledTimes(2);
    });

    it("should make a composed result volatile from any one layer", async () => {
      const id1 = await taskStorer.create({ task: TASK1 });
      const id2 = await taskStorer.create({ task: TASK2 });
      const id = taskStorer.appendIds(id1, id2);
      // TASK2 compiles first (reduceRight) and is the volatile one; the head
      // (TASK1) answers nothing, so only accumulating would catch this.
      mockCompileData({ ...DATA1, cache: false });
      mockCompileData(DATA2);
      const action = {};

      await expect(dataApi.get({ taskStorer, compileStorer, id, action }))
        .resolves.toStrictEqual(DATA2);

      expect(action.noStore).toBe(true);
      await expect(compileStorer.get({ id })).resolves.toBeUndefined();
    });
  });

  describe("refresh", () => {
    // The stale-compile false PASS: a taskId is content-addressed over
    // {lang, code} and carries no compiler version, so a verdict recorded
    // before a breaking language change keeps answering for code the checker
    // now rejects.
    it("should answer from the cache without it", async () => {
      const id = await taskStorer.create({ task: TASK1 });
      mockCompileData(DATA1);
      await dataApi.get({ taskStorer, compileStorer, id });

      // Second read must not reach the compiler at all.
      await expect(dataApi.get({ taskStorer, compileStorer, id }))
        .resolves.toStrictEqual(DATA1);
      expect(compile).toHaveBeenCalledTimes(1);
    });

    it("should recompile with it, even when a result is cached", async () => {
      const id = await taskStorer.create({ task: TASK1 });
      mockCompileData(DATA1);
      await dataApi.get({ taskStorer, compileStorer, id });

      mockCompileData(DATA2);
      await expect(dataApi.get({ taskStorer, compileStorer, id, refresh: true }))
        .resolves.toStrictEqual(DATA2);
      expect(compile).toHaveBeenCalledTimes(2);
    });

    it("should overwrite the stored verdict, not just re-read it", async () => {
      const id = await taskStorer.create({ task: TASK1 });
      mockCompileData(DATA1);
      await dataApi.get({ taskStorer, compileStorer, id });

      mockCompileData(DATA2);
      await dataApi.get({ taskStorer, compileStorer, id, refresh: true });

      // The point of the fix: stored data was write-once, so a stale record
      // could only ever be deleted. A later plain read must see the new answer.
      await expect(compileStorer.get({ id })).resolves.toEqual(
        expect.objectContaining({ data: DATA2 })
      );
      await expect(dataApi.get({ taskStorer, compileStorer, id }))
        .resolves.toStrictEqual(DATA2);
      expect(compile).toHaveBeenCalledTimes(2);
    });

    it("should keep firstCompile when overwriting", async () => {
      const id = await taskStorer.create({ task: TASK1 });
      mockCompileData(DATA1);
      await dataApi.get({ taskStorer, compileStorer, id });
      const before = await compileStorer.get({ id });

      mockCompileData(DATA2);
      await dataApi.get({ taskStorer, compileStorer, id, refresh: true });
      const after = await compileStorer.get({ id });

      // A refresh recompiles the same task; it does not make a new one.
      expect(after.firstCompile).toBe(before.firstCompile);
      // `count` is deliberately not asserted: compileStorer.get() increments it
      // on every read, so the reads in this test move it too and it measures
      // reads rather than compiles.
    });
  });

  describe("a compile whose data does not match its language's schema", () => {
    const SCHEMA_ERROR = { message: "L0000 compiler output does not match its schema.json", from: -1, to: -1, internal: true, kind: "schema" };
    const RESULT = { data: { bad: true }, errors: [] };

    it("should keep the data, add the errors, and not cache", async () => {
      // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
      const validateOutput = jest.fn().mockResolvedValue([SCHEMA_ERROR]);
      // @ts-expect-error TS-MIGRATE: jest mock typed as an untyped function
      dataApi = buildDataApi({ compile, validateOutput });
      const id = await taskStorer.create({ task: TASK1 });
      mockCompileData(RESULT);
      const action = {};

      // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
      await expect(dataApi.get({ taskStorer, compileStorer, id, action }))
        .resolves.toStrictEqual({ data: { bad: true }, errors: [SCHEMA_ERROR] });

      expect(validateOutput).toHaveBeenCalledWith(TASK1.lang, RESULT, expect.objectContaining({ id }));
      expect(action.compiled).toBeUndefined();
      await expect(compileStorer.get({ id })).resolves.toBeUndefined();
    });

    it("should cache as before when the data matches", async () => {
      // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
      const validateOutput = jest.fn().mockResolvedValue([]);
      // @ts-expect-error TS-MIGRATE: jest mock typed as an untyped function
      dataApi = buildDataApi({ compile, validateOutput });
      const id = await taskStorer.create({ task: TASK1 });
      mockCompileData(RESULT);

      // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
      await expect(dataApi.get({ taskStorer, compileStorer, id })).resolves.toStrictEqual(RESULT);
      await expect(compileStorer.get({ id })).resolves.toEqual(
        expect.objectContaining({ data: RESULT })
      );
    });
  });

  it("should cache a compile that says nothing about caching", async () => {
    const id = await taskStorer.create({ task: TASK1 });
    mockCompileData(DATA1);
    const action = {};

    await dataApi.get({ taskStorer, compileStorer, id, action });

    expect(action.noStore).toBeUndefined();
    await expect(compileStorer.get({ id })).resolves.toEqual(
      expect.objectContaining({ data: DATA1 })
    );
  });

  describe("invocations", () => {
    it("allocates one invocation for the chain and names each stage by position", async () => {
      // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
      const allocateInvocation = jest.fn().mockResolvedValue({ invocationToken: "inv.tok.en", invocationId: "inv-1", seq: 1, ownerUid: "owner" });
      // @ts-expect-error TS-MIGRATE: jest mock typed as an untyped function
      dataApi = buildDataApi({ compile, allocateInvocation });
      const id1 = await taskStorer.create({ task: TASK1 });
      const id2 = await taskStorer.create({ task: TASK2 });
      const id = taskStorer.appendIds(id1, id2);
      mockCompileData(DATA2);
      mockCompileData(DATA1);

      // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
      await dataApi.get({ taskStorer, compileStorer, id, authToken: "user-token", connectionId: "conn-1", idempotencyKey: "job-1" });

      expect(allocateInvocation).toHaveBeenCalledTimes(1);
      expect(allocateInvocation).toHaveBeenCalledWith(expect.objectContaining({
        authToken: "user-token", connectionId: "conn-1", taskId: id, idempotencyKey: "job-1"
      }));
      expect(compile).toHaveBeenNthCalledWith(1, expect.objectContaining({ invocationToken: "inv.tok.en", stage: "s1" }));
      expect(compile).toHaveBeenNthCalledWith(2, expect.objectContaining({ invocationToken: "inv.tok.en", stage: "s0" }));
    });

    it("allocates nothing without a connection", async () => {
      const allocateInvocation = jest.fn();
      // @ts-expect-error TS-MIGRATE: jest mock typed as an untyped function
      dataApi = buildDataApi({ compile, allocateInvocation });
      const id = await taskStorer.create({ task: TASK1 });
      mockCompileData(DATA1);

      // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
      await dataApi.get({ taskStorer, compileStorer, id });

      expect(allocateInvocation).not.toHaveBeenCalled();
      expect(compile).toHaveBeenCalledWith(expect.objectContaining({ invocationToken: null, stage: null }));
    });

    const INVOCATION = { invocationToken: "inv.tok.en", invocationId: "inv-1", seq: 1, ownerUid: "owner" };

    it("records the unsigned result of a successful compile as a private artifact", async () => {
      const { buildMemoryArtifactStorer } = await import("./storage/artifacts.js");
      const artifactStorer = buildMemoryArtifactStorer();
      // @ts-expect-error TS-MIGRATE: jest mock typed as an untyped function
      dataApi = buildDataApi({ compile, artifactStorer, allocateInvocation: jest.fn().mockResolvedValue(INVOCATION) });
      const id = await taskStorer.create({ task: TASK1 });
      // L0176's real envelope: the signed activity is `data`, beside `errors`.
      const SIGNED = { security: { signature: "sig" }, request: {} };
      mockCompileData({ data: { type: "questions", data: { q: 1 }, request: SIGNED }, errors: [], cache: false });

      // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
      const out = await dataApi.get({ taskStorer, compileStorer, id, auth: { uid: "u1" }, connectionId: "conn-1" });

      expect(out.data.request).toEqual(SIGNED);
      const got = await artifactStorer.getCurrent({ uid: "u1", taskId: id, connectionId: "conn-1", registryVersion: REGISTRY_VERSION });
      expect(got.status).toBe("ok");
      expect(got.artifact).toMatchObject({ ownerUid: "owner", invocationId: "inv-1", seq: 1 });
      expect(got.artifact.content).toEqual({ data: { type: "questions", data: { q: 1 } }, errors: [] });
      expect(JSON.stringify(got.artifact.content)).not.toMatch(/signature/);
    });

    it("stores content that merely mentions a signature", async () => {
      const { buildMemoryArtifactStorer } = await import("./storage/artifacts.js");
      const artifactStorer = buildMemoryArtifactStorer();
      // @ts-expect-error TS-MIGRATE: jest mock typed as an untyped function
      dataApi = buildDataApi({ compile, artifactStorer, allocateInvocation: jest.fn().mockResolvedValue(INVOCATION) });
      const id = await taskStorer.create({ task: TASK1 });
      const question = { stimulus: "What does \"signature\" mean?", signature: "a field named signature" };
      mockCompileData({ data: { type: "questions", data: { questions: [question] } }, errors: [] });

      // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
      await dataApi.get({ taskStorer, compileStorer, id, auth: { uid: "u1" }, connectionId: "conn-1" });

      const got = await artifactStorer.getCurrent({ uid: "u1", taskId: id, connectionId: "conn-1", registryVersion: REGISTRY_VERSION });
      expect(got.status).toBe("ok");
      expect(got.artifact.content.data.data.questions[0]).toEqual(question);
    });

    it("stores nothing when a signature is left anywhere in the output", async () => {
      const { buildMemoryArtifactStorer } = await import("./storage/artifacts.js");
      const artifactStorer = buildMemoryArtifactStorer();
      // @ts-expect-error TS-MIGRATE: jest mock typed as an untyped function
      dataApi = buildDataApi({ compile, artifactStorer, allocateInvocation: jest.fn().mockResolvedValue(INVOCATION) });
      const id = await taskStorer.create({ task: TASK1 });
      // What an explicit `init questions {}` returns: the signed request itself.
      mockCompileData({ data: { security: { signature: "sig" }, request: {} }, errors: [] });

      // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
      const out = await dataApi.get({ taskStorer, compileStorer, id, auth: { uid: "u1" }, connectionId: "conn-1" });

      const got = await artifactStorer.getCurrent({ uid: "u1", taskId: id, connectionId: "conn-1", registryVersion: REGISTRY_VERSION });
      expect(got.status).toBe("missing");
      expect(out.artifact).toMatchObject({ stored: false, error: "artifact-rejected", reason: "signed-content", retryable: false });
    });

    it("records no artifact for a failed compile, or one without a connection", async () => {
      const { buildMemoryArtifactStorer } = await import("./storage/artifacts.js");
      const artifactStorer = buildMemoryArtifactStorer();
      // @ts-expect-error TS-MIGRATE: jest mock typed as an untyped function
      dataApi = buildDataApi({ compile, artifactStorer, allocateInvocation: jest.fn().mockResolvedValue(INVOCATION) });
      const id = await taskStorer.create({ task: TASK1 });
      mockCompileData({ errors: [{ message: "bad" }] });
      // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
      await dataApi.get({ taskStorer, compileStorer, id, auth: { uid: "u1" }, connectionId: "conn-1" });
      mockCompileData(DATA1);
      // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
      await dataApi.get({ taskStorer, compileStorer, id, auth: { uid: "u1" } });

      const got = await artifactStorer.getCurrent({ uid: "u1", taskId: id, connectionId: "conn-1", registryVersion: REGISTRY_VERSION });
      expect(got.status).toBe("missing");
    });

    it("refuses a compile through a connection when it cannot allocate one", async () => {
      const id = await taskStorer.create({ task: TASK1 });

      const unconfigured = await dataApi.get({ taskStorer, compileStorer, id, connectionId: "conn-1" });
      expect(unconfigured.errors[0].message).toMatch(/connections are not available/);

      const { InvocationRefused } = await import("./invocations.js");
      // @ts-expect-error TS-MIGRATE: jest mock typed as an untyped function
      dataApi = buildDataApi({ compile, allocateInvocation: jest.fn().mockRejectedValue(new InvocationRefused("not-owner")) });
      // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
      const refused = await dataApi.get({ taskStorer, compileStorer, id, connectionId: "conn-1" });
      expect(refused.errors[0].message).toMatch(/permission denied \(not-owner\)/);
      expect(compile).not.toHaveBeenCalled();
    });
  });

  // The compile generation (generation.js): a request naming the active one
  // reads and writes `compiles/{id}@{generation}`, never `compiles/{id}`.
  describe("compile generation", () => {
    const L0158_TASK = { lang: "0158", code: TASK1.code };
    const OLD = { val: "old compiler" };
    const NEW = { val: "new compiler" };
    // The test sets the configured value; the data api reads it per request.
    let active;
    // A cast, not a suppression: the test double omits the optional services.
    const buildApi = /** @type {any} */ (buildDataApi);
    beforeEach(() => {
      active = "g1";
      dataApi = buildApi({ compile, getActiveGeneration: () => active });
    });
    const stored = async key => {
      const doc = await admin.firestore().doc(`compiles/${key}`).get();
      return doc.exists ? JSON.parse(doc.data().data) : undefined;
    };
    const deferred = () => {
      /** @type {(value: any) => void} */
      let resolve = () => {};
      const promise = new Promise(_resolve => { resolve = _resolve; });
      return { promise, resolve };
    };
    const until = async check => {
      for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(check()).toBe(true);
    };

    it("misses an unversioned record and leaves it alone", async () => {
      const id = await taskStorer.create({ task: L0158_TASK });
      await compileStorer.create({ id, compile: { timestamp: Date.now(), data: OLD } });
      mockCompileData(NEW);

      await expect(dataApi.get({ taskStorer, compileStorer, id, generation: "g1" })).resolves.toStrictEqual(NEW);
      expect(compile).toHaveBeenCalledTimes(1);
      // Unversioned reads still get the old record, with no compile.
      await expect(dataApi.get({ taskStorer, compileStorer, id })).resolves.toStrictEqual(OLD);
      // The scoped record answers the next scoped read.
      await expect(dataApi.get({ taskStorer, compileStorer, id, generation: "g1" })).resolves.toStrictEqual(NEW);
      expect(compile).toHaveBeenCalledTimes(1);
      expect(await stored(id)).toStrictEqual(OLD);
      expect(await stored(`${id}@g1`)).toStrictEqual(NEW);
    });

    it("writes a scoped compile only under the scoped key, so an unversioned read misses it", async () => {
      const id = await taskStorer.create({ task: L0158_TASK });
      mockCompileData(NEW);
      await dataApi.get({ taskStorer, compileStorer, id, generation: "g1" });
      expect(await stored(id)).toBeUndefined();

      mockCompileData(OLD);
      await expect(dataApi.get({ taskStorer, compileStorer, id })).resolves.toStrictEqual(OLD);
      expect(compile).toHaveBeenCalledTimes(2);
    });

    it.each([
      ["no generation is active", null, "g1"],
      ["the value isn't the active one", "g1", "g2"],
      ["the value is empty", "g1", ""],
    ])("refuses a generation when %s", async (_, configured, requested) => {
      active = configured;
      const id = await taskStorer.create({ task: L0158_TASK });
      await expect(dataApi.get({ taskStorer, compileStorer, id, generation: requested }))
        .rejects.toMatchObject({ statusCode: 400 });
      expect(compile).not.toHaveBeenCalled();
      expect(await stored(`${id}@${requested}`)).toBeUndefined();
    });

    it("refuses a generation for a chain with a non-L0158 task", async () => {
      const id = taskStorer.appendIds(
        await taskStorer.create({ task: L0158_TASK }),
        await taskStorer.create({ task: TASK1 }));
      await expect(dataApi.get({ taskStorer, compileStorer, id, generation: "g1" }))
        .rejects.toMatchObject({ statusCode: 400 });
      const other = await taskStorer.create({ task: TASK1 });
      await expect(dataApi.get({ taskStorer, compileStorer, id: other, generation: "g1" }))
        .rejects.toMatchObject({ statusCode: 400 });
      expect(compile).not.toHaveBeenCalled();
    });

    it("accepts a chain of L0158 tasks", async () => {
      const id = taskStorer.appendIds(
        await taskStorer.create({ task: L0158_TASK }),
        await taskStorer.create({ task: { lang: "L0158", code: TASK2.code } }));
      mockCompileData(OLD);
      mockCompileData(NEW);
      await expect(dataApi.get({ taskStorer, compileStorer, id, generation: "g1" })).resolves.toStrictEqual(NEW);
      expect(await stored(`${id}@g1`)).toStrictEqual(NEW);
      expect(await stored(id)).toBeUndefined();
    });

    it("refreshes only the scoped key", async () => {
      const id = await taskStorer.create({ task: L0158_TASK });
      await compileStorer.create({ id, compile: { timestamp: Date.now(), data: OLD } });
      await compileStorer.create({ id: `${id}@g1`, compile: { timestamp: Date.now(), data: OLD } });
      mockCompileData(NEW);

      await expect(dataApi.get({ taskStorer, compileStorer, id, generation: "g1", refresh: true }))
        .resolves.toStrictEqual(NEW);
      expect(await stored(`${id}@g1`)).toStrictEqual(NEW);
      expect(await stored(id)).toStrictEqual(OLD);
    });

    it("never lets a handler that started without the generation write under it", async () => {
      // Started before activation, in this process: it captured no generation.
      active = null;
      const id = await taskStorer.create({ task: L0158_TASK });
      const held = deferred();
      compile.mockReturnValueOnce(held.promise);
      const oldRequest = dataApi.get({ taskStorer, compileStorer, id });
      await until(() => compile.mock.calls.length === 1);

      // Activation, then cleanup of the old record, while it's still compiling.
      active = "g1";
      await admin.firestore().doc(`compiles/${id}`).delete();

      // A scoped read meanwhile compiles fresh.
      mockCompileData(NEW);
      await expect(dataApi.get({ taskStorer, compileStorer, id, generation: "g1" })).resolves.toStrictEqual(NEW);
      expect(compile).toHaveBeenCalledTimes(2);

      // The old handler finally finishes, and writes only the unversioned key.
      held.resolve(OLD);
      await expect(oldRequest).resolves.toStrictEqual(OLD);
      expect(await stored(id)).toStrictEqual(OLD);
      expect(await stored(`${id}@g1`)).toStrictEqual(NEW);

      // Scoped reads never return the stale value.
      await expect(dataApi.get({ taskStorer, compileStorer, id, generation: "g1" })).resolves.toStrictEqual(NEW);
      expect(compile).toHaveBeenCalledTimes(2);
    });

    it("keeps the generation a request started with, whatever is configured when it writes", async () => {
      const id = await taskStorer.create({ task: L0158_TASK });
      const held = deferred();
      compile.mockReturnValueOnce(held.promise);
      const request = dataApi.get({ taskStorer, compileStorer, id, generation: "g1" });
      await until(() => compile.mock.calls.length === 1);
      active = "g2";
      held.resolve(NEW);
      await expect(request).resolves.toStrictEqual(NEW);
      expect(await stored(`${id}@g1`)).toStrictEqual(NEW);
      expect(await stored(`${id}@g2`)).toBeUndefined();
      expect(await stored(id)).toBeUndefined();
    });
  });

  // A user's language override is read once per request: that snapshot routes
  // every stage and schema fetch, whatever the binding says by the time a later
  // stage runs. Wired with the real resolver and a memo that never holds, so
  // any second lookup would see the change.
  describe("a language override", () => {
    const DEFAULT = "https://default-l0000";
    const A = "https://rev-a---l0000";
    const B = "https://rev-b---l0000";
    const UID = "tester";
    let calls;
    let onCompile;
    const seed = bindings => admin.firestore().doc(`lang-overrides/${UID}`).set({ bindings });
    // A stand-in for bent: records which URL each compile and schema fetch hit.
    const fakeBent = (baseUrl, method) => {
      if (method === "POST") {
        return async (_path, req) => {
          calls.push(["compile", baseUrl]);
          if (onCompile) {
            const run = onCompile;
            onCompile = null;
            await run();
          }
          return { data: { from: baseUrl, input: req.data ?? null }, errors: [] };
        };
      }
      return async path => {
        calls.push(["asset", baseUrl, path]);
        return JSON.stringify({ type: "object" });
      };
    };
    const overrideApi = ({ ttlMs = 0 } = {}) => {
      const langOverrideStorer = buildLangOverrideStorer({ ttlMs });
      const getBaseUrlForLanguage = buildGetBaseUrlForLanguage({
        isNonEmptyString,
        env: { BASE_URL_L0000: DEFAULT },
        getConfig: () => ({}),
        getCompilerHost: () => "unused",
        getCompilerPort: () => 0,
        getOverrideBaseUrl: langOverrideStorer.getBaseUrl
      });
      const langCompile = buildLangCompile({ getBaseUrlForLanguage, bent: fakeBent });
      const getAsset = buildGetAsset({ getBaseUrlForLanguage, bent: fakeBent });
      return /** @type {any} */ (buildDataApi(/** @type {any} */ ({
        compile: buildCompile({ langCompile }),
        langOverrideStorer,
        validateOutput: buildValidateOutput({ getBaseUrlForLanguage, getAsset, env: { COMPILE_SCHEMA_CHECK: "emit" }, log: () => {} }),
      })));
    };
    const chainOf = async () => {
      const id1 = await taskStorer.create({ task: TASK1 });
      const id2 = await taskStorer.create({ task: TASK2 });
      return taskStorer.appendIds(id1, id2);
    };
    const get = (api, id, extra = {}) => api.get({ taskStorer, compileStorer, id, auth: { uid: UID }, ...extra });
    // Every distinct URL the request reached, compiles and schema fetches alike.
    const urls = () => [...new Set(calls.map(c => c[1]))];

    beforeEach(() => {
      calls = [];
      onCompile = null;
    });

    it("routes every stage and schema fetch through the bindings it started with", async () => {
      await seed({ L0000: A });
      const id = await chainOf();
      // Rebound while the first stage runs.
      onCompile = () => seed({ L0000: B });

      await get(overrideApi(), id);

      expect(calls.filter(c => c[0] === "compile")).toHaveLength(2);
      expect(calls.filter(c => c[0] === "asset").length).toBeGreaterThan(0);
      expect(urls()).toEqual([A]);
      await expect(compileStorer.get({ id })).resolves.toBeUndefined();
    });

    it("routes and caches by the default binding when the request started without one", async () => {
      const id = await chainOf();
      onCompile = () => seed({ L0000: A });

      await get(overrideApi(), id);

      expect(urls()).toEqual([DEFAULT]);
      await expect(compileStorer.get({ id })).resolves.toEqual(expect.objectContaining({ data: expect.anything() }));
    });

    it.each([
      ["an empty string", { L0000: "" }],
      ["a non-string", { L0000: 42 }],
      ["null", { L0000: null }],
      ["bindings that are not an object", "https://not-a-map"],
    ])("falls back to the default for %s, and still writes nothing shared", async (_what, bindings) => {
      await seed(bindings);
      const id = await chainOf();

      await get(overrideApi(), id);

      expect(urls()).toEqual([DEFAULT]);
      await expect(compileStorer.get({ id })).resolves.toBeUndefined();
    });

    it("never writes its result to the shared cache, even with refresh", async () => {
      const id = await taskStorer.create({ task: TASK1 });
      // A default-binding result is cached first.
      const anonymous = await overrideApi().get({ taskStorer, compileStorer, id });
      expect(anonymous.data.from).toBe(DEFAULT);
      await seed({ L0000: A });

      const out = await get(overrideApi(), id, { refresh: true });

      expect(out.data.from).toBe(A);
      const cached = await compileStorer.get({ id });
      expect(cached.data.data.from).toBe(DEFAULT);
    });
  });
});
