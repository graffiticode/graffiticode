// Step 32 deletion 1 (staging-gone), as reviewed: waits for the runner's
// printed deletion, verifies the four preconditions, and deletes only if all
// hold. Nothing secret is printed.
//   node deletion1-watcher.mjs <runner output file> <plan.json>
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const [outFile, planFile] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planFile, "utf8"));
const id = plan.ids["staging-gone"];
const STAGING = "graffiticode-command-staging";
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const gcloud = args => execFileSync("gcloud", [...args, "--project=graffiticode"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

log(`watching for the staging-gone deletion of ${id}`);
let m = null;
for (let i = 0; i < 900 && !m; i++) {
  const text = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
  m = /gcloud storage rm '(gs:\/\/graffiticode-command-staging\/[^']+)' --if-generation-match=(\d+)/.exec(text);
  if (!m) await sleep(1000);
}
if (!m) { log("REFUSED: no deletion printed"); process.exit(1); }
const [, object, printedGen] = m;
log(`printed: ${object} @ ${printedGen}`);
const token = gcloud(["auth", "print-access-token"]).trim();

// 1. The fault line names exactly plan.json's staging-gone id.
let faultLine = false;
for (let i = 0; i < 15 && !faultLine; i++) {
  const out = gcloud(["logging", "read", `resource.type="cloud_run_revision" AND resource.labels.service_name="l0013r-c5d-drive" AND textPayload:"capture fault exit-after-stage command ${id}"`, "--freshness=15m", "--format=value(timestamp)", "--limit=5"]).trim();
  faultLine = out.length > 0;
  if (!faultLine) await sleep(2000);
}
log(`1 fault line for ${id}: ${faultLine}`);

// 2. Policy's reservation is staged at stagedGeneration 1.
const res = await fetch(`https://firestore.googleapis.com/v1/projects/graffiticode/databases/policy/documents/commands/${encodeURIComponent(id)}/reservations`, { headers: { Authorization: `Bearer ${token}` } });
const docs = (await res.json()).documents ?? [];
const f = docs[0]?.fields ?? {};
const state = f.state?.stringValue, stagedGeneration = Number(f.stagedGeneration?.integerValue), stage = f.stage?.stringValue, occurrenceId = f.occurrenceId?.stringValue;
const reservationOk = docs.length === 1 && state === "staged" && stagedGeneration === 1;
log(`2 reservation: ${docs.length} doc(s), ${state} at stagedGeneration ${stagedGeneration}: ${reservationOk}`);

// 3. The object's name is <command id>/<stage>/<occurrence>.png from that reservation.
const expected = `gs://${STAGING}/${id}/${stage}/${occurrenceId}.png`;
const nameOk = object === expected;
log(`3 object name from the reservation: ${nameOk}`);

// 4. The generation is the one read now.
const liveGen = gcloud(["storage", "objects", "describe", object, "--format=value(generation)"]).trim();
const genOk = liveGen === printedGen;
log(`4 live generation ${liveGen} == printed ${printedGen}: ${genOk}`);

if (!(faultLine && reservationOk && nameOk && genOk)) { log("REFUSED: a precondition failed; nothing deleted"); process.exit(1); }
gcloud(["storage", "rm", object, `--if-generation-match=${printedGen}`]);
log(`DELETED ${object} @ ${printedGen}`);
