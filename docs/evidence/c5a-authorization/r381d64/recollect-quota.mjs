// Owner-approved, read-only: Policy's command-reserve audit for the public
// fixture, read again (the captures phase read it before the 13th's refusal
// was ingested). The original observation is kept in the state's history; the
// recollection is appended with its time. The anonymous burst isn't rerun.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { rateLimitFromAudit, policyReserveFilter } from "../../../scripts/lib/c5a-gate-checks.js";

const dir = new URL(".", import.meta.url).pathname;
const statePath = `${dir}state.json`;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const fixtures = JSON.parse(readFileSync(`${dir}../fixtures.json`, "utf8"));
const item = fixtures.created.publicItem.id;
const since = state.capturesStartedAt;
const filter = policyReserveFilter(item, since);
const entries = JSON.parse(execFileSync("gcloud", ["logging", "read", filter, "--limit=1000", "--format=json", "--project=graffiticode"]).toString() || "[]");
const original = state.observations.publicAnonymous;
const attempted = original?.rateLimit?.attempted ?? null;
const recollected = { ...original, rateLimit: { ...rateLimitFromAudit(entries), attempted } };
state.observationHistory ??= {};
state.observationHistory.publicAnonymous ??= [];
if (!state.observationHistory.publicAnonymous.some(h => h.source === "captures")) {
  state.observationHistory.publicAnonymous.push({ source: "captures", at: "2026-11-18T04:22:33Z", value: original, note: "read before the 13th's refusal (04:22:32.955Z) was ingested" });
}
const at = new Date().toISOString();
state.observationHistory.publicAnonymous.push({ source: "recollect", at, filter, entries: entries.length, value: recollected });
state.observations.publicAnonymous = recollected;
writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
const rows = entries.map(e => e.jsonPayload).map(p => ({ at: p.at, commandId: p.commandId?.slice(0, 14), outcome: p.outcome, reason: p.reason ?? null, publicCapture: p.publicCapture }));
console.log(JSON.stringify({ at, entries: entries.length, recollected: recollected.rateLimit }));
for (const r of rows.sort((a, b) => a.at.localeCompare(b.at))) console.log(JSON.stringify(r));
