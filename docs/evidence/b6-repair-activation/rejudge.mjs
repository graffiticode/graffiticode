// Re-judges a recorded B6 repair round-trip's two Broker rows under the
// revised verdict (the owner's review of 4fe391), read-only and offline: the
// run's own output (its RECORD line and results) and the extraction of its
// Broker receipts and audit. The run's original result is kept as recorded;
// this prints the two rows' revised verdicts beside it.
//
//   node docs/evidence/b6-repair-activation/rejudge.mjs <roundtrip-output.txt> <broker-evidence.json>
import { readFileSync } from "node:fs";
import { OPERATIONS } from "@graffiticode/common/protected-registry";
import { roundtripBrokerProblems, roundtripOperations } from "../../../scripts/lib/b6-drive-checks.js";

const [outputFile, evidenceFile] = process.argv.slice(2);
if (!outputFile || !evidenceFile) throw new Error("usage: rejudge.mjs <roundtrip-output.txt> <broker-evidence.json>");
const record = JSON.parse(readFileSync(outputFile, "utf8").split("\n").find(l => l.startsWith("RECORD ")).slice(7));
const evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
if (JSON.stringify(evidence.opids) !== JSON.stringify(record.opids)) throw new Error("the evidence is for other operations");
const registeredSteps = OPERATIONS["learnosity.write-items"].steps.filter(s => s.purpose === "dispatch").map(s => s.id);
const problems = roundtripBrokerProblems({ operations: roundtripOperations(evidence), registeredSteps });
const { opids, receipts } = record;
const receiptsOk = receipts.original.includes(opids["A, original"]) && receipts.original.every(o => o === opids["A, original"] || o === opids["B, original"]) && JSON.stringify(receipts.repair) === JSON.stringify([opids["B, repair"]]);
const recorded = record.results;
const BROKER_ROWS = ["Broker: A written once by the original, B once by the repair, nothing else", "Broker's receipts: one under each invocation"];
const revised = recorded.map(r => {
  if (r.name === BROKER_ROWS[0]) return { ...r, revised: { ok: problems.length === 0, detail: problems.join("; ") || "B under the original: one receipt, failed authorization-denied:not-granted, no steps, no dispatch; A and repaired B each dispatched questions and items once; repaired A nothing" } };
  if (r.name === BROKER_ROWS[1]) return { ...r, revised: { ok: receiptsOk, detail: JSON.stringify(receipts) } };
  return r;
});
console.log(`round-trip ${record.run} against ${record.staged} (production ${record.revision})`);
console.log(`recorded result: ${recorded.filter(r => r.ok).length}/${recorded.length}${recorded.every(r => r.ok) ? " passed" : " FAILED"} (kept as recorded)`);
for (const r of revised) {
  const line = `${r.ok ? "ok    " : "FAILED"} ${r.name}`;
  console.log(r.revised ? `${line}\n         revised: ${r.revised.ok ? "ok" : "FAILED"}: ${r.revised.detail}` : line);
}
const final = revised.every(r => (r.revised ? r.revised.ok : r.ok));
console.log(`under the revised verdict: ${revised.filter(r => (r.revised ? r.revised.ok : r.ok)).length}/${revised.length}${final ? " passed" : " FAILED"}`);
process.exitCode = final ? 0 : 1;
