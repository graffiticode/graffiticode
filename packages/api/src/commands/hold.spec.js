// C5d (docs/c5d-refusal-and-hold-plan.md decisions 7 and 8, §4 "Hold"): a
// command an operator holds is never run again by the api. The sweep, the
// bridge's and POST /command's re-sends (runCommand) and the worker run
// against an in-process Policy with memory stores, its refusals mapped as the
// HTTP client maps them (policy-commands.js).
import { jest } from "@jest/globals";
import { generateKeyPair, exportJWK } from "jose";
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
  createMemoryHolds,
  createProtectedSwitch,
  HOLD_MARGIN_MS,
} from "@graffiticode/policy";
import { buildCommandWorker } from "./worker.js";
import { buildSweep } from "./sweep.js";
import { runCommand } from "./bridge.js";
import { PolicyRefused } from "./policy-commands.js";

const OWNER = "0xowner";
const GATEWAY = { role: "gateway" };
const hex = c => c.repeat(64);
const HOLD_ACT = { reason: "definite-refusal-unsettled", note: "held", decision: "docs/c5d-refusal-and-hold-plan.md", decidedBy: "owner", appliedBy: { email: "owner@example.com", verifiedVia: "tokeninfo", azp: "azp-1" } };

let policy;
let commandStore;
let holds;
let clock;
let acts = 0;

beforeEach(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
  const jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  clock = Date.now();
  const leases = new Map();
  const invocationStore = createMemoryInvocationStore({ leases });
  commandStore = createMemoryCommandStore({ invocationStore });
  const backend = createMemoryCommandBackend({ commandStore });
  holds = createMemoryHolds({ commandStore, backend, now: () => clock });
  policy = createPolicy({
    signer,
    jwks,
    connections: createMemoryConnectionStore([{ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" }]),
    invocations: invocationStore,
    commands: commandStore,
    commandRecords: createCommandRecords({ backend, now: () => clock }),
    publications: createMemoryPublicationStore(),
    audit: async () => {},
    protectedSwitch: createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
    approvals: createMemoryApprovals(new Map()),
    fence: createMemoryLeaseFence({ leases, now: () => clock }),
    now: () => clock,
  });
});

// Policy's answers as the api's HTTP client throws them.
const asHttp = fn => async args => {
  try {
    return await fn(args);
  } catch (e) {
    if (e instanceof PolicyDenied) throw new PolicyRefused(e.reason);
    throw e;
  }
};
const gateway = {
  allocate: asHttp(({ authToken: _token, ...args }) => policy.allocateCommand({ caller: GATEWAY, user: { uid: OWNER }, ...args })),
  lease: asHttp(args => policy.leaseCommand({ caller: GATEWAY, ...args, recording: 1, repairs: 1, scopes: 1 })),
  due: asHttp(args => policy.dueCommands({ caller: GATEWAY, ...args, recording: 1, repairs: 1, scopes: 1 })),
  read: asHttp(args => policy.commandRead({ caller: GATEWAY, ...args })),
  installModel: asHttp(({ commandId, generation, ...args }) => policy.commandWrite({ caller: GATEWAY, commandId, generation, fn: "installModel", args })),
  admit: asHttp(args => policy.admitCommand({ caller: GATEWAY, ...args, scopes: 1 })),
  finish: asHttp(({ commandId, generation, ...args }) => policy.commandWrite({ caller: GATEWAY, commandId, generation, fn: "finish", args })),
};
const REQUEST = { connectionId: "conn-1", taskId: encodeChainId(["task-0"]), inputDigest: hex("9"), lang: "0176", request: "{}" };
const allocate = async () => (await gateway.allocate({ ...REQUEST, idempotencyKey: `job-${++acts}`, worker: "api-1" }));
const hold = commandId => holds.applyHold({ commandId, actId: `00000000-0000-4000-8000-${String(++acts).padStart(12, "0")}`, ...HOLD_ACT });
// A command its first worker abandoned, held once the margin passed.
const heldCommand = async () => {
  const c = await allocate();
  clock = c.leaseExpiresAt + HOLD_MARGIN_MS;
  await hold(c.commandId);
  return c;
};

describe("a held command in the api", () => {
  it("is never taken by a sweep, which never runs the worker, even from a stale listing", async () => {
    const c = await heldCommand();
    const before = JSON.stringify(commandStore.commands.get(c.commandId));
    const run = jest.fn();
    expect(await buildSweep({ policy: gateway, run, worker: "sweeper", log: () => {} })()).toEqual({ due: 0, taken: 0, skipped: 0, failed: 0 });
    // A listing read before the hold: the takeover is refused, and skipped.
    const stale = { ...gateway, due: async () => ({ commands: [{ commandId: c.commandId, generation: 1 }] }) };
    expect(await buildSweep({ policy: stale, run, worker: "sweeper", log: () => {} })()).toEqual({ due: 1, taken: 0, skipped: 1, failed: 0 });
    expect(run).not.toHaveBeenCalled();
    expect(JSON.stringify(commandStore.commands.get(c.commandId))).toBe(before);
  });

  it("is never run by a re-send of its key (the bridge and POST /command): it stays pending", async () => {
    const c = await heldCommand();
    const before = JSON.stringify(commandStore.commands.get(c.commandId));
    const run = jest.fn();
    const out = await runCommand({ policy: gateway, run, worker: "api-2", authToken: "user-token", ...REQUEST, idempotencyKey: `job-${acts - 1}`, create: true, now: () => clock });
    expect(out).toMatchObject({ protocol: "command", reused: true, state: { commandId: c.commandId, status: "pending", held: true, generation: 1 } });
    expect(run).not.toHaveBeenCalled();
    expect(JSON.stringify(commandStore.commands.get(c.commandId))).toBe(before);
  });

  it("stops a worker that meets command-held as having lost the command, with no effects", async () => {
    const c = await allocate();
    // Defense in depth: a hold over a live lease, which applyHold never
    // writes; the worker's first Policy request is refused command-held.
    const record = commandStore.commands.get(c.commandId);
    commandStore.commands.set(c.commandId, { ...record, hold: { n: 1, actId: "00000000-0000-4000-8000-000000000999", ...HOLD_ACT } });
    const before = JSON.stringify(commandStore.commands.get(c.commandId));
    const language = { baseUrlFor: jest.fn(), model: jest.fn(), preflight: jest.fn() };
    const taskStorer = { get: jest.fn(async () => [{ lang: "0176", code: {} }]) };
    const run = buildCommandWorker({ policy: gateway, taskStorer, language, artifactStorer: {}, worker: "api-1", setInterval: () => null, clearInterval: () => {}, log: () => {} });
    expect(await run({ commandId: c.commandId, generation: 1 })).toEqual({ commandId: c.commandId, status: "pending", lost: "command-held" });
    // It read the first stage's model (a read), and its install, the first
    // write, was refused: nothing was preflighted, admitted or executed.
    expect(language.model).toHaveBeenCalledTimes(1);
    expect(language.preflight).not.toHaveBeenCalled();
    expect(JSON.stringify(commandStore.commands.get(c.commandId))).toBe(before);
  });
});
