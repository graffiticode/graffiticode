// Step 32a deletion 1 (staging-gone) for run d1ca6da0, as approved: waits for
// the runner's printed deletion, verifies the five preconditions, and deletes
// only if all hold. Nothing secret is printed.
//   node deletion1-watcher.mjs <runner output file> <plan.json> <approved command id>
// Based on docs/evidence/c5d/step32/run2/deletion1-watcher.mjs, plus check 5:
// no Broker claim exists for the reservation's operation.
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const [outFile, planFile, approved] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planFile, "utf8"));
const id = plan.ids["staging-gone"];
const STAGING = "graffiticode-command-staging";
const FS = "https://firestore.googleapis.com/v1/projects/graffiticode/databases";
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const gcloud = args => execFileSync("gcloud", [...args, "--project=graffiticode"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

if (id !== approved) { log(`REFUSED: plan's staging-gone id ${id} is not the approved ${approved}`); process.exit(1); }
log(`watching for the staging-gone deletion of ${id}`);
let m = null;
for (let i = 0; i < 900 && !m; i++) {
  const text = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
  m = /gcloud storage rm '(gs:\/\/graffiticode-command-staging\/[^']+)' --if-generation-match=(\d+)/.exec(text);
  if (!m) await sleep(500);
}
if (!m) { log("REFUSED: no deletion printed"); process.exit(1); }
const [, object, printedGen] = m;
log(`printed: ${object} @ ${printedGen}`);
const token = gcloud(["auth", "print-access-token"]).trim();
const get = async path => { const r = await fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${token}` } }); return { status: r.status, body: await r.json().catch(() => null) }; };

// 1. The fault line names exactly this command.
let faultLine = false;
for (let i = 0; i < 15 && !faultLine; i++) {
  const out = gcloud(["logging", "read", `resource.type="cloud_run_revision" AND resource.labels.service_name="l0013r-c5d-drive" AND textPayload:"capture fault exit-after-stage command ${id}"`, "--freshness=15m", "--format=value(timestamp)", "--limit=5"]).trim();
  faultLine = out.length > 0;
  if (!faultLine) await sleep(1500);
}
log(`1 fault line for ${id}: ${faultLine}`);

// 2. Exactly one reservation, staged at stagedGeneration 1.
const res = await get(`policy/documents/commands/${encodeURIComponent(id)}/reservations`);
const docs = res.body?.documents ?? [];
const f = docs[0]?.fields ?? {};
const state = f.state?.stringValue, stagedGeneration = Number(f.stagedGeneration?.integerValue), stage = f.stage?.stringValue, occurrenceId = f.occurrenceId?.stringValue;
const reservationOk = res.status === 200 && docs.length === 1 && state === "staged" && stagedGeneration === 1;
log(`2 reservation: ${docs.length} doc(s), ${state} at stagedGeneration ${stagedGeneration}: ${reservationOk}`);

// 3. The object's name is <command id>/<stage>/<occurrence>.png from that reservation.
const expected = `gs://${STAGING}/${id}/${stage}/${occurrenceId}.png`;
const nameOk = object === expected;
log(`3 object name from the reservation: ${nameOk}`);

// 4. The generation read now is the fence.
const liveGen = gcloud(["storage", "objects", "describe", object, "--format=value(generation)"]).trim();
const genOk = liveGen === printedGen;
log(`4 live generation ${liveGen} == printed ${printedGen}: ${genOk}`);

// 5. No Broker claim exists for this operation.
const cmd = await get(`policy/documents/commands/${encodeURIComponent(id)}`);
const invocationId = cmd.body?.fields?.invocationId?.stringValue;
const opid = `${invocationId}/${stage}/${occurrenceId}`;
const H = createHash("sha256").update(opid).digest("hex");
const claim = typeof invocationId === "string" ? await get(`broker/documents/receipts/${H}`) : { status: "no-invocation" };
const noClaim = claim.status === 404;
log(`5 no Broker claim for ${opid} (receipts/${H}): ${claim.status} -> ${noClaim}`);

if (!(faultLine && reservationOk && nameOk && genOk && noClaim)) { log("REFUSED: a precondition failed; nothing deleted"); process.exit(1); }
gcloud(["storage", "rm", object, `--if-generation-match=${printedGen}`]);
log(`DELETED ${object} @ ${printedGen}`);
