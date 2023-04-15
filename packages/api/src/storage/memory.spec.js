import { buildMemoryTaskDao } from "./memory.js";
import { TASK1, TASK1_ID, TASK2 } from "../testing/fixture.js";

describe("storage/memory", () => {
  let taskDao = null;
  beforeEach(() => {
    taskDao = buildMemoryTaskDao();
  });

  it("should throw NotFoundError if task is not created", async () => {
    await expect(taskDao.get({ id: TASK1_ID })).rejects.toThrow();
  });

  it("should return created task", async () => {
    const id = await taskDao.create({ task: TASK1 });

    await expect(taskDao.get({ id })).resolves.toStrictEqual([TASK1]);
  });

  it("should return multi task id", async () => {
    const id1 = await taskDao.create({ task: TASK1 });
    const id2 = await taskDao.create({ task: TASK2 });
    const id = taskDao.appendIds(id1, id2);

    await expect(taskDao.get({ id })).resolves.toStrictEqual([TASK1, TASK2]);
  });

  it("should get appended task ids", async () => {
    const id1 = await taskDao.create({ task: TASK1 });
    const id2 = await taskDao.create({ task: TASK2 });
    const id = `${id1}+${id2}`;

    await expect(taskDao.get({ id })).resolves.toStrictEqual([TASK1, TASK2]);
  });

  it("should get different ids for same code and different langs", async () => {
    const id1 = await taskDao.create({ task: { lang: "0", code: TASK1.code } });
    const id2 = await taskDao.create({ task: { lang: "1", code: TASK1.code } });

    await expect(id1).not.toBe(id2);
  });

  it("should get same id for same lang and code with different extra properties", async () => {
    const id1 = await taskDao.create({ task: { ...TASK1, foo: "bar" } });
    const id2 = await taskDao.create({ task: { ...TASK1, foo: "baz" } });

    await expect(id1).toBe(id2);
  });

  it("should throw NotFoundError retrieved without auth", async () => {
    const auth = { uid: "1" };
    const id = await taskDao.create({ task: TASK1, auth });

    await expect(taskDao.get({ id, auth: null })).rejects.toThrow();
  });

  it("should return task if created without auth", async () => {
    const auth = { uid: "1" };
    const id = await taskDao.create({ task: TASK1, auth: null });

    await expect(taskDao.get({ id, auth })).resolves.toStrictEqual([TASK1]);
  });

  it("should return task if retrieved by same auth", async () => {
    const myAuth = { uid: "1" };
    const id = await taskDao.create({ task: TASK1, auth: myAuth });

    await expect(taskDao.get({ id, auth: myAuth })).resolves.toStrictEqual([TASK1]);
  });

  it("should throw NotFoundError retrieved by another auth", async () => {
    const myAuth = { uid: "1" };
    const otherAuth = { uid: "2" };
    const id = await taskDao.create({ task: TASK1, auth: myAuth });

    await expect(taskDao.get({ id, auth: otherAuth })).rejects.toThrow();
  });

  it("should return task if retrieved by multiple auths", async () => {
    const myAuth = { uid: "1" };
    const otherAuth = { uid: "2" };
    const id = await taskDao.create({ task: TASK1, auth: myAuth });
    await taskDao.create({ task: TASK1, auth: otherAuth });

    await expect(taskDao.get({ id, auth: myAuth })).resolves.toStrictEqual([TASK1]);
    await expect(taskDao.get({ id, auth: otherAuth })).resolves.toStrictEqual([TASK1]);
  });

  it("should throw NotFoundError if retrieved by another auth in compound id", async () => {
    const myAuth = { uid: "1" };
    const otherAuth = { uid: "2" };
    const id1 = await taskDao.create({ task: TASK1, auth: myAuth });
    const id2 = await taskDao.create({ task: TASK2, auth: otherAuth });
    const id = taskDao.appendIds(id1, id2);

    await expect(taskDao.get({ id, auth: myAuth })).rejects.toThrow();
  });
});
