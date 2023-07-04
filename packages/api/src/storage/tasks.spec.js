import { TASK1, TASK2 } from "../testing/fixture.js";
import { clearFirestore } from "../testing/firestore.js";
import { buildTaskStorer, encodeId } from "./tasks.js";

describe("storage/firestore", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  let taskStorer;
  beforeEach(async () => {
    taskStorer = buildTaskStorer();
  });

  it("should throw NotFoundError if task is not created", async () => {
    const id = encodeId({ taskIds: ["foo"] });

    await expect(taskStorer.get({ id })).rejects.toThrow();
  });

  it("should create task", async () => {
    const id = await taskStorer.create({ task: TASK1 });

    await expect(taskStorer.get({ id })).resolves.toStrictEqual([TASK1]);
  });

  it("should create tasks", async () => {
    const id1 = await taskStorer.create({ task: TASK1 });
    const id2 = await taskStorer.create({ task: TASK2 });

    await expect(taskStorer.get({ id: id1 })).resolves.toStrictEqual([TASK1]);
    await expect(taskStorer.get({ id: id2 })).resolves.toStrictEqual([TASK2]);
  });

  it("should get multi task id", async () => {
    const id1 = await taskStorer.create({ task: TASK1 });
    const id2 = await taskStorer.create({ task: TASK2 });
    const multiId = await taskStorer.appendIds(id1, id2);

    await expect(taskStorer.get({ id: multiId })).resolves.toStrictEqual([TASK1, TASK2]);
  });

  it("should get different ids for same code and different langs", async () => {
    const id1 = await taskStorer.create({ task: { lang: "0", code: TASK1.code } });
    const id2 = await taskStorer.create({ task: { lang: "1", code: TASK1.code } });

    await expect(id1).not.toBe(id2);
  });

  it("should get same id for same lang and code with different extra properties", async () => {
    const id1 = await taskStorer.create({ task: { ...TASK1, foo: "bar" } });
    const id2 = await taskStorer.create({ task: { ...TASK1, foo: "baz" } });

    await expect(id1).toBe(id2);
  });

  it("should get appended task ids", async () => {
    const id1 = await taskStorer.create({ task: TASK1 });
    const id2 = await taskStorer.create({ task: TASK2 });
    const id = `${id1}+${id2}`;

    await expect(taskStorer.get({ id })).resolves.toStrictEqual([TASK1, TASK2]);
  });

  it("should throw NotFoundError retrieved without auth", async () => {
    const auth = { uid: "1" };
    const id = await taskStorer.create({ task: TASK1, auth });

    await expect(taskStorer.get({ id, auth: null })).rejects.toThrow();
  });

  it("should return task if created without auth", async () => {
    const auth = { uid: "1" };
    const id = await taskStorer.create({ task: TASK1, auth: null });

    await expect(taskStorer.get({ id, auth })).resolves.toStrictEqual([TASK1]);
  });

  it("should return task if retrieved by same auth", async () => {
    const myAuth = { uid: "1" };
    const id = await taskStorer.create({ task: TASK1, auth: myAuth });

    await expect(taskStorer.get({ id, auth: myAuth })).resolves.toStrictEqual([TASK1]);
  });

  it("should throw NotFoundError retrieved by another auth", async () => {
    const myAuth = { uid: "1" };
    const otherAuth = { uid: "2" };
    const id = await taskStorer.create({ task: TASK1, auth: myAuth });

    await expect(taskStorer.get({ id, auth: otherAuth })).rejects.toThrow();
  });

  it("should return task if retrieved by multiple auths", async () => {
    const myAuth = { uid: "1" };
    const otherAuth = { uid: "2" };
    const id = await taskStorer.create({ task: TASK1, auth: myAuth });
    await taskStorer.create({ task: TASK1, auth: otherAuth });

    await expect(taskStorer.get({ id, auth: myAuth })).resolves.toStrictEqual([TASK1]);
    await expect(taskStorer.get({ id, auth: otherAuth })).resolves.toStrictEqual([TASK1]);
  });

  it("should throw NotFoundError if retrieved by another auth in compound id", async () => {
    const myAuth = { uid: "1" };
    const otherAuth = { uid: "2" };
    const id1 = await taskStorer.create({ task: TASK1, auth: myAuth });
    const id2 = await taskStorer.create({ task: TASK2, auth: otherAuth });
    const id = taskStorer.appendIds(id1, id2);

    await expect(taskStorer.get({ id, auth: myAuth })).rejects.toThrow();
  });
});
