import { jest } from "@jest/globals";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { buildDataApi } from "./data.js";
import { signProgram } from "./read.js";
import { InvocationRefused } from "./invocations.js";
import { buildMemoryArtifactStorer } from "./storage/artifacts.js";

// Stand-ins for the task and compile storers, so the read path runs without
// Firestore.
const L0176_TASK = { lang: "0176", code: { 1: { tag: "NUM", elts: ["1"] }, root: 1 } };
const L0000_TASK = { lang: "0000", code: { 1: { tag: "NUM", elts: ["1"] }, root: 1 } };
const taskStorerFor = task => ({ get: async () => [task] });
const compileStorer = { get: async () => undefined, create: async () => {} };
const ACTIVITY = { type: "questions", data: { questions: [] } };
const STORED = { data: ACTIVITY, errors: [] };
const READ = { taskId: "task-1", uid: "u1", connectionId: "conn-1" };

describe("the read path", () => {
  let compile;
  let allocateInvocation;
  let artifactStorer;
  let dataApi;
  beforeEach(() => {
    compile = jest.fn(async () => ({ data: { ...ACTIVITY, request: "signed" }, errors: [], cache: false }));
    allocateInvocation = jest.fn(async () => ({ invocationToken: "read.tok", invocationId: "inv-read", seq: 2, ownerUid: "u1" }));
    artifactStorer = buildMemoryArtifactStorer();
    // @ts-expect-error TS-MIGRATE: jest mock typed as an untyped function
    dataApi = buildDataApi({ compile, allocateInvocation, artifactStorer });
  });

  const store = (over = {}) => artifactStorer.put({
    uid: READ.uid,
    ownerUid: READ.uid,
    connectionId: READ.connectionId,
    taskId: READ.taskId,
    invocationId: "inv-run",
    seq: 1,
    registryVersion: REGISTRY_VERSION,
    content: STORED,
    ...over
  });
  const read = (task = L0176_TASK, over = {}) => dataApi.get({
    taskStorer: taskStorerFor(task),
    compileStorer,
    id: READ.taskId,
    auth: { uid: READ.uid },
    authToken: "user",
    connectionId: READ.connectionId,
    read: true,
    action: {},
    ...over
  });

  it("signs the stored activity with a data-only program, never the source", async () => {
    await store();
    const action = {};
    await expect(read(L0176_TASK, { action })).resolves.toEqual({ data: { ...ACTIVITY, request: "signed" }, errors: [] });
    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledWith(expect.objectContaining({
      lang: "0176", code: signProgram(ACTIVITY), connectionId: "conn-1", invocationToken: "read.tok", stage: "read"
    }));
    expect(allocateInvocation).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1", idempotencyKey: "read.inv-run" }));
    expect(action.noStore).toBe(true);
  });

  it("serves a language that does not sign as stored, with no compile", async () => {
    await store();
    await expect(read(L0000_TASK)).resolves.toEqual(STORED);
    expect(compile).not.toHaveBeenCalled();
    expect(allocateInvocation).not.toHaveBeenCalled();
  });

  it("asks for a save or recompile when there is no result, or an incompatible one", async () => {
    expect((await read()).errors[0].message).toMatch(/no result through this connection yet\. Save or recompile/);
    await store({ registryVersion: REGISTRY_VERSION - 1 });
    expect((await read()).errors[0].message).toMatch(/older version\. Recompile/);
    expect(compile).not.toHaveBeenCalled();
  });

  it("serves only the recipient's own result", async () => {
    await store({ uid: "someone-else" });
    expect((await read()).errors[0].message).toMatch(/no result through this connection yet/);
    expect(compile).not.toHaveBeenCalled();
  });

  it("reports a refused view without signing", async () => {
    await store();
    allocateInvocation.mockRejectedValue(new InvocationRefused("connection-disabled"));
    expect((await read()).errors[0].message).toMatch(/permission denied \(connection-disabled\)/);
    expect(compile).not.toHaveBeenCalled();
  });

  it("still runs the program for an explicit compile", async () => {
    await store();
    await read(L0176_TASK, { read: false });
    expect(compile).toHaveBeenCalledWith(expect.objectContaining({ code: L0176_TASK.code, stage: "s0" }));
  });
});
