// The C5a gate's due-phase fixtures (scripts/lib/c5a-gate-fixtures.js),
// against the real Policy with in-memory stores: allocated once and saved
// as they go, retired without running (fenced), and never due afterwards,
// including after an interrupted setup or cleanup (the owner's third review
// of #417).
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeChainId } from "@graffiticode/common/chain";
import {
  createPolicy,
  createMemoryConnectionStore,
  createMemoryInvocationStore,
  createMemoryCommandStore,
  createMemoryCommandBackend,
  createCommandRecords,
  createProtectedSwitch,
  COMMAND_LEASE_MS,
} from "@graffiticode/policy";
import { ensureFixtures, retireFixtures, verifyRetired } from "../lib/c5a-gate-fixtures.js";
import { dueObservation, verdict } from "../lib/c5a-gate-checks.js";

const OWNER = "0xowner";
const GATEWAY = { role: "gateway" };
const hex = c => c.repeat(64);

const harness = () => {
  const h = { clock: Date.now(), allocations: 0, failAllocateAt: null, failFinishOnce: false };
  const invocations = createMemoryInvocationStore({ leases: new Map() });
  const commands = createMemoryCommandStore({ invocationStore: invocations });
  const policy = createPolicy({
    invocations,
    commands,
    commandRecords: createCommandRecords({ backend: createMemoryCommandBackend({ commandStore: commands }), now: () => h.clock }),
    connections: createMemoryConnectionStore([{ connectionId: "conn-1", ownerUid: OWNER, backend: "learnosity", status: "active" }]),
    audit: async () => {},
    protectedSwitch: createProtectedSwitch({ readFlag: async () => ({ enabled: true }) }),
    now: () => h.clock,
  });
  h.policy = policy;
  // The gateway's routes, as the runner's HTTP client presents them.
  h.client = {
    allocate: async body => {
      h.allocations++;
      if (h.failAllocateAt === h.allocations) throw new Error("the operator's process died");
      return policy.allocateCommand({ caller: GATEWAY, user: { uid: OWNER }, ...body });
    },
    get: id => policy.getCommand({ caller: GATEWAY, commandId: id }),
    lease: (id, body) => policy.leaseCommand({ caller: GATEWAY, commandId: id, ...body }),
    finish: async (id, generation) => {
      if (h.failFinishOnce) {
        h.failFinishOnce = false;
        throw new Error("the operator's process died after the takeover");
      }
      return policy.commandWrite({ caller: GATEWAY, commandId: id, generation, fn: "finish", args: { result: null } });
    },
    due: ({ scopes }) => policy.dueCommands({ caller: GATEWAY, limit: 50, recording: 1, repairs: 1, scopes: scopes ? 1 : 0 }),
  };
  h.sleep = async ms => { h.clock += ms; };
  h.now = () => h.clock;
  return h;
};
const spec = (name, { connection, scopes }) => ({
  name,
  body: { connectionId: connection, taskId: encodeChainId([`t-${name}`]), inputDigest: hex("9"), idempotencyKey: `c5a-gate:run:${name}`, lang: "0013", request: "{}", worker: "c5a-gate-fixture:run", create: true, ...(scopes ? { scopes: 1 } : {}) },
});
const SPECS = [spec("v3-fixture-1", { connection: null, scopes: true }), spec("v3-fixture-2", { connection: null, scopes: true }), spec("v2-control", { connection: "conn-1", scopes: false })];
const WORKER = "c5a-gate-fixture:run";

test("fixtures are retired without running, and no worker can list or take them afterwards", async () => {
  const h = harness();
  const state = {};
  const fixtures = await ensureFixtures({ client: h.client, state, save: async () => {}, specs: SPECS });
  const ids = Object.values(fixtures);
  h.clock += COMMAND_LEASE_MS + 1;
  // Due before retirement: the v3 fixtures only to a scopes worker, the control to both.
  const scoped = (await h.client.due({ scopes: true })).commands.map(c => c.commandId);
  const production = (await h.client.due({ scopes: false })).commands.map(c => c.commandId);
  assert.deepEqual(scoped.sort(), [...ids].sort());
  assert.deepEqual(production, [fixtures["v2-control"]]);
  const statuses = await retireFixtures({ client: h.client, ids, worker: WORKER, now: h.now, sleep: h.sleep });
  assert.deepEqual(Object.values(statuses), ["failed", "failed", "failed"]);
  const retired = await verifyRetired({ client: h.client, ids });
  assert.deepEqual(retired.listedAfter, []);
  // The reviewer's case: a later scopes worker lists none and can take none over.
  h.clock += COMMAND_LEASE_MS + 1;
  assert.deepEqual((await h.client.due({ scopes: true })).commands, []);
  for (const id of ids) {
    const c = await h.client.get(id);
    assert.equal(c.status, "failed");
    assert.equal(c.publication.state, "none");
    await assert.rejects(h.client.lease(id, { worker: "future-scopes-worker", generation: c.generation, takeOver: true, recording: 1, repairs: 1, scopes: 1 }));
  }
  // Retirement is idempotent.
  assert.deepEqual(await retireFixtures({ client: h.client, ids, worker: WORKER, now: h.now, sleep: h.sleep }), statuses);
});

