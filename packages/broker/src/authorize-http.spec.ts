/* eslint-disable camelcase -- Google ID-token wire field */
// Broker's production authorizer against Policy's own HTTP app, on a local
// port: the `/v1/authorize-execution` route itself, not an in-process stand-in.
// A conditional step's later attempt (C5 decision 5) must reach Policy with
// its `attempt`, or the registry refuses it as `step-not-registered`.
import { createServer } from "node:http";
import { generateKeyPair, exportJWK } from "jose";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { encodeChainId } from "@graffiticode/common/chain";
import {
  createPolicy,
  createPolicyApp,
  createCallerIdentity,
  createAudit,
  createPseudonymizer,
  createLocalSigner,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createMemoryLeaseFence,
  createMemoryApprovals,
  createMemoryPublicationStore,
  createMemoryCommandStore,
  createMemoryCommandBackend,
  createCommandRecords,
  createProtectedSwitch,
  createMemoryItemAuthority,
  createMemoryStagingStore,
} from "@graffiticode/policy";
import {
  createBroker,
  buildThumbnailOperations,
  buildPolicyAuthorizer,
  createMemoryOnceStore,
  createMemoryReceiptStore,
  createMemoryActivityStore,
  createMemorySecretStore,
  PreconditionFailed,
  sha256Hex,
  argsDigest,
} from "./index.js";

const OWNER = "0xowner";
const ITEM = "privateItem00000001";
const GATEWAY = { role: "gateway" };
const L0013 = { role: "compiler", lang: "0013" };
const AUD = "urn:graffiticode:policy";
const BROKER_SA = "broker-run@graffiticode.iam.gserviceaccount.com";
const hex = c => c.repeat(64);
const IMAGE = `sha256:${hex("3")}`;
const SNAP = { id: "snap", fn: "snap", op: "gcs.put-thumbnail", occurrences: ["n0.0"], scope: { kind: "item", id: ITEM } };

// Stand-in for Google's ID-token verification: "idt|<email>|<audience>".
const verifyIdToken = async (token, audience) => {
  const [kind, email, aud] = token.split("|");
  if (kind !== "idt" || aud !== audience) throw new Error("bad token");
  return { iss: "https://accounts.google.com", email, email_verified: true, aud };
};
// What Broker's idToken gives: the caller token for Policy's URN, and for the
// invoker header the token Cloud Run would forward with its signature stripped.
const idToken = async audience => audience === AUD
  ? `idt|${BROKER_SA}|${AUD}`
  : `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ email: BROKER_SA })).toString("base64url")}.`;

let server;
afterEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  server = null;
});

