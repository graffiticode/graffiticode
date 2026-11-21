/* eslint-disable camelcase -- Google ID-token wire field */
// The gateway's bind route, PUT /v1/commands/:id/occurrences/:stage/:occ, over
// Policy's own HTTP app on a local port, under a real caller identity and
// memory stores. An item-scoped occurrence (C5 decision 9) binds only with
// Broker's digest of the staged payload (`argd`), so the route must forward
// it: without it every such bind was refused `binding-mismatch`.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { encodeChainId } from "@graffiticode/common/chain";
import { canonicalDigest } from "@graffiticode/common/canonical";
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
} from "./index.js";

const OWNER = "0xowner";
const ITEM = "privateItem00000001";
const GATEWAY = { role: "gateway" };
const L0013 = { role: "compiler", lang: "0013" };
const AUD = "urn:graffiticode:policy";
const GATEWAY_SA = "api-run@graffiticode.iam.gserviceaccount.com";
const hex = c => c.repeat(64);
const IMAGE = `sha256:${hex("3")}`;
const SNAP = { id: "snap", fn: "snap", op: "gcs.put-thumbnail", occurrences: ["n0.0"], scope: { kind: "item", id: ITEM } };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("test")]);

// Stand-in for Google's ID-token verification: "idt|<email>|<audience>".
const verifyIdToken = async (token, audience) => {
  const [kind, email, aud] = token.split("|");
  if (kind !== "idt" || aud !== audience) throw new Error("bad token");
  return { iss: "https://accounts.google.com", email, email_verified: true, aud };
};
// What Cloud Run forwards: the invoker token with its signature stripped.
const forwarded = email =>
  `Bearer ${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.`;

let server;
let policyUrl;
let policy;
let commandStore;
let backend;
let keys = 0;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  const audit = createAudit({ sink: () => {}, pseudonymize: createPseudonymizer({ secret: "test-secret-0123456789" }) });
  const leases = new Map();
  const invocations = createMemoryInvocationStore({ leases });
  commandStore = createMemoryCommandStore({ invocationStore: invocations });
  backend = createMemoryCommandBackend({ commandStore });
  policy = createPolicy({
    signer,
    jwks,
    connections: createMemoryConnectionStore([]),
    invocations,
    commands: commandStore,
    commandRecords: createCommandRecords({ backend }),
    publications: createMemoryPublicationStore(),
    audit,
    protectedSwitch: createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
    approvals: createMemoryApprovals(new Map([["0013/l0013r-r1", { lang: "0013", revision: "l0013r-r1", imageDigest: IMAGE, tag: "t", tagUrl: "https://t", status: "approved", contractVersions: [3] }]])),
    fence: createMemoryLeaseFence({ leases }),
    itemAuthority: createMemoryItemAuthority({ [ITEM]: { ownerUid: OWNER, isPublic: false, taskId: "itemTask" } }),
    staging: createMemoryStagingStore(),
  });
  const app = createPolicyApp({
    policy,
    manager: {},
    identifyCaller: createCallerIdentity({ verifyIdToken, audience: AUD, callers: { [GATEWAY_SA]: { role: "gateway" } } }),
    verifyUser: async () => { throw new Error("no user on this route"); },
    publicJwks: jwks,
    audit,
  });
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  policyUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  server = null;
});

