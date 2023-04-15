import { jest } from "@jest/globals";
import { buildDataApi } from "./data.js";
import { buildTaskDaoFactory } from "./storage/index.js";
import { clearFirestore } from "./testing/firestore.js";
import { DATA1, DATA2, TASK1, TASK1_WITH_DATA, TASK2 } from "./testing/fixture.js";

describe("data", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  let taskDao;
  let compile;
  let dataApi;
  beforeEach(() => {
    taskDao = buildTaskDaoFactory({}).create({ type: "memory" });
    compile = jest.fn();
    dataApi = buildDataApi({ compile });
  });

  const mockCompileData = data =>
    compile.mockResolvedValueOnce(data);

  it("should compile a created task", async () => {
    const id = await taskDao.create({ task: TASK1 });
    mockCompileData(DATA1);

    await expect(dataApi.get({ taskDao, id })).resolves.toStrictEqual(DATA1);

    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        lang: TASK1.lang,
        code: TASK1.code
      })
    );
  });

  it("should not compile a created task with src data as code", async () => {
    const id = await taskDao.create({ task: TASK1_WITH_DATA });
    mockCompileData(DATA1);
    await expect(dataApi.get({ taskDao, id })).resolves.toStrictEqual(DATA1);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        lang: TASK1_WITH_DATA.lang,
        code: TASK1_WITH_DATA.code
      })
    );
  });

  const CODE_AS_DATA = { a: 1 };
  const TASK_WITH_CODE_AS_DATA = { lang: "1", code: CODE_AS_DATA };
  it("should not compile a created task with data as code", async () => {
    const id = await taskDao.create({ task: TASK_WITH_CODE_AS_DATA });
    mockCompileData(CODE_AS_DATA);
    await expect(dataApi.get({ taskDao, id })).resolves.toStrictEqual(CODE_AS_DATA);
    expect(compile).toHaveBeenCalledTimes(0);
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
    const id1 = await taskDao.create({ task: TASK1 });
    const id2 = await taskDao.create({ task: TASK2 });
    const id = taskDao.appendIds(id1, id2);
    mockCompileData(DATA1);
    mockCompileData(DATA2);

    await expect(dataApi.get({ taskDao, id })).resolves.toStrictEqual(DATA2);

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
});
