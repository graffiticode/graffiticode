import { buildCompileStorer } from "./compile.js";
import { TASK1, TASK2, DATA1 } from "../testing/fixture.js";
import { clearFirestore } from "../testing/firestore.js";
import { buildTaskStorer } from "./tasks.js";

describe("storage/compile", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  let taskStorer;
  let compileStorer;
  beforeEach(async () => {
    taskStorer = buildTaskStorer();
    compileStorer = buildCompileStorer();
  });

  it("should return undefined if compile is not created", async () => {
    const id = await taskStorer.create({ task: TASK1 });
    await expect(compileStorer.get({ id })).resolves.toBe(undefined);
  });

  it("should return created compile", async () => {
    const id = await taskStorer.create({ task: TASK1 });
    await compileStorer.create({ id, compile: { data: DATA1 } });

    await expect(compileStorer.get({ id })).resolves.toStrictEqual({ count: 1, data: DATA1 });
  });

  it("should use separate maps to store values", async () => {
    const id = await taskStorer.create({ task: TASK1 });
    await compileStorer.create({ id, compile: { data: DATA1 } });

    await expect(taskStorer.get({ id })).resolves.toStrictEqual([TASK1]);
    await expect(compileStorer.get({ id })).resolves.toStrictEqual({ count: 1, data: DATA1 });
  });

  it("should handle multi task id", async () => {
    const id1 = await taskStorer.create({ task: TASK1 });
    const id2 = await taskStorer.create({ task: TASK2 });
    const id = taskStorer.appendIds(id1, id2);

    await compileStorer.create({ id, compile: { data: DATA1 } });
    await expect(compileStorer.get({ id })).resolves.toStrictEqual({ count: 1, data: DATA1 });
  });
});
