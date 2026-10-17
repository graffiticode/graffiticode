import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { command, isRefusal, parseArgs, parseEntries, refusalFilter, refusedDestinations, tcpDecision } from "../refusals.js";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FIXTURES = path.join(HERE, "fixtures");

test("refusals.js prints the log query for a class and a time, and validates both (A18)", () => {
  const filter = refusalFilter({ cls: "compilers-default", since: "2026-10-20T00:00:00Z" });
  assert.match(filter, /jsonPayload\.class="compilers-default"/);
  assert.match(filter, /timestamp>="2026-10-20T00:00:00Z"/);
  assert.match(filter, /jsonPayload\.decision="refuse" OR jsonPayload\.isolate01="terminate-tcp"/);
  assert.match(command({ cls: "compilers-default", since: "2026-10-20T00:00:00Z" }), /^gcloud logging read '.*' --project=graffiticode --format=json --limit=100000 > refusals-compilers-default\.json$/);
  assert.throws(() => refusalFilter({ cls: "default", since: "2026-10-20T00:00:00Z" }), /--class/);
  assert.throws(() => refusalFilter({ cls: "compilers-default", since: "yesterday" }), /--since/);
  assert.throws(() => refusalFilter({ cls: "compilers-default'; rm -rf /", since: "2026-10-20T00:00:00Z" }), /--class/);
  assert.throws(() => parseArgs(["--class"]), /usage/);
});

test("connection-level lines: an unknown SNI and an RBAC refusal are refusals; a clean close isn't", () => {
  assert.equal(tcpDecision({ flags: "NR", termination: "-" }), "refuse");
  assert.equal(tcpDecision({ flags: "-", termination: "rbac_access_denied_matched_policy[none]" }), "refuse");
  assert.equal(tcpDecision({ flags: "-", termination: "-" }), "allow");
  assert.equal(isRefusal({ isolate01: "egress", decision: "allow", code: 200, refused: "-" }), false);
  assert.equal(isRefusal({ isolate01: "egress", decision: "-", code: 403, refused: "unlisted" }), true, "a 403 with its refusal header, even if the decision header wasn't logged");
  assert.equal(isRefusal({ isolate01: "config" }), false);
});

test("recorded log lines become the refused destinations, most refused first (A18)", async () => {
  const entries = parseEntries(await readFile(path.join(FIXTURES, "refusal-entries.json"), "utf8"));
  const rows = refusedDestinations(entries, { cls: "compilers-default" });
  assert.deepEqual(rows.map(r => [r.target, r.reason, r.count]), [
    ["fonts.googleapis.com:443", "unlisted", 2],
    ["cdn.example:443", "unlisted", 1],
    ["other.example", "no-filter-chain", 1],
    ["policy-sja7fatcta-uc.a.run.app", "host-mismatch", 1],
    ["policy-sja7fatcta-uc.a.run.app", "rbac", 1],
  ]);
  const fonts = rows[0];
  assert.equal(fonts.first, "2026-10-20T10:00:01Z");
  assert.equal(fonts.last, "2026-10-20T10:05:00Z");
  assert.deepEqual(rows.find(r => r.reason === "host-mismatch").probes, ["at11-fronted-1"]);
  assert.ok(!rows.some(r => r.target.startsWith("learnosity")), "another class's lines are left out");
  // One entry per line works as well as a JSON array.
  const ndjson = entries.map(e => JSON.stringify(e)).join("\n");
  assert.deepEqual(refusedDestinations(parseEntries(ndjson), { cls: "compilers-default" }), rows);
});

test("refusals.js --parse runs end to end", () => {
  const out = execFileSync(process.execPath, [path.join(HERE, "../refusals.js"), "--class", "compilers-l0185", "--parse", path.join(FIXTURES, "refusal-entries.json")], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out).map(r => [r.target, r.reason]), [["learnosity.com:443", "name"]]);
});
