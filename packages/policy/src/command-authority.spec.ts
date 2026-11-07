// Command authority (B5 slice 3, docs/b5-commands-plan.md §2 decision 6, §4,
// §7): admission bound to the installed models and their intents, under the
// stored principal; a stage's session with cmd and fg; mint and
// authorize-execution checking the owner, the bound occurrence, its intent
// and the issuance log; and definite refusals recorded only when nothing can
// have been written.
import { generateKeyPair, exportJWK } from "jose";
import { REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { encodeChainId } from "@graffiticode/common/chain";
import {
  createPolicy,
  PolicyDenied,
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
  verifyToken,
  issueToken,
  runtimeOccurrenceId,
  modelIntents,
  COMMAND_LEASE_MS,
  COMMAND_SETTLE_GRACE_MS,
} from "./index.js";

const OWNER = "0xowner";
const GATEWAY = { role: "gateway" };
const L0176 = { role: "compiler", lang: "0176" };
const BROKER = { role: "broker" };
const hex = c => c.repeat(64);
const IMAGE_176 = `sha256:${hex("1")}`;
const IMAGE_000 = `sha256:${hex("0")}`;
const TASKS = ["task-data", "task-prog"];
const WRITE = "learnosity.write-items";
const ARGD = hex("a");

const manifests = () => [
  { stage: "s0", lang: "0000", sourceDigest: hex("b"), programDigest: hex("c"), optionsDigest: hex("d"), revision: "l0000-r1", imageDigest: IMAGE_000, registryVersion: 0, requiredFunctions: [] },
  { stage: "s1", lang: "0176", sourceDigest: hex("e"), programDigest: hex("f"), optionsDigest: hex("d"), revision: "l0176-r1", imageDigest: IMAGE_176, registryVersion: REGISTRY_VERSION, requiredFunctions: ["save-to-itembank", "init"] },
];
const approved = (lang, revision, imageDigest): [string, any] => [`${lang}/${revision}`, {
  lang, revision, imageDigest, tag: `t-${revision}`, tagUrl: `https://t-${revision}---svc.run.app`, status: "approved", contractVersions: [1, 2],
}];
// s1's model declares one static save and a runtime-expanded batch save.
const INTENTS = [
  { id: "save", fn: "save-to-itembank", op: WRITE, occurrences: ["n1.0"] },
  { id: "batch", fn: "save-to-itembank", op: WRITE, runtime: true, bounds: { maxOccurrences: 2 } },
];
const MODEL_S1 = JSON.stringify({ lang: "0176", kind: "plan", carried: { p: 1 }, intents: INTENTS });
const MODEL_S0 = JSON.stringify({ lang: "0000", kind: "value", carried: [1, 2] });

let policy;
let connections;
let invocationStore;
let commandStore;
let records;
let clock;
let receipts;
let commandId;
let invocationId;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  // Tokens are signed and verified on real time; the clock starts there.
  clock = Date.now();
  receipts = [];
  const leases = new Map();
  invocationStore = createMemoryInvocationStore({ leases });
  commandStore = createMemoryCommandStore({ invocationStore });
  records = createCommandRecords({ backend: createMemoryCommandBackend({ commandStore }), now: () => clock });
  connections = createMemoryConnectionStore([{ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" }]);
  policy = createPolicy({
    signer,
    jwks,
    connections,
    invocations: invocationStore,
    commands: commandStore,
    commandRecords: records,
    brokerReceipts: async ({ invocationId: inv, operationIds }) => ({ invocationId: inv, operations: receipts.filter(r => (operationIds ?? []).includes(r.operationId)) }),
    publications: createMemoryPublicationStore(),
    audit: async () => {},
    protectedSwitch: createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
    approvals: createMemoryApprovals(new Map([approved("0000", "l0000-r1", IMAGE_000), approved("0176", "l0176-r1", IMAGE_176)])),
    fence: createMemoryLeaseFence({ leases, now: () => clock }),
    now: () => clock,
  });
  ({ commandId, invocationId } = await policy.allocateCommand({
    caller: GATEWAY, user: { uid: OWNER }, connectionId: "conn-1", taskId: encodeChainId(TASKS), inputDigest: hex("9"), idempotencyKey: "job-1", lang: "0176", request: "{}", worker: "api-1",
  }));
  claimsOf = async token => (await verifyToken(jwks, "execution", token)).claims;
  ({ signer: signerRef, jwks: jwksRef } = { signer, jwks });
});
let claimsOf;
let signerRef;
let jwksRef;

const denied = async (promise, reason) => {
  await expect(promise).rejects.toBeInstanceOf(PolicyDenied);
  await promise.catch(e => expect(e.reason).toBe(reason));
};
const write = (fn, args, generation = 1) => policy.commandWrite({ caller: GATEWAY, commandId, generation, fn, args });
const install = async () => {
  await write("installModel", { stage: "s0", text: MODEL_S0 });
  await write("installModel", { stage: "s1", text: MODEL_S1 });
};
const admit = (generation = 1) => policy.admitCommand({ caller: GATEWAY, commandId, generation, taskIds: TASKS, stages: manifests() });
const session = async (generation = 1) => (await policy.commandSession({ caller: GATEWAY, commandId, generation, stage: "s1" })).sessionToken;
const bind = (occurrenceId = "n1.0", over = {}) => write("bindOccurrence", { stage: "s1", occurrenceId, intentId: "save", args: "{\"items\":[1]}", argd: ARGD, ...over });
const mint = (sessionToken, over = {}) => policy.mint({ caller: L0176, sessionToken, fn: "save-to-itembank", op: WRITE, occurrenceId: "n1.0", argsDigest: ARGD, ...over });
const authorize = (executionToken, over = {}) => policy.authorizeExecution({ caller: BROKER, executionToken, op: WRITE, argsDigest: ARGD, step: "questions", purpose: "dispatch", after: null, ...over });
const ready = async () => {
  await install();
  await admit();
  await bind();
  return session();
};
const outcomes = async () => (await policy.commandRead({ caller: GATEWAY, commandId, what: "outcomes" })).outcomes;
const revoke = () => connections.put({ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "disabled" });

describe("command admission", () => {
  it("binds the installed models' digests and intents, under the stored principal, with no user token", async () => {
    await install();
    const out = await admit();
    expect(out.stages.map(s => [s.stage, s.lang])).toEqual([["s0", "0000"], ["s1", "0176"]]);
    const command = commandStore.commands.get(commandId);
    expect(command.phase).toBe("admitted");
    expect(command.admission.stages.s1.intents.map(i => [i.id, i.bounds.maxOccurrences])).toEqual([["save", 1], ["batch", 2]]);
    expect(command.admission.stages.s0.intents).toEqual([]);
    // A retry is acknowledged.
    expect((await admit()).planDigest).toBe(out.planDigest);
  });

  it("needs every stage's model installed first, and the current owner", async () => {
    await write("installModel", { stage: "s0", text: MODEL_S0 });
    await denied(admit(), "models-missing");
    await write("installModel", { stage: "s1", text: MODEL_S1 });
    await denied(admit(2), "stale-generation");
  });

  it("checks live permission at admission", async () => {
    await install();
    await revoke();
    await denied(admit(), "connection-disabled");
  });

  it("refuses an intent the registry or the stage doesn't allow", () => {
    const check = intents => modelIntents({ modelText: JSON.stringify({ intents }), lang: "0176", requiredFunctions: ["save-to-itembank"], backend: "learnosity" });
    expect(check([{ id: "a", fn: "init", op: WRITE, occurrences: ["a.0"] }]).refusal).toBe("intent-not-registered");
    expect(check([{ id: "a", fn: "save-to-itembank", op: "learnosity.nope", occurrences: ["a.0"] }]).refusal).toBe("intent-not-registered");
    expect(check([{ id: "a", fn: "save-to-itembank", op: WRITE, occurrences: ["x:abc"] }]).refusal).toBe("bad-request");
    expect(check([{ id: "a", fn: "save-to-itembank", op: WRITE, runtime: true }]).refusal).toBe("bad-request");
    expect(check([{ id: "a", fn: "save-to-itembank", op: WRITE, occurrences: ["a.0"] }, { id: "a", fn: "save-to-itembank", op: WRITE, occurrences: ["a.1"] }]).refusal).toBe("bad-request");
    expect(check([]).intents).toEqual([]);
  });
});

describe("a command stage's session and its tokens", () => {
  it("carries cmd and fg, and so does every execution token minted under it", async () => {
    const token = await ready();
    const { executionToken, operationId } = await mint(token);
    const claims = await claimsOf(executionToken);
    expect(claims).toMatchObject({ cmd: commandId, fg: 1, opid: `${invocationId}/s1/n1.0` });
    expect(operationId).toBe(`${invocationId}/s1/n1.0`);
    expect(await authorize(executionToken)).toHaveProperty("decisionId");
  });

  it("commits each token to the occurrence's issuance log before returning it", async () => {
    const { executionToken } = await mint(await ready());
    const { jti, exp } = await claimsOf(executionToken);
    expect((await records.getOccurrence(commandId, "s1", "n1.0")).minted).toEqual([{ jti, exp }]);
  });

  it("returns no token when the log can't be committed for the current owner", async () => {
    const token = await ready();
    // The owner changed between the mint's checks and its log write.
    const real = records.logIssuance;
    records.logIssuance = async args => {
      clock += COMMAND_LEASE_MS + 1;
      await policy.leaseCommand({ caller: GATEWAY, commandId, worker: "api-2", generation: 1, takeOver: true });
      return real(args);
    };
    await denied(mint(token), "stale-generation");
    records.logIssuance = real;
    expect((await records.getOccurrence(commandId, "s1", "n1.0")).minted).toEqual([]);
  });

  it("refuses a step under a token Policy never logged", async () => {
    const token = await ready();
    // A mint whose log write is lost: the token exists, the log doesn't name it.
    const real = records.logIssuance;
    records.logIssuance = async () => ({ logged: true });
    const { executionToken } = await mint(token);
    records.logIssuance = real;
    await denied(authorize(executionToken), "token-not-logged");
  });

  it("fences mint and every step to the current owner, with a live lease", async () => {
    const token = await ready();
    const { executionToken } = await mint(token);
    clock += COMMAND_LEASE_MS + 1;
    await denied(mint(token), "lease-expired");
    await denied(authorize(executionToken), "lease-expired");
    await policy.leaseCommand({ caller: GATEWAY, commandId, worker: "api-2", generation: 1, takeOver: true });
    await denied(mint(token), "stale-generation");
    await denied(authorize(executionToken), "stale-generation");
    // A stale request records nothing.
    expect(await outcomes()).toEqual([]);
  });

  it("refuses an unbound occurrence, other arguments, and another function or operation than the intent's", async () => {
    const token = await ready();
    await denied(mint(token, { occurrenceId: "n9.0" }), "occurrence-not-bound");
    await denied(mint(token, { argsDigest: hex("b") }), "args-mismatch");
    await denied(mint(token, { fn: "save-to-itembank", op: "learnosity.read-items" }), "operation-not-allowed");
  });

  it("checks a runtime occurrence's encoding and bounds", async () => {
    const token = await ready();
    const occ = n => runtimeOccurrenceId("batch", `batch ${n}`);
    await write("bindOccurrence", { stage: "s1", occurrenceId: occ(1), intentId: "batch", expansionKey: "batch 1", args: "{}", argd: ARGD });
    await write("bindOccurrence", { stage: "s1", occurrenceId: occ(2), intentId: "batch", expansionKey: "batch 2", args: "{}", argd: ARGD });
    await denied(write("bindOccurrence", { stage: "s1", occurrenceId: occ(3), intentId: "batch", expansionKey: "batch 3", args: "{}", argd: ARGD }), "bounds-exceeded");
    expect(await mint(token, { occurrenceId: occ(1) })).toHaveProperty("executionToken");
  });

  it("refuses a session without the command claims for a command's invocation", async () => {
    const token = await ready();
    const claims = (await verifyToken(jwksRef, "session", token)).claims;
    const { cmd: _cmd, fg: _fg, iss: _iss, aud: _aud, iat: _iat, exp: _exp, jti: _jti, ...rest } = claims;
    const legacy = await issueToken(signerRef, "session", rest);
    await denied(mint(legacy), "command-claims-required");
  });
});

describe("definite refusals", () => {
  it("records failed when the connection is revoked before the first mint", async () => {
    const token = await ready();
    await revoke();
    await denied(mint(token), "connection-disabled");
    expect(await outcomes()).toMatchObject([{ occurrenceId: "n1.0", outcome: "failed", source: "policy-refusal", reason: "connection-disabled" }]);
  });

  it("records the receipt's outcome, never failed, when the operation was claimed", async () => {
    const token = await ready();
    receipts.push({ operationId: `${invocationId}/s1/n1.0`, status: "succeeded", recorded: true, steps: [] });
    await revoke();
    await denied(mint(token), "connection-disabled");
    expect(await outcomes()).toMatchObject([{ outcome: "completed", source: "receipt" }]);
  });

  it("records nothing while an issued token is still usable, and failed once none can be", async () => {
    const token = await ready();
    await mint(token);
    await revoke();
    await denied(mint(token), "connection-disabled");
    expect(await outcomes()).toEqual([]);
    // Every token is past use: its expiry and Broker's grace. The owner
    // renews its lease as it waits.
    for (let waited = 0; waited < 60_000 + COMMAND_SETTLE_GRACE_MS + 1; waited += 20_000) {
      clock += 20_000;
      await policy.leaseCommand({ caller: GATEWAY, commandId, worker: "api-1", generation: 1 });
    }
    await denied(mint(token), "connection-disabled");
    expect(await outcomes()).toMatchObject([{ outcome: "failed", source: "policy-refusal" }]);
  });

  it("records nothing for a transient or stale refusal", async () => {
    const token = await ready();
    await denied(mint(token, { argsDigest: "not-a-digest" }), "bad-request");
    clock += COMMAND_LEASE_MS + 1;
    await denied(mint(token), "lease-expired");
    expect(await outcomes()).toEqual([]);
  });
});