test("an interrupted setup resumes: saved ids are kept, and nothing is allocated twice", async () => {
  const h = harness();
  const state = {};
  const saves = [];
  const save = async () => { saves.push(JSON.parse(JSON.stringify(state.fixtures))); };
  h.failAllocateAt = 2;
  await assert.rejects(ensureFixtures({ client: h.client, state, save, specs: SPECS }), /died/);
  assert.deepEqual(Object.keys(state.fixtures), ["v3-fixture-1"]);
  assert.deepEqual(saves.at(-1), state.fixtures);
  const first = state.fixtures["v3-fixture-1"];
  h.failAllocateAt = null;
  const fixtures = await ensureFixtures({ client: h.client, state, save, specs: SPECS });
  assert.equal(fixtures["v3-fixture-1"], first);
  assert.deepEqual(Object.keys(fixtures), ["v3-fixture-1", "v3-fixture-2", "v2-control"]);
  // Three successful allocations and the one that failed: v3-fixture-1 wasn't allocated again.
  assert.equal(h.allocations, 4);
});

test("an interrupted cleanup reruns to completion, fenced: it never acts under another worker's live lease", async () => {
  const h = harness();
  const state = {};
  const ids = Object.values(await ensureFixtures({ client: h.client, state, save: async () => {}, specs: SPECS }));
  h.clock += COMMAND_LEASE_MS + 1;
  // Another worker holds the control now (as production's sweeper might).
  const control = state.fixtures["v2-control"];
  await h.client.lease(control, { worker: "production-sweeper", generation: 1, takeOver: true, recording: 1, repairs: 1 });
  // The cleanup dies after its first takeover.
  h.failFinishOnce = true;
  await assert.rejects(retireFixtures({ client: h.client, ids, worker: WORKER, now: h.now, sleep: h.sleep }), /died after the takeover/);
  assert.equal((await h.client.get(ids[0])).status, "pending");
  // Rerun: it waits out its own earlier lease and the sweeper's, then retires all.
  const statuses = await retireFixtures({ client: h.client, ids, worker: WORKER, now: h.now, sleep: h.sleep });
  assert.deepEqual(Object.values(statuses), ["failed", "failed", "failed"]);
  const retired = await verifyRetired({ client: h.client, ids });
  assert.deepEqual(retired.listedAfter, []);
  // The control was taken over only once the sweeper's lease had expired.
  assert.ok((await h.client.get(control)).generation >= 3);
});

test("the gate needs the control in both due queries and every fixture retired", async () => {
  const base = { v3Fixtures: ["v3a", "v3b"], control: "v2", productionLease: "worker-unsupported" };
  // The reviewer's case: the scopes query omits the control.
  const noControl = dueObservation({ ...base, productionQueries: [{ commands: [{ commandId: "v2" }] }], scopedQueries: [{ commands: [{ commandId: "v3a" }, { commandId: "v3b" }] }] });
  assert.equal(noControl.controlListedToScoped, false);
  const o = { oldWorkers: noControl, fixtureCleanup: { fixtures: ["v3a", "v3b", "v2"], statuses: { v3a: "failed", v3b: "failed", v2: "failed" }, listedAfter: [] } };
  const byId = id => verdict(o).checks.find(c => c.id === id);
  assert.equal(byId("old-workers").ok, false);
  assert.match(byId("old-workers").detail, /scopes worker's due query never listed the v2 control/);
  o.oldWorkers = dueObservation({ ...base, productionQueries: [{ commands: [{ commandId: "v2" }] }], scopedQueries: [{ commands: [{ commandId: "v3a" }, { commandId: "v3b" }, { commandId: "v2" }] }] });
  assert.equal(byId("old-workers").ok, true);
  assert.equal(byId("fixtures-retired").ok, true);
  // A fixture left pending, unchecked, or still due fails the gate.
  o.fixtureCleanup.statuses.v3b = "pending";
  assert.equal(byId("fixtures-retired").ok, false);
  o.fixtureCleanup = { fixtures: ["v3a", "v3b"], statuses: { v3a: "failed", v3b: "failed" }, listedAfter: [] };
  assert.equal(byId("fixtures-retired").ok, false);
  o.fixtureCleanup = { fixtures: ["v3a", "v3b", "v2"], statuses: { v3a: "failed", v3b: "failed", v2: "failed" }, listedAfter: ["v3a"] };
  assert.equal(byId("fixtures-retired").ok, false);
  delete o.fixtureCleanup;
  assert.equal(byId("fixtures-retired").ok, false);
});
