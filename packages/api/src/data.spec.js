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
