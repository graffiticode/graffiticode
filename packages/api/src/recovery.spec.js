// Recovery end to end: the gateway's data path, policy and the broker, all
// real (in-memory stores), with only the compiler and the provider stubbed.
// The stub compiler does what L0176's brokered path does for one save: a
// snapshot, a mint and a broker execute, keyed by the invocation and stage the
// gateway hands it.
import { generateKeyPair, exportJWK } from "jose";
import {
  createPolicy,
  createLocalSigner,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createAudit,
  createPseudonymizer,
  PolicyDenied
} from "@graffiticode/policy";
import {
  createBroker,
  buildOperations,
  createMemoryOnceStore,
  createMemoryReceiptStore,
  createMemorySecretStore,
  argsDigest
} from "@graffiticode/broker";
import { buildDataApi } from "./data.js";
import { inputDigest, InvocationRefused } from "./invocations.js";
import { buildMemoryArtifactStorer } from "./storage/artifacts.js";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";

const OWNER = "0xowner";
const L0176 = { role: "compiler", lang: "0176" };
const TASK = { lang: "0176", code: { 1: { tag: "NUM", elts: ["1"] }, root: 1 } };
const WRITE = {
  questionRecords: [{ type: "mcq", reference: "q-0", data: { type: "mcq", stimulus: "Q" } }],
  itemRecords: [{ reference: "graffiticode-t-0", definition: { widgets: [{ reference: "q-0" }] }, status: "unpublished" }]
};

let policy;
let connections;
let routes;
let loseItems;
let artifactFailures;
let artifactStorer;
let dataApi;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  const audit = createAudit({ sink: () => {}, pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) });
  connections = createMemoryConnectionStore([{ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" }]);
  policy = createPolicy({ signer, jwks, connections, invocations: createMemoryInvocationStore(), audit });

  routes = [];
  loseItems = false;
  const broker = createBroker({
    jwks,
    audit,
    operations: buildOperations({
      sdk: { init: (service, consumer, secret, body) => ({ service, body }) },
      domain: "d",
      dataApi: async ({ route }) => {
        routes.push(route);
        if (loseItems && route === "/itembank/items") throw new Error("socket hang up");
        return { meta: { status: true } };
      }
    }),
    secrets: createMemorySecretStore({ "conn-1": { ownerUid: OWNER, backend: "learnosity", key: "k", secret: "s" } }),
    once: createMemoryOnceStore(),
    receipts: createMemoryReceiptStore()
  });

  const compile = async ({ uid, connectionId, invocationToken, stage }) => {
    try {
      const { sessionToken } = await policy.snapshot({
        caller: L0176, user: { uid }, lang: "0176", connectionId, fns: ["save-to-itembank"], invocationToken, stage
      });
      const { executionToken } = await policy.mint({
        caller: L0176, sessionToken, fn: "save-to-itembank", op: "learnosity.write-items", occurrenceId: "SAVE_TO_ITEMBANK:12.0", argsDigest: argsDigest(WRITE)
      });
      const out = await broker.execute({ caller: L0176, token: executionToken, op: "learnosity.write-items", payload: WRITE });
      if (out.status !== "succeeded") return { errors: [{ message: `Item bank save ${out.status}` }], cache: false };
      return { data: { type: "questions", data: { itemBank: out.result } }, errors: [], cache: false };
    } catch (e) {
      return { errors: [{ message: String(e.message) }], cache: false };
    }
  };

  const allocateInvocation = async ({ authToken, connectionId, taskId, options, idempotencyKey }) => {
    try {
      return await policy.allocateInvocation({
        caller: { role: "gateway" }, user: { uid: authToken }, connectionId, taskId, inputDigest: inputDigest(options), idempotencyKey
      });
    } catch (e) {
      if (e instanceof PolicyDenied) throw new InvocationRefused(e.reason);
      throw e;
    }
  };

  artifactFailures = 0;
  const memory = buildMemoryArtifactStorer();
  artifactStorer = {
    put: async artifact => {
      if (artifactFailures > 0) {
        artifactFailures--;
        throw new Error("firestore unavailable");
      }
      return memory.put(artifact);
    },
    getCurrent: query => memory.getCurrent(query)
  };
  dataApi = buildDataApi({ compile, allocateInvocation, artifactStorer });
});

const run = (idempotencyKey = "job-1") => dataApi.get({
  taskStorer: { get: async () => [TASK] },
  compileStorer: { get: async () => undefined, create: async () => {} },
  id: "task-1",
  auth: { uid: OWNER },
  authToken: OWNER,
  connectionId: "conn-1",
  idempotencyKey,
  action: {}
});
const current = () => artifactStorer.getCurrent({ uid: OWNER, taskId: "task-1", connectionId: "conn-1", registryVersion: REGISTRY_VERSION });

describe("recovery", () => {
  it("stores the artifact when its write fails and then succeeds within the request", async () => {
    artifactFailures = 1;
    expect((await run()).errors).toEqual([]);
    expect((await current()).status).toBe("ok");
    expect(routes).toEqual(["/itembank/questions", "/itembank/items"]);
  });

  it("recovers a completed save whose artifact was lost by retrying the invocation, without writing again", async () => {
    artifactFailures = 3;
    expect((await run()).errors).toEqual([]);
    expect((await current()).status).toBe("missing");

    const retry = await run();
    expect(retry.errors).toEqual([]);
    expect(retry.data.data.itemBank).toMatchObject({ saved: true });
    expect((await current()).status).toBe("ok");
    expect(routes).toEqual(["/itembank/questions", "/itembank/items"]);
  });

  it("blocks the retry of an uncertain save, and writes again only for a new key", async () => {
    loseItems = true;
    expect((await run()).errors[0].message).toMatch(/uncertain/);
    loseItems = false;
    expect((await run()).errors[0].message).toMatch(/uncertain/);
    expect(routes).toEqual(["/itembank/questions", "/itembank/items"]);

    expect((await run("job-2")).errors).toEqual([]);
    expect(routes).toHaveLength(4);
    expect((await current()).status).toBe("ok");
  });

  it("refuses the retry once the connection is revoked, without contacting the provider", async () => {
    artifactFailures = 3;
    await run();
    await connections.put({ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "disabled" });

    const retry = await run();
    expect(retry.errors[0].message).toMatch(/permission denied \(connection-disabled\)/);
    expect(routes).toEqual(["/itembank/questions", "/itembank/items"]);
    expect((await current()).status).toBe("missing");
  });
});