it("authorizes a put-thumbnail retry after a 412 over Policy's HTTP route, keeping each attempt", async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  const records = [];
  const audit = createAudit({ sink: r => records.push(r), pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) });
  const leases = new Map();
  const invocations = createMemoryInvocationStore({ leases });
  const commandStore = createMemoryCommandStore({ invocationStore: invocations });
  const protectedSwitch = createProtectedSwitch({ readFlag: async () => ({ enabled: true }) });
  const policy = createPolicy({
    signer,
    jwks,
    connections: createMemoryConnectionStore([]),
    invocations,
    commands: commandStore,
    commandRecords: createCommandRecords({ backend: createMemoryCommandBackend({ commandStore }) }),
    publications: createMemoryPublicationStore(),
    audit,
    protectedSwitch,
    approvals: createMemoryApprovals(new Map([["0013/l0013r-r1", { lang: "0013", revision: "l0013r-r1", imageDigest: IMAGE, tag: "t", tagUrl: "https://t", status: "approved", contractVersions: [3] }]])),
    fence: createMemoryLeaseFence({ leases }),
    itemAuthority: createMemoryItemAuthority({ [ITEM]: { ownerUid: OWNER, isPublic: false, taskId: "itemTask" } }),
    staging: createMemoryStagingStore(),
  });

  // Policy's HTTP app on an ephemeral port, counting what reaches the route.
  const app = createPolicyApp({
    policy,
    manager: {},
    identifyCaller: createCallerIdentity({ verifyIdToken, audience: AUD, callers: { [BROKER_SA]: { role: "broker" } } }),
    verifyUser: async () => { throw new Error("no user on this route"); },
    publicJwks: jwks,
    audit,
  });
  const routed = [];
  server = createServer((req, res) => {
    if (req.url === "/v1/authorize-execution") routed.push(req.method);
    app(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const policyUrl = `http://127.0.0.1:${server.address().port}`;

  // An admitted capture, its occurrence reserved, staged and bound.
  const { commandId } = (await policy.allocateCommand({ caller: GATEWAY, user: { uid: OWNER }, taskId: encodeChainId(["task-0"]), inputDigest: hex("9"), idempotencyKey: "job-1", lang: "0013", request: "{}", worker: "api-1", scopes: 1 })) as any;
  await policy.commandWrite({ caller: GATEWAY, commandId, generation: 1, fn: "installModel", args: { stage: "s0", text: JSON.stringify({ lang: "0013", kind: "plan", carried: {}, intents: [SNAP] }) } });
  await policy.admitCommand({ caller: GATEWAY, commandId, generation: 1, taskIds: ["task-0"], scopes: 1, stages: [{ stage: "s0", lang: "0013", sourceDigest: hex("b"), programDigest: hex("c"), optionsDigest: hex("d"), revision: "l0013r-r1", imageDigest: IMAGE, registryVersion: REGISTRY_VERSION, requiredFunctions: ["snap"] }] });
  const bytes = new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("test")]));
  const { sessionToken } = await policy.commandSession({ caller: GATEWAY, commandId, generation: 1, stage: "s0" });
  const reserved = await policy.commandReserve({ caller: L0013, sessionToken, occurrenceId: "n0.0", intentId: "snap" });
  await policy.commandStage({ caller: L0013, sessionToken, occurrenceId: "n0.0", png: Buffer.from(bytes).toString("base64") });
  const payload = { item: ITEM, captureSequence: reserved.captureSequence, sha256: sha256Hex(bytes) };
  const argd = argsDigest(payload);
  await policy.commandWrite({ caller: GATEWAY, commandId, generation: 1, fn: "bindOccurrence", args: { stage: "s0", occurrenceId: "n0.0", intentId: "snap", args: JSON.stringify(payload), argd } });
  const { executionToken } = await policy.mint({ caller: L0013, sessionToken, fn: "snap", op: "gcs.put-thumbnail", occurrenceId: "n0.0", argsDigest: argd });

  // The first publish answers 412; the next one publishes.
  const sends = [];
  const storage = {
    read: async () => bytes,
    getMetadata: async () => null,
    prepareUpload: async () => ({
      send: async () => {
        sends.push(sends.length + 1);
        if (sends.length === 1) throw new PreconditionFailed("412");
        return { generation: "1001" };
      },
    }),
  };
  const receipts = createMemoryReceiptStore();
  const broker = createBroker({
    protectedSwitch,
    jwks,
    operations: buildThumbnailOperations({ storage, buckets: { thumbnails: "graffiticode-c5a-gate", staging: "graffiticode-command-staging" }, attempts: 4 }),
    once: createMemoryOnceStore(),
    receipts,
    activity: createMemoryActivityStore(),
    secrets: createMemorySecretStore({}),
    authorize: buildPolicyAuthorizer({ policyUrl, idToken }),
    audit: async () => {},
  });

  const out = await broker.execute({ caller: L0013, token: executionToken, op: "gcs.put-thumbnail", payload });
  // Unfixed, the route drops `attempt`, and attempt 2 is refused.
  expect(records.filter(r => r.event === "authorize-execution" && r.reason === "step-not-registered")).toEqual([]);
  expect(out).toMatchObject({ status: "succeeded", steps: ["publish"] });
  expect(sends).toEqual([1, 2]);

  // Both decisions came over HTTP, each recorded with its own attempt.
  expect(routed).toEqual(["POST", "POST"]);
  const decisions = records.filter(r => r.event === "authorize-execution");
  expect(decisions.map(r => [r.outcome, r.step, r.attempt])).toEqual([["allowed", "publish", 1], ["allowed", "publish", 2]]);
  expect(decisions.every(r => typeof r.decisionId === "string")).toBe(true);
  expect(decisions[0].decisionId).not.toBe(decisions[1].decisionId);
  // Broker's receipt keeps the same two decisions against their attempts.
  const { opid } = JSON.parse(Buffer.from(executionToken.split(".")[1], "base64url").toString("utf8"));
  const attempts = await receipts.getStepAttempts(opid);
  expect(attempts.map(t => [t.attempt, t.observed, t.decisionId])).toEqual([
    [1, "precondition-failed", decisions[0].decisionId],
    [2, "published", decisions[1].decisionId],
  ]);
});
