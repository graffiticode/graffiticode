import { jest } from "@jest/globals";
import { buildDataApi } from "./data.js";
import { createStorers } from "./storage/index.js";
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

  it("should forward a selected connection and bypass the shared cache", async () => {
    const id = await taskStorer.create({ task: TASK1 });
    // A cached result exists for this id...
    mockCompileData(DATA1);
    await dataApi.get({ taskStorer, compileStorer, id });
    // ...but a compile through a connection must not answer from it.
    mockCompileData(DATA2);

    await expect(dataApi.get({ taskStorer, compileStorer, id, connectionId: "conn-1" }))
      .resolves.toStrictEqual(DATA2);

    expect(compile).toHaveBeenCalledTimes(2);
    expect(compile).toHaveBeenNthCalledWith(2, expect.objectContaining({ connectionId: "conn-1" }));
    // And it must not overwrite the shared cache with this caller's output.
    await expect(dataApi.get({ taskStorer, compileStorer, id })).resolves.toStrictEqual(DATA1);
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it("should not cache a first compile through a selected connection", async () => {
    const id = await taskStorer.create({ task: TASK1 });
    mockCompileData(DATA2);
    await dataApi.get({ taskStorer, compileStorer, id, connectionId: "conn-1" });
    mockCompileData(DATA1);

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
      const validateOutput = jest.fn().mockResolvedValue([SCHEMA_ERROR]);
      dataApi = buildDataApi({ compile, validateOutput });
      const id = await taskStorer.create({ task: TASK1 });
      mockCompileData(RESULT);
      const action = {};

      await expect(dataApi.get({ taskStorer, compileStorer, id, action }))
        .resolves.toStrictEqual({ data: { bad: true }, errors: [SCHEMA_ERROR] });

      expect(validateOutput).toHaveBeenCalledWith(TASK1.lang, RESULT, expect.objectContaining({ id }));
      expect(action.compiled).toBeUndefined();
      await expect(compileStorer.get({ id })).resolves.toBeUndefined();
    });

    it("should cache as before when the data matches", async () => {
      const validateOutput = jest.fn().mockResolvedValue([]);
      dataApi = buildDataApi({ compile, validateOutput });
      const id = await taskStorer.create({ task: TASK1 });
      mockCompileData(RESULT);

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
});
