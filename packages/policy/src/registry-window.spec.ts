// C5d (docs/c5d-refusal-and-hold-plan.md decision 12, the table of minting
// paths), from the owner's reproducer: a registry-10 Policy, window [9, 8],
// mints previews, publication views and unbound snapshots under its own
// current registry (rv 10, at once), and a bound snapshot and a command's
// session under the plan's (9, while compilers report 9). So Broker, which
// refuses a version it doesn't accept, must be at 10 first.
import { generateKeyPair, exportJWK, decodeJwt } from "jose";
import { REGISTRY_VERSION, REGISTRY_WINDOW } from "@graffiticode/common/protected-registry";
import { encodeChainId } from "@graffiticode/common/chain";
import {
  createPolicy,
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
} from "./index.js";

const OWNER = "0xowner";
const SYSTEM = "0xgraffiticode";
const GATEWAY = { role: "gateway" };
const L0176 = { role: "compiler", lang: "0176" };
const hex = c => c.repeat(64);
const IMAGE_176 = `sha256:${hex("1")}`;
const IMAGE_000 = `sha256:${hex("0")}`;
const IMAGE_013 = `sha256:${hex("3")}`;
const ITEM = "privateItem00000001";
const TASKS = ["task-data", "task-prog"];
const approved = (lang, revision, imageDigest, contractVersions): [string, any] => [`${lang}/${revision}`, { lang, revision, imageDigest, tag: `t-${revision}`, tagUrl: `https://t-${revision}`, status: "approved", contractVersions }];
// The L0176 stage reports `registryVersion`, as its compiler does.
const manifests = registryVersion => [
  { stage: "s0", lang: "0000", sourceDigest: hex("b"), programDigest: hex("c"), optionsDigest: hex("d"), revision: "l0000-r1", imageDigest: IMAGE_000, registryVersion: 0, requiredFunctions: [] },
  { stage: "s1", lang: "0176", sourceDigest: hex("e"), programDigest: hex("f"), optionsDigest: hex("d"), revision: "l0176-r1", imageDigest: IMAGE_176, registryVersion, requiredFunctions: ["save-to-itembank", "init"] },
];

let policy;
let commandStore;
const rv = token => decodeJwt(token).rv;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  const leases = new Map();
  const invocations = createMemoryInvocationStore({ leases });
  commandStore = createMemoryCommandStore({ invocationStore: invocations });
  const publications = createMemoryPublicationStore();
  await publications.create({ publicationId: "pub-1", publisherUid: OWNER, ownerUid: OWNER, connectionId: "conn-1", lang: "0176", taskId: "task-prog" });
  // The defaults: this registry, at 10 with [9, 8].
  policy = createPolicy({
    signer,
    jwks,
    connections: createMemoryConnectionStore([
      { connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" },
      { connectionId: "conn-sys", ownerUid: SYSTEM, backend: "learnosity", status: "active" },
    ]),
    invocations,
    publications,
    systemConnections: { learnosity: "conn-sys" },
    commands: commandStore,
    commandRecords: createCommandRecords({ backend: createMemoryCommandBackend({ commandStore }) }),
    audit: async () => {},
    protectedSwitch: createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
    approvals: createMemoryApprovals(new Map([
      approved("0000", "l0000-r1", IMAGE_000, [1, 2]),
      approved("0176", "l0176-r1", IMAGE_176, [1, 2]),
      approved("0013", "l0013r-r1", IMAGE_013, [3]),
    ])),
    fence: createMemoryLeaseFence({ leases }),
    itemAuthority: createMemoryItemAuthority({ [ITEM]: { ownerUid: OWNER, isPublic: false, taskId: "itemTask" } }),
  } as any);
});

const mintInit = async sessionToken => (await policy.mint({ caller: L0176, sessionToken, fn: "init", op: "learnosity.sign-items-preview", occurrenceId: "prog.0", argsDigest: hex("a") })).executionToken;

