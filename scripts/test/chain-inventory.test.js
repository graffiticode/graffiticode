import test from "node:test";
import assert from "node:assert/strict";
import { encodeChainId } from "@graffiticode/common/chain";
import { buildChainInventory } from "../lib/chain-inventory.js";

const since = new Date("2026-09-01T00:00:00.000Z");
const until = new Date("2026-10-01T00:00:00.000Z");
const now = () => new Date("2026-10-01T00:05:00.000Z");
const PINNABLE = ["0000", "0176"];

// An L0176 program fed by its L0000 input data, as api builds it: s0 runs last.
const chainOf = (...taskIds) => taskIds.map(t => encodeChainId([t])).join("+");
const TASKS = { save: "0176", preview: "0176", data: "0000", sheet: "0179", legacy: "176" };

const world = ({ rows, tasks = TASKS, count = rows.length, scanFailsAfter = null, countFails = false, unreadableTask = null } = {}) => ({
  invocations: {
    count: async () => { if (countFails) throw new Error("count unavailable"); return count; },
    async * scan() {
      let i = 0;
      for (const row of rows) {
        if (scanFailsAfter !== null && i === scanFailsAfter) throw new Error("deadline exceeded");
        i += 1;
        yield row;
      }
    },
  },
  taskLang: async taskId => {
    if (taskId === unreadableTask) throw new Error("permission denied");
    return Object.prototype.hasOwnProperty.call(tasks, taskId) ? tasks[taskId] : null;
  },
});
const inventory = w => buildChainInventory({ ...w, pinnable: PINNABLE, since, until, now });
const at = day => `2026-09-${String(day).padStart(2, "0")}T12:00:00.000Z`;

test("passes with dated evidence when every chain in the window has only pinnable stages", async () => {
  const rows = [
    { taskId: chainOf("save"), createdAt: at(2) },
    { taskId: chainOf("save"), createdAt: at(9) },
    { taskId: chainOf("preview", "data"), createdAt: at(5) },
    { taskId: chainOf("legacy"), createdAt: at(6) },
  ];
  const e = await inventory(world({ rows }));
  assert.equal(e.verdict, "pass", JSON.stringify(e.reasons));
  assert.equal(e.generatedAt, "2026-10-01T00:05:00.000Z");
  assert.deepEqual(e.window, { since: since.toISOString(), until: until.toISOString() });
  assert.deepEqual(e.coverage, { invocationsCounted: 4, invocationsScanned: 4, complete: true, distinctChains: 3, tasksRead: 4 });
  assert.deepEqual(e.totals, { supported: 3, unsupported: 0, unreadable: 0 });
  assert.deepEqual(e.bySignature, [
    { langs: ["0176"], chains: 2, invocations: 3 },
    { langs: ["0176", "0000"], chains: 1, invocations: 1 },
  ]);
});

test("reports a chain with a stage that isn't pinnable, by its chain and stage, and fails", async () => {
  const rows = [{ taskId: chainOf("save"), createdAt: at(2) }, { taskId: chainOf("save", "sheet"), createdAt: at(3) }, { taskId: chainOf("save", "sheet"), createdAt: at(8) }];
  const e = await inventory(world({ rows }));
  assert.equal(e.verdict, "fail");
  assert.deepEqual(e.reasons, ["unsupported-chains"]);
  assert.deepEqual(e.unsupported, [{
    chainId: chainOf("save", "sheet"),
    invocations: 2,
    firstSeen: at(3),
    lastSeen: at(8),
    langs: ["0176", "0179"],
    stages: [{ stage: "s1", taskId: "sheet", lang: "0179" }],
  }]);
});

test("unreadable chains are reported and fail: undecodable, missing or unreadable tasks, no language, no task id", async () => {
  const rows = [
    { taskId: chainOf("save"), createdAt: at(1) },
    { taskId: "not a chain", createdAt: at(2) },
    { taskId: chainOf("gone"), createdAt: at(3) },
    { taskId: chainOf("locked"), createdAt: at(4) },
    { taskId: chainOf("nolang"), createdAt: at(5) },
    { createdAt: at(6) },
  ];
  const e = await inventory(world({ rows, tasks: { ...TASKS, nolang: undefined }, unreadableTask: "locked" }));
  assert.equal(e.verdict, "fail");
  assert.deepEqual(e.reasons, ["unreadable-chains"]);
  assert.deepEqual(e.unreadable.map(c => c.reason).sort(), ["no-task-id", "task-lang-unreadable", "task-missing", "task-unreadable", "undecodable-chain"]);
  assert.equal(e.totals.supported, 1);
});

test("incomplete evidence never passes: a failed scan, a count mismatch, a failed count, an empty window", async () => {
  const rows = [{ taskId: chainOf("save"), createdAt: at(1) }, { taskId: chainOf("save"), createdAt: at(2) }];
  const stopped = await inventory(world({ rows, scanFailsAfter: 1 }));
  assert.equal(stopped.verdict, "fail");
  assert.deepEqual(stopped.reasons, ["scan-failed", "coverage-mismatch"]);
  assert.equal(stopped.coverage.complete, false);
  assert.equal(stopped.coverage.scanError, "deadline exceeded");
  const short = await inventory(world({ rows, count: 3 }));
  assert.deepEqual(short.reasons, ["coverage-mismatch"]);
  const uncounted = await inventory(world({ rows, countFails: true }));
  assert.deepEqual(uncounted.reasons, ["coverage-mismatch"]);
  assert.equal(uncounted.coverage.invocationsCounted, null);
  const empty = await inventory(world({ rows: [] }));
  assert.equal(empty.verdict, "fail");
  assert.deepEqual(empty.reasons, ["no-invocations"]);
});

test("the evidence names chains by task ids and languages only", async () => {
  const rows = [{ taskId: chainOf("save", "sheet"), createdAt: at(2), uid: "0xuser", connectionId: "conn-1" }];
  const text = JSON.stringify(await inventory(world({ rows })));
  assert.equal(text.includes("0xuser"), false);
  assert.equal(text.includes("conn-1"), false);
});
