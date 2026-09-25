import { TASK1, TASK2 } from "../testing/fixture.js";
import { clearFirestore } from "../testing/firestore.js";
import { admin } from "./firebase.js";
import { buildTaskStorer, encodeId } from "./tasks.js";

const getAcls = async id => {
  const [taskId] = JSON.parse(Buffer.from(id, "base64url").toString("utf8")).taskIds;
  const taskDoc = await admin.firestore().doc(`tasks/${taskId}`).get();
  return taskDoc.get("acls");
};

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

  it("should get same id for same code with different key order", async () => {
    // Firestore re-sorts map keys on read, so a stored task's code round-trips
    // with reordered keys. The id must be stable regardless of key order.
    const id1 = await taskStorer.create({ task: { lang: "0", code: { a: { tag: "NUM", elts: ["1"] }, root: "a" } } });
    const id2 = await taskStorer.create({ task: { lang: "0", code: { root: "a", a: { elts: ["1"], tag: "NUM" } } } });

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

  it("should not grant another auth access by reposting private code", async () => {
    const myAuth = { uid: "1" };
    const otherAuth = { uid: "2" };
    const id1 = await taskStorer.create({ task: TASK1, auth: myAuth });
    const id2 = await taskStorer.create({ task: TASK1, auth: otherAuth });

    expect(id2).not.toBe(id1);
    await expect(getAcls(id1)).resolves.toStrictEqual({ public: false, uids: { 1: true } });
    await expect(taskStorer.get({ id: id1, auth: otherAuth })).rejects.toThrow();
    await expect(taskStorer.get({ id: id2, auth: otherAuth })).resolves.toStrictEqual([TASK1]);
  });

  it("should not publish private task on anonymous repost", async () => {
    const myAuth = { uid: "1" };
    const id1 = await taskStorer.create({ task: TASK1, auth: myAuth });
    const id2 = await taskStorer.create({ task: TASK1, auth: null });

    expect(id2).not.toBe(id1);
    await expect(getAcls(id1)).resolves.toStrictEqual({ public: false, uids: { 1: true } });
    await expect(taskStorer.get({ id: id1, auth: null })).rejects.toThrow();
    await expect(taskStorer.get({ id: id2, auth: null })).resolves.toStrictEqual([TASK1]);
  });

  it("should get same id when same auth reposts", async () => {
    const myAuth = { uid: "1" };
    const id1 = await taskStorer.create({ task: TASK1, auth: myAuth });
    const id2 = await taskStorer.create({ task: TASK1, auth: myAuth });

    expect(id2).toBe(id1);
  });

  it("should get same id when public task is reposted", async () => {
    const id1 = await taskStorer.create({ task: TASK1, auth: null });
    const id2 = await taskStorer.create({ task: TASK1, auth: null });
    const id3 = await taskStorer.create({ task: TASK1, auth: { uid: "1" } });

    expect(id2).toBe(id1);
    expect(id3).toBe(id1);
    await expect(getAcls(id1)).resolves.toStrictEqual({ public: true, uids: {} });
  });

  it("should reuse legacy code-hash task only when visible", async () => {
    // Pre-scoping records live at code-hashes/{codeHash}.
    const myAuth = { uid: "1" };
    const id1 = await taskStorer.create({ task: TASK1, auth: myAuth });
    const db = admin.firestore();
    const [taskId] = JSON.parse(Buffer.from(id1, "base64url").toString("utf8")).taskIds;
    const taskDoc = await db.doc(`tasks/${taskId}`).get();
    await clearFirestore();
    await db.doc(`tasks/${taskId}`).set(taskDoc.data());
    await db.doc(`code-hashes/${taskDoc.get("codeHash")}`).set({ taskId });

    await expect(taskStorer.create({ task: TASK1, auth: myAuth })).resolves.toBe(id1);
    await expect(taskStorer.create({ task: TASK1, auth: null })).resolves.not.toBe(id1);
    await expect(taskStorer.create({ task: TASK1, auth: { uid: "2" } })).resolves.not.toBe(id1);
    await expect(getAcls(id1)).resolves.toStrictEqual({ public: false, uids: { 1: true } });
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
