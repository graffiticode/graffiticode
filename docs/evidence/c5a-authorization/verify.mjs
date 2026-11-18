// Offline checks of the C5a authorization evidence, from the repo root:
//   node docs/evidence/c5a-authorization/verify.mjs
// 1. Every file listed in MANIFEST.sha256 has its recorded digest.
// 2. The final report's stored observations re-judge as recorded (20/20) with
//    the merged checker (scripts/lib/c5a-gate-checks.js), and the earlier
//    reports' recorded counts are as stated (17/20 for r36074e's first judge).
// 3. The exact-time approval inventory at r36074e's baseline and the current
//    one (both redacted the same way, REDACTIONS.txt) match in membership and
//    canonical contents.
// Reads nothing outside this directory and the repo's scripts.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { verdict } from "../../../scripts/lib/c5a-gate-checks.js";
import { approvalInventory, compareInventories } from "../../../scripts/lib/c5a-gate-reads.js";

const dir = path.dirname(new URL(import.meta.url).pathname);
const read = f => readFileSync(path.join(dir, f));
const json = f => JSON.parse(read(f).toString());
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "ok    " : "FAILED"} ${what}`); if (!ok) failed++; };

// 1. The manifest.
const manifest = read("MANIFEST.sha256").toString().trim().split("\n").map(l => l.match(/^([0-9a-f]{64}) {2}(.+)$/));
const bad = manifest.filter(m => !m || createHash("sha256").update(read(m[2])).digest("hex") !== m[1]).map(m => m?.[2] ?? "malformed line");
check(bad.length === 0, `MANIFEST.sha256: ${manifest.length} files${bad.length ? `, differing: ${bad.join(", ")}` : ""}`);

// 2. The verdicts.
const final = json("r36074e/report.json");
const rejudged = verdict(final.observations);
check(rejudged.passed && rejudged.checks.length === 20 && rejudged.checks.every(c => c.ok), `r36074e final report re-judged: ${rejudged.checks.filter(c => c.ok).length}/${rejudged.checks.length}`);
check(final.passed === true && final.checks.filter(c => c.ok).length === 20 && final.checks.length === 20, `r36074e final report as recorded: ${final.checks.filter(c => c.ok).length}/${final.checks.length}`);
const first = json("r36074e/report-2026-11-18T21:53:51.947Z.json");
check(first.passed === false && first.checks.filter(c => c.ok).length === 17 && first.checks.length === 20, `r36074e first judge as recorded: ${first.checks.filter(c => c.ok).length}/${first.checks.length} (${first.checks.filter(c => !c.ok).map(c => c.id).join(", ")})`);
const preserved = json("r36074e/preserved-18of21/report.json");
check(JSON.stringify(preserved) === JSON.stringify(first), "the preserved first report equals the judge's kept copy");

// 3. The approval inventories.
const decode = v => (v == null ? null : "stringValue" in v ? v.stringValue : "integerValue" in v ? Number(v.integerValue) : "doubleValue" in v ? v.doubleValue : "booleanValue" in v ? v.booleanValue : "timestampValue" in v ? v.timestampValue : "nullValue" in v ? null : "arrayValue" in v ? (v.arrayValue.values ?? []).map(decode) : "mapValue" in v ? Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, decode(x)])) : null);
const inventory = f => { const saved = json(f); return { saved, inv: approvalInventory(Object.fromEntries(Object.entries(saved.inventory).map(([l, docs]) => [l, docs.map(d => ({ name: d.name, fields: decode({ mapValue: d }) }))]))) }; };
const base = inventory("r36074e/approvals-history/baseline.raw.json");
const cur = inventory("r36074e/approvals-history/current.raw.json");
const cmp = compareInventories(base.inv, cur.inv);
check(base.saved.readTime === final.observations.approvals.history.baselineAt && cmp.identical && cmp.baselineCount === 42, `approvals at exactly ${base.saved.readTime}: ${cmp.baselineCount} records, identical to current (${JSON.stringify({ added: cmp.added, deleted: cmp.deleted, modified: cmp.modified })})`);

console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exitCode = failed ? 1 : 0;
