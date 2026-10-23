import { jest } from "@jest/globals";
import { generateKeyPair, exportJWK } from "jose";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import {
  createPolicy, createLocalSigner, createMemoryConnectionStore, createMemoryInvocationStore,
  createMemoryPublicationStore, createProtectedSwitch
} from "@graffiticode/policy";
import {
  createBroker, buildOperations, createMemoryOnceStore, createMemoryReceiptStore,
  createMemoryActivityStore, createMemorySecretStore, localAuthorizer, argsDigest
} from "@graffiticode/broker";
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

  it("signs every repeated view from the stored activity, under the artifact's one invocation, never the source", async () => {
    await store();
    const put = jest.spyOn(artifactStorer, "put");
    for (let i = 0; i < 4; i++) {
      await expect(read()).resolves.toEqual({ data: { ...ACTIVITY, request: "signed" }, errors: [] });
    }
    expect(compile).toHaveBeenCalledTimes(4);
    for (const [args] of compile.mock.calls) {
      expect(args).toMatchObject({ code: signProgram(ACTIVITY), stage: "read" });
    }
    expect(allocateInvocation.mock.calls.map(([args]) => args.idempotencyKey)).toEqual(Array(4).fill("read.inv-run"));
    expect(put).not.toHaveBeenCalled();
  });

  it("keeps a stored save result whole through the view's signing (the Form's saved marker reads it)", async () => {
    const itemBank = { saved: true, references: ["gc-item-1"], questionReferences: ["gc-q-1"] };
    const saved = { type: "questions", data: { questions: [], itemBank } };
    await store({ content: { data: saved, errors: [] } });
    // As L0176 signs it: the data literal back, with a fresh request.
    compile.mockImplementation(async ({ code }) => ({ data: { ...JSON.parse(code[1].elts[0]), request: "signed" }, errors: [], cache: false }));
    await expect(read()).resolves.toEqual({ data: { ...saved, request: "signed" }, errors: [] });
    expect(compile).toHaveBeenCalledWith(expect.objectContaining({ code: signProgram(saved), stage: "read" }));
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

it("renders a stored composed item through real v2 Policy and Broker without running its source", async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  const protectedSwitch = createProtectedSwitch({ readFlag: async () => ({ enabled: true }) });
  const policy = createPolicy({
    signer,
    jwks,
    protectedSwitch,
    minContractVersion: 2,
    audit: async () => {},
    connections: createMemoryConnectionStore([{ connectionId: READ.connectionId, ownerUid: READ.uid, backend: "learnosity", status: "active" }]),
    invocations: createMemoryInvocationStore(),
    publications: createMemoryPublicationStore(),
  });
  const provider = jest.fn();
  const broker = createBroker({
    jwks,
    protectedSwitch,
    minContractVersion: 2,
    audit: async () => {},
    operations: buildOperations({ sdk: { init: () => "fresh-preview" }, domain: "example.org", dataApi: provider }),
    secrets: createMemorySecretStore({ "preview-connection": { ownerUid: "system", backend: "learnosity", key: "k", secret: "s" } }),
    previewConnections: { learnosity: "preview-connection" },
    once: createMemoryOnceStore(),
    receipts: createMemoryReceiptStore(),
    activity: createMemoryActivityStore(),
    authorize: localAuthorizer(policy),
  });
  const artifactStorer = buildMemoryArtifactStorer();
  await artifactStorer.put({
    ...READ, ownerUid: READ.uid, invocationId: "saved-run", seq: 1, registryVersion: REGISTRY_VERSION, content: STORED,
  });
  const caller = { role: "compiler", lang: "0176" };
  const compile = jest.fn(async ({ code, stage, invocationToken, connectionId }) => {
    expect(code).toEqual(signProgram(ACTIVITY));
    const { sessionToken, allowed } = await policy.snapshot({
      caller, user: { uid: READ.uid }, lang: "0176", connectionId, fns: ["init"], invocationToken, stage,
    });
    expect(allowed).toEqual(["init"]);
    const op = "learnosity.sign-questions-preview";
    const { executionToken } = await policy.mint({ caller, sessionToken, fn: "init", op, occurrenceId: "prog.0", argsDigest: argsDigest(ACTIVITY.data) });
    const out = await broker.execute({ caller, token: executionToken, op, payload: ACTIVITY.data });
    return { data: { ...ACTIVITY, request: out.result.request }, errors: [], cache: false };
  });
  const allocateInvocation = ({ connectionId, taskId, idempotencyKey }) => policy.allocateInvocation({
    caller: { role: "gateway" }, user: { uid: READ.uid }, connectionId, taskId, idempotencyKey, inputDigest: "a".repeat(64),
  });
  const api = buildDataApi(/** @type {any} */ ({ compile, allocateInvocation, artifactStorer }));
  // Neither source stage is executed by a read, and no whole-chain
  // admission is needed to sign the stored activity.
  const taskStorer = { get: async () => [L0176_TASK, L0000_TASK] };
  for (let i = 0; i < 2; i++) {
    const out = await api.get({ taskStorer, compileStorer, id: READ.taskId, auth: { uid: READ.uid }, authToken: "user", connectionId: READ.connectionId, read: true, options: {}, action: {}, refresh: false });
    expect(out).toEqual({ data: { ...ACTIVITY, request: "fresh-preview" }, errors: [] });
  }
  expect(compile).toHaveBeenCalledTimes(2);
  expect(provider).not.toHaveBeenCalled();
  expect((await artifactStorer.getByInvocation("saved-run")).content).toEqual(STORED);
});
