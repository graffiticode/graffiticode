// Publication end to end: the gateway's publish routes and published-view
// read path with real policy (in-memory stores). The stub compiler signs the
// way L0176 does for the read path's data-only program: a snapshot, then a
// mint for the preview signature.
import express from "express";
import request from "supertest";
import { generateKeyPair, exportJWK } from "jose";
import {
  createPolicy,
  createLocalSigner,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createMemoryPublicationStore,
  createAudit,
  createPseudonymizer,
  PolicyDenied
} from "@graffiticode/policy";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { buildDataApi } from "./data.js";
import { InvocationRefused } from "./invocations.js";
import { buildMemoryArtifactStorer } from "./storage/artifacts.js";
import publicationsRouter from "./routes/publications.js";

const OWNER = "0xowner";
const OTHER = "0xother";
const L0176 = { role: "compiler", lang: "0176" };
const GATEWAY = { role: "gateway" };
const TASK = { lang: "0176", code: { 1: { tag: "NUM", elts: ["1"] }, root: 1 } };
const ACTIVITY = { type: "questions", data: { questions: [] } };

let policy;
let connections;
let artifactStorer;
let dataApi;
let app;
let snapshots;

// Policy errors surface to the gateway as refusals, as over HTTP.
const asGateway = fn => async (...args) => {
  try {
    return await fn(...args);
  } catch (e) {
    if (e instanceof PolicyDenied) throw new InvocationRefused(e.reason);
    throw e;
  }
};

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  const audit = createAudit({ sink: () => {}, pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) });
  connections = createMemoryConnectionStore([{ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" }]);
  policy = createPolicy({
    signer, jwks, connections, invocations: createMemoryInvocationStore(), publications: createMemoryPublicationStore(), audit
  });

  snapshots = [];
  const compile = async ({ uid, auth, connectionId, invocationToken, stage, code }) => {
    try {
      const snap = await policy.snapshot({
        caller: L0176,
        user: uid ? { uid } : null,
        lang: "0176",
        connectionId,
        fns: ["preview-itembank", "save-to-itembank"],
        invocationToken,
        stage
      });
      snapshots.push({ uid, auth, allowed: snap.allowed, mode: snap.mode });
      await policy.mint({
        caller: L0176, sessionToken: snap.sessionToken, fn: "preview-itembank", op: "learnosity.sign-questions-preview", occurrenceId: "prog.0", argsDigest: "a".repeat(64)
      });
      const activity = JSON.parse(code[1].elts[0]);
      return { data: { ...activity, request: "signed" }, errors: [], cache: false };
    } catch (e) {
      return { errors: [{ message: String(e.message) }], cache: false };
    }
  };
  const publications = {
    create: asGateway(({ authToken, ...rest }) => policy.createPublication({ caller: GATEWAY, user: { uid: authToken }, ...rest })),
    remove: asGateway(({ authToken, publicationId }) => policy.deletePublication({ caller: GATEWAY, user: { uid: authToken }, publicationId })),
    authorizeView: asGateway(({ publicationId }) => policy.authorizeView({ caller: GATEWAY, publicationId }))
  };
  artifactStorer = buildMemoryArtifactStorer();
  dataApi = buildDataApi({ compile, artifactStorer, publications });

  const taskStorer = { get: async () => [TASK] };
  app = express();
  app.use(express.json());
  // Stand-in for the auth middleware: the bearer token is the uid.
  app.use((req, _res, next) => {
    const uid = (req.get("Authorization") || "").replace(/^Bearer /, "");
    req.auth = { context: uid ? { uid } : null };
    next();
  });
  app.use("/publications", publicationsRouter({ taskStorer, artifactStorer, publications }));
});

// What an explicit run through the connection leaves behind.
const ran = (uid = OWNER) => artifactStorer.put({
  uid, ownerUid: OWNER, connectionId: "conn-1", taskId: "task-1", invocationId: `inv-${uid}`, seq: 1, registryVersion: REGISTRY_VERSION, content: { data: ACTIVITY, errors: [] }
});
const publish = (uid = OWNER) =>
  request(app).post("/publications").set("Authorization", `Bearer ${uid}`).send({ id: "task-1", connectionId: "conn-1" });
const view = (publicationId, id = "task-1") => dataApi.get({
  taskStorer: { get: async () => [TASK] },
  compileStorer: { get: async () => undefined, create: async () => {} },
  id,
  auth: null,
  authToken: null,
  publicationId,
  read: true,
  action: {}
});

describe("publications", () => {
  it("let an anonymous viewer see the publisher's result, signed for preview only", async () => {
    await ran();
    const res = await publish();
    expect(res.status).toBe(200);
    const out = await view(res.body.data.publicationId);
    expect(out).toEqual({ data: { ...ACTIVITY, request: "signed" }, errors: [] });
    expect(snapshots).toEqual([{ uid: null, auth: null, allowed: ["preview-itembank"], mode: "render" }]);
  });

  it("publish only the caller's own current result", async () => {
    expect((await publish()).status).toBe(409);
    await ran(OTHER);
    expect((await publish(OWNER)).status).toBe(409);
    expect((await request(app).post("/publications").send({ id: "task-1", connectionId: "conn-1" })).status).toBe(401);
  });

  it("refuse a publisher who does not own the connection", async () => {
    await ran(OTHER);
    const res = await publish(OTHER);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/not-owner/);
  });

  it("stop views once unpublished, or once the connection is disabled", async () => {
    await ran();
    const { publicationId } = (await publish()).body.data;
    await connections.put({ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "disabled" });
    expect((await view(publicationId)).errors[0].message).toMatch(/not published \(connection-disabled\)/);
    await connections.put({ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" });
    expect((await view(publicationId)).errors).toEqual([]);

    expect((await request(app).delete(`/publications/${publicationId}`).set("Authorization", `Bearer ${OTHER}`)).status).toBe(403);
    expect((await request(app).delete(`/publications/${publicationId}`).set("Authorization", `Bearer ${OWNER}`)).status).toBe(200);
    expect((await view(publicationId)).errors[0].message).toMatch(/not published \(publication-not-found\)/);
  });

  it("serve a publication only for its own task", async () => {
    await ran();
    const { publicationId } = (await publish()).body.data;
    expect((await view(publicationId, "task-2")).errors[0].message).toMatch(/for another item/);
    expect(snapshots).toEqual([]);
  });
});