// An admitted L0013 capture whose occurrence n0.0 is reserved and staged.
const staged = async () => {
  const { commandId } = (await policy.allocateCommand({ caller: GATEWAY, user: { uid: OWNER }, taskId: encodeChainId(["task-0"]), inputDigest: hex("9"), idempotencyKey: `job-${++keys}`, lang: "0013", request: "{}", worker: "api-1", scopes: 1 })) as any;
  await policy.commandWrite({ caller: GATEWAY, commandId, generation: 1, fn: "installModel", args: { stage: "s0", text: JSON.stringify({ lang: "0013", kind: "plan", carried: {}, intents: [SNAP] }) } });
  await policy.admitCommand({ caller: GATEWAY, commandId, generation: 1, taskIds: ["task-0"], scopes: 1, stages: [{ stage: "s0", lang: "0013", sourceDigest: hex("b"), programDigest: hex("c"), optionsDigest: hex("d"), revision: "l0013r-r1", imageDigest: IMAGE, registryVersion: REGISTRY_VERSION, requiredFunctions: ["snap"] }] });
  const { sessionToken } = await policy.commandSession({ caller: GATEWAY, commandId, generation: 1, stage: "s0" });
  const reserved = await policy.commandReserve({ caller: L0013, sessionToken, occurrenceId: "n0.0", intentId: "snap" });
  await policy.commandStage({ caller: L0013, sessionToken, occurrenceId: "n0.0", png: PNG.toString("base64") });
  const payload = { item: ITEM, captureSequence: reserved.captureSequence, sha256: createHash("sha256").update(PNG).digest("hex") };
  return { commandId, payload, argd: canonicalDigest(payload) };
};

// The gateway's PUT of the bind, as its own service identity.
const bind = async (commandId, body) => {
  const res = await fetch(`${policyUrl}/v1/commands/${commandId}/occurrences/s0/n0.0`, {
    method: "PUT",
    headers: { "content-type": "application/json", "X-Caller-Identity": `idt|${GATEWAY_SA}|${AUD}`, "X-Serverless-Authorization": forwarded(GATEWAY_SA) },
    body: JSON.stringify({ generation: 1, intentId: "snap", ...body }),
  });
  return { status: res.status, body: (await res.json()) as any };
};

// The command and every record under it: occurrences, reservations, outcomes,
// refusals and the rest.
const recordsOf = commandId => ({
  command: structuredClone(commandStore.commands.get(commandId)),
  docs: Object.fromEntries([...backend.docs.entries()].filter(([k]) => k.startsWith(`commands/${commandId}/`)).map(([k, d]) => [k, structuredClone(d)])),
});
const occurrenceKey = commandId => Object.keys(recordsOf(commandId).docs).find(k => k.startsWith(`commands/${commandId}/occurrences/`));
const reservationKey = commandId => Object.keys(recordsOf(commandId).docs).find(k => k.startsWith(`commands/${commandId}/reservations/`));

describe("PUT /v1/commands/:id/occurrences/:stage/:occ (an item-scoped bind)", () => {
  it("binds a staged capture with the matching argd, and records that argd", async () => {
    const { commandId, payload, argd } = await staged();
    const res = await bind(commandId, { args: JSON.stringify(payload), argd });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ stage: "s0", occurrenceId: "n0.0", bound: true });
    const after = recordsOf(commandId);
    expect(after.docs[occurrenceKey(commandId)]).toMatchObject({ stage: "s0", occurrenceId: "n0.0", intentId: "snap", args: JSON.stringify(payload), argd, item: ITEM });
    expect(after.docs[reservationKey(commandId)]).toMatchObject({ state: "staged" });
    expect(Object.keys(after.docs).some(k => k.includes("/refusals/"))).toBe(false);
  });

  it.each([
    ["missing", () => ({})],
    ["mismatched", () => ({ argd: hex("e") })],
  ])("refuses a %s argd as binding-mismatch, recording only the refusal", async (_label, argdOf) => {
    const { commandId, payload } = await staged();
    const before = recordsOf(commandId);
    const res = await bind(commandId, { args: JSON.stringify(payload), ...argdOf() });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ reason: "binding-mismatch" });
    const after = recordsOf(commandId);
    // A definite refusal is recorded before it is answered (C6 slice 0), so
    // that, and only that, is new: the command, its reservation and outcomes
    // stand as they were, and no occurrence is bound.
    const refusals = Object.keys(after.docs).filter(k => k.includes("/refusals/"));
    expect(refusals).toHaveLength(1);
    expect(after.docs[refusals[0]]).toMatchObject({ stage: "s0", occurrenceId: "n0.0", intentId: "snap", reason: "binding-mismatch" });
    const { [refusals[0]]: _refusal, ...rest } = after.docs;
    expect(rest).toEqual(before.docs);
    expect(after.command).toEqual(before.command);
    expect(occurrenceKey(commandId)).toBeUndefined();
  });
});