describe("what a registry-10 Policy mints (C5d decision 12)", () => {
  it("runs at 10 with 9 and 8 in its window", () => {
    expect(REGISTRY_VERSION).toBe(10);
    expect(REGISTRY_WINDOW).toEqual([9, 8]);
  });

  it("a system preview session, and its mint, carry rv 10", async () => {
    const { sessionToken } = await policy.previewSession({ caller: L0176, lang: "0176" });
    expect(rv(sessionToken)).toBe(10);
    expect(rv(await mintInit(sessionToken))).toBe(10);
  });

  it("a publication's view session, and its mint, carry rv 10", async () => {
    const { invocationToken } = await policy.authorizeView({ caller: GATEWAY, publicationId: "pub-1" });
    const { sessionToken } = await policy.snapshot({ caller: L0176, lang: "0176", connectionId: "conn-1", fns: ["init"], invocationToken, stage: "s0" });
    expect(decodeJwt(sessionToken)).toMatchObject({ pub: "pub-1", rv: 10 });
    expect(rv(await mintInit(sessionToken))).toBe(10);
  });

  it("an unbound snapshot (contract v1), and its mint, carry rv 10", async () => {
    const { invocationToken } = await policy.allocateInvocation({ caller: GATEWAY, user: { uid: OWNER }, connectionId: "conn-1", taskId: "task-prog", inputDigest: hex("9"), idempotencyKey: "job-v1" });
    const { sessionToken } = await policy.snapshot({ caller: L0176, user: { uid: OWNER }, lang: "0176", connectionId: "conn-1", fns: ["init"], invocationToken, stage: "s0" });
    expect(rv(sessionToken)).toBe(10);
    expect(rv(await mintInit(sessionToken))).toBe(10);
  });

  it("a snapshot bound to a plan admitted while compilers report 9 carries the plan's 9, and so does its mint", async () => {
    const { invocationToken } = await policy.allocateInvocation({ caller: GATEWAY, user: { uid: OWNER }, connectionId: "conn-1", taskId: encodeChainId(TASKS), inputDigest: hex("9"), idempotencyKey: "job-v2", admission: true });
    const { admissionToken } = await policy.admit({ caller: GATEWAY, user: { uid: OWNER }, invocationToken, taskIds: TASKS, stages: manifests(9) });
    const { sessionToken } = await policy.snapshot({ caller: L0176, user: { uid: OWNER }, lang: "0176", connectionId: "conn-1", fns: ["init", "save-to-itembank"], invocationToken, stage: "s1", admissionToken, manifest: manifests(9)[1] });
    expect(rv(sessionToken)).toBe(9);
    expect(rv(await mintInit(sessionToken))).toBe(9);
  });

  it("a command's session carries its plan's 9", async () => {
    const { commandId } = await policy.allocateCommand({ caller: GATEWAY, user: { uid: OWNER }, taskId: encodeChainId(["task-0"]), inputDigest: hex("9"), idempotencyKey: "job-cmd", lang: "0013", request: "{}", worker: "api-1", scopes: 1 });
    const snap = { id: "snap", fn: "snap", op: "gcs.put-thumbnail", occurrences: ["n0.0"], scope: { kind: "item", id: ITEM } };
    await policy.commandWrite({ caller: GATEWAY, commandId, generation: 1, fn: "installModel", args: { stage: "s0", text: JSON.stringify({ lang: "0013", kind: "plan", carried: {}, intents: [snap] }) } });
    await policy.admitCommand({ caller: GATEWAY, commandId, generation: 1, taskIds: ["task-0"], scopes: 1, stages: [{ stage: "s0", lang: "0013", sourceDigest: hex("b"), programDigest: hex("c"), optionsDigest: hex("d"), revision: "l0013r-r1", imageDigest: IMAGE_013, registryVersion: 9, requiredFunctions: ["snap"] }] });
    const { sessionToken } = await policy.commandSession({ caller: GATEWAY, commandId, generation: 1, stage: "s0" });
    expect(rv(sessionToken)).toBe(9);
  });
});
