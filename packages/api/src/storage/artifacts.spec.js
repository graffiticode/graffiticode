import { buildArtifactStorer, buildMemoryArtifactStorer } from "./artifacts.js";

// The contract, against the in-memory store always and against Firestore when
// the emulator is running (npm test starts it).
const stores = [["memory", () => buildMemoryArtifactStorer()]];
if (process.env.FIRESTORE_EMULATOR_HOST) stores.push(["firestore", () => buildArtifactStorer()]);

const RV = 2;
const base = { uid: "u1", ownerUid: "u1", connectionId: "conn-1", taskId: "task-1", registryVersion: RV };
const query = { uid: "u1", taskId: "task-1", connectionId: "conn-1", registryVersion: RV };
let n = 0;
const unique = () => `${Date.now()}-${n++}`;

describe.each(stores)("storage/artifacts (%s)", (_, build) => {
  let store;
  let q;
  let b;
  beforeEach(() => {
    store = build();
    const taskId = `task-${unique()}`;
    q = { ...query, taskId };
    b = { ...base, taskId };
  });

  it("serves the artifact of the newest invocation", async () => {
    await store.put({ ...b, invocationId: `inv-${unique()}`, seq: 1, content: { v: 1 } });
    await store.put({ ...b, invocationId: `inv-${unique()}`, seq: 2, content: { v: 2 } });
    const got = await store.getCurrent(q);
    expect(got.status).toBe("ok");
    expect(got.artifact.content).toEqual({ v: 2 });
  });

  it("never lets an older invocation that finished late replace a newer result", async () => {
    await store.put({ ...b, invocationId: `inv-${unique()}`, seq: 2, content: { v: 2 } });
    const late = await store.put({ ...b, invocationId: `inv-${unique()}`, seq: 1, content: { v: 1 } });
    expect(late.current).toBe(false);
    expect((await store.getCurrent(q)).artifact.content).toEqual({ v: 2 });
  });

  it("lets a retry of the same invocation rewrite its own artifact", async () => {
    const invocationId = `inv-${unique()}`;
    await store.put({ ...b, invocationId, seq: 1, content: { v: "first" } });
    await store.put({ ...b, invocationId, seq: 1, content: { v: "retry" } });
    expect((await store.getCurrent(q)).artifact.content).toEqual({ v: "retry" });
  });

  it("selects only the recipient's own artifact for that connection", async () => {
    await store.put({ ...b, invocationId: `inv-${unique()}`, seq: 5, content: { v: "u1" } });
    await store.put({ ...b, uid: "u2", invocationId: `inv-${unique()}`, seq: 9, content: { v: "u2" } });
    expect((await store.getCurrent(q)).artifact.content).toEqual({ v: "u1" });
    expect((await store.getCurrent({ ...q, uid: "u3" })).status).toBe("missing");
    expect((await store.getCurrent({ ...q, connectionId: "conn-2" })).status).toBe("missing");
  });

  it("reports an artifact from another registry version as incompatible", async () => {
    await store.put({ ...b, invocationId: `inv-${unique()}`, seq: 1, content: { v: 1 } });
    expect((await store.getCurrent({ ...q, registryVersion: RV + 1 })).status).toBe("incompatible");
  });

  it("keeps shapes Firestore cannot hold natively", async () => {
    const content = { rows: [[1, 2], [3, 4]] };
    await store.put({ ...b, invocationId: `inv-${unique()}`, seq: 1, content });
    expect((await store.getCurrent(q)).artifact.content).toEqual(content);
  });
});
