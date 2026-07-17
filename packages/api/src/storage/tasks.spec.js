import { TASK1, TASK2 } from "../testing/fixture.js";
import { clearFirestore } from "../testing/firestore.js";
import { buildTaskStorer, encodeId } from "./tasks.js";
import { admin } from "./firebase.js";

const getTaskId = (encodedId) => {
  const idObj = JSON.parse(Buffer.from(encodedId, "base64url").toString("utf8"));
  return idObj.taskIds[0];
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

  it("should set expireAt on task and codeHash for ephemeral tasks (memory)", async () => {
    const id = await taskStorer.create({ task: TASK1, storageType: "memory" });
    const taskId = getTaskId(id);
    const db = admin.firestore();

    const taskDoc = await db.doc(`tasks/${taskId}`).get();
    expect(taskDoc.exists).toBe(true);
    expect(taskDoc.get("storageType")).toBe("memory");
    const expireAt = taskDoc.get("expireAt");
    expect(expireAt).toBeDefined();
    const expireAtDate = expireAt.toDate();
    const diff = expireAtDate.getTime() - Date.now();
    expect(diff).toBeGreaterThan(23.9 * 60 * 60 * 1000);
    expect(diff).toBeLessThan(24.1 * 60 * 60 * 1000);

    const codeHash = taskDoc.get("codeHash");
    const codeHashDoc = await db.doc(`code-hashes/${codeHash}`).get();
    expect(codeHashDoc.exists).toBe(true);
    const hashExpireAt = codeHashDoc.get("expireAt");
    expect(hashExpireAt).toBeDefined();
    expect(hashExpireAt.toDate().getTime()).toBe(expireAtDate.getTime());
  });

  it("should not set expireAt for persistent tasks", async () => {
    const id = await taskStorer.create({ task: TASK1, storageType: "persistent" });
    const taskId = getTaskId(id);
    const db = admin.firestore();

    const taskDoc = await db.doc(`tasks/${taskId}`).get();
    expect(taskDoc.exists).toBe(true);
    expect(taskDoc.get("storageType")).toBe("persistent");
    expect(taskDoc.get("expireAt")).toBeUndefined();

    const codeHash = taskDoc.get("codeHash");
    const codeHashDoc = await db.doc(`code-hashes/${codeHash}`).get();
    expect(codeHashDoc.exists).toBe(true);
    expect(codeHashDoc.get("expireAt")).toBeUndefined();
  });

  it("should extend expireAt on update/increment of ephemeral tasks", async () => {
    const id = await taskStorer.create({ task: TASK1, storageType: "memory" });
    const taskId = getTaskId(id);
    const db = admin.firestore();

    const oldExpireAt = new Date(Date.now() + 1000 * 60 * 60); // 1 hour from now
    const taskRef = db.doc(`tasks/${taskId}`);
    const taskDoc = await taskRef.get();
    const codeHash = taskDoc.get("codeHash");
    const codeHashRef = db.doc(`code-hashes/${codeHash}`);

    await taskRef.update({ expireAt: oldExpireAt });
    await codeHashRef.update({ expireAt: oldExpireAt });

    // Now re-create/increment the same task
    await taskStorer.create({ task: TASK1, storageType: "memory" });

    const updatedTaskDoc = await taskRef.get();
    const updatedExpireAt = updatedTaskDoc.get("expireAt").toDate();
    expect(updatedExpireAt.getTime()).toBeGreaterThan(oldExpireAt.getTime() + 1000 * 60 * 60); // should be extended to ~24 hours
    const diff = updatedExpireAt.getTime() - Date.now();
    expect(diff).toBeGreaterThan(23.9 * 60 * 60 * 1000);

    const updatedCodeHashDoc = await codeHashRef.get();
    expect(updatedCodeHashDoc.get("expireAt").toDate().getTime()).toBe(updatedExpireAt.getTime());
  });

  it("should recreate task if deleted but code-hash exists", async () => {
    const id = await taskStorer.create({ task: TASK1, storageType: "memory" });
    const taskId = getTaskId(id);
    const db = admin.firestore();

    const taskRef = db.doc(`tasks/${taskId}`);
    const taskDoc = await taskRef.get();
    const codeHash = taskDoc.get("codeHash");
    const codeHashRef = db.doc(`code-hashes/${codeHash}`);

    // Simulate TTL by deleting the task document, but keeping the code-hash document
    await taskRef.delete();

    // Now call create, which should encounter NOT_FOUND and recreate the task
    const id2 = await taskStorer.create({ task: TASK1, storageType: "memory" });
    expect(id2).toBe(id);

    const recreatedTaskDoc = await taskRef.get();
    expect(recreatedTaskDoc.exists).toBe(true);
    expect(recreatedTaskDoc.get("count")).toBe(1);
    expect(recreatedTaskDoc.get("expireAt")).toBeDefined();

    const recreatedExpireAt = recreatedTaskDoc.get("expireAt").toDate();
    const diff = recreatedExpireAt.getTime() - Date.now();
    expect(diff).toBeGreaterThan(23.9 * 60 * 60 * 1000);

    const updatedCodeHashDoc = await codeHashRef.get();
    expect(updatedCodeHashDoc.get("expireAt").toDate().getTime()).toBe(recreatedExpireAt.getTime());
  });
});
