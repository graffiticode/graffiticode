// Offline verification of the published, redacted C5d hold evidence.
// Run after npm run build, or pass --policy-module <released commands.js>.
// Optional --private-source <original hold directory> verifies preserved hashes.
// This script reads local files only and prints a summary; it performs no act.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const option = key => {
  const index = process.argv.indexOf(key);
  return index < 0 ? null : process.argv[index + 1];
};
const load = relative => JSON.parse(readFileSync(path.join(root, relative), "utf8"));
const sha = data => createHash("sha256").update(data).digest("hex");
const canonical = value => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
const same = (a, b, message) => assert.deepEqual(canonical(a), canonical(b), message);
const plainValue = value => {
  if (value?.mapValue) return Object.fromEntries(Object.entries(value.mapValue.fields ?? {}).map(([key, item]) => [key, plainValue(item)]));
  if (value?.arrayValue) return (value.arrayValue.values ?? []).map(plainValue);
  if (value?.integerValue !== undefined) return Number(value.integerValue);
  for (const key of ["stringValue", "booleanValue", "doubleValue", "timestampValue", "nullValue"]) {
    if (value && key in value) return value[key];
  }
  return null;
};
const plain = doc => Object.fromEntries(Object.entries(doc.fields ?? {}).map(([key, value]) => [key, plainValue(value)]));
const prefix = "preflight-2026-11-23";
const suffix = "after-2026-11-23";
const publication = load("publication.json");
const intent = load(`${publication.actId}.intent.json`);
const approval = load("step-4-approval.json");
const before = load(`${prefix}/legacy-command-second-read.json`);
const after = load(`${suffix}/legacy-command.json`);
const output = load(`${suffix}/apply.out`);
const holds = load(`${suffix}/legacy-holds.json`).documents ?? [];
const command = plain(after);
const stripHold = doc => {
  const { updateTime: _time, ...rest } = doc;
  const { hold: _hold, ...fields } = rest.fields;
  return { ...rest, fields };
};

same(stripHold(before), stripHold(after), "only hold and updateTime may change");
assert.ok(!("hold" in before.fields));
assert.notEqual(before.updateTime, after.updateTime);
assert.equal(command.status, "pending");
assert.equal(command.phase, "admitted");
assert.equal(command.owner.generation, 11);
assert.equal(command.hold.n, 1);
assert.equal(command.hold.actId, publication.actId);
assert.equal(command.hold.generation, 11);
assert.equal(intent.commandId, publication.commandId);
assert.equal(approval.actId, intent.actId);
assert.equal(output.commandId, intent.commandId);
assert.equal(output.replayed, false);
assert.equal(output.record.act, "apply");
assert.equal(output.record.fencing, "lease-expired");
assert.equal(output.record.at, publication.appliedAt);
assert.ok(output.record.readTime - output.record.leaseExpiresAt >= 100000);
assert.equal(holds.length, 1);
assert.ok(holds[0].name.endsWith(`/holds/${intent.actId}`));
same(plain(holds[0]), output.record, "history must equal the act output");
same(command.hold, output.hold, "hold field must equal the act output");
const { act: _act, fencing: _fencing, lifts: _lifts, ...recordHold } = output.record;
same(command.hold, recordHold, "hold and history must agree");
assert.equal(intent.operator, "<operator>");
assert.equal(command.hold.appliedBy.email, intent.operator);
assert.equal(command.hold.appliedBy.verifiedVia, "tokeninfo");

for (const [index, name] of ["occurrences", "reservations", "outcomes", "refusals", "ledger"].entries()) {
  same(load(`${prefix}/retained-records/fresh-${index + 2}.json`), load(`${suffix}/legacy-${name}.json`), `${name} changed`);
}
for (let index = 7; index <= 13; index++) {
  same(load(`${prefix}/retained-records/fresh-${index}.json`), load(`${suffix}/retained-records/fresh-${index}.json`), `drop-outcome record ${index} changed`);
}
same(load(`${prefix}/drop-outcome-reconciliation-attempts.json`), load(`${suffix}/drop-outcome-reconciliation-attempts.json`));
assert.equal(load(`${suffix}/drop-outcome-reconciliation-attempts.json`).documents.length, 1);
same(load(`${prefix}/legacy-broker-steps.json`), load(`${suffix}/legacy-broker-steps.json`));
same(load(`${prefix}/broker-positive-control.json`), load(`${suffix}/broker-positive-control.json`));
assert.equal(load(`${suffix}/broker-legacy-invocation-query.json`).filter(item => item.document).length, 0);
same(load(`${prefix}/broker-control-invocation-query.json`).filter(item => item.document).map(item => item.document), load(`${suffix}/broker-control-invocation-query.json`).filter(item => item.document).map(item => item.document));
const absent = load(`${suffix}/absence-readback.json`).results;
assert.equal(absent.length, 5);
assert.ok(absent.every(item => item.status === 404));
const legacyOccurrence = plain(load(`${prefix}/retained-records/fresh-2.json`).documents[0]);
const legacyHash = sha(`${plain(before).invocationId}/${legacyOccurrence.stage}/${legacyOccurrence.occurrenceId}`);
const dropHash = sha(plain(load(`${prefix}/retained-records/fresh-12.json`)).operationId);
same(absent.map(item => item.path).sort(), [
  `receipts/${legacyHash}`, `receipts/${legacyHash}/outcome/final`,
  `receipts/${legacyHash}/run/state`, `active-executions/${legacyHash}`,
  `receipts/${dropHash}/outcome/final`,
].sort());
const comparison = readFileSync(path.join(root, suffix, "retained-records/comparison.txt"), "utf8");
assert.equal(comparison.split("\n").filter(line => line.startsWith("CHANGED")).length, 1);
assert.ok(comparison.startsWith("CHANGED 200 staging-gone-disposal/1-policy-command.json"));

const modulePath = option("--policy-module") ?? path.resolve(root, "../../../../packages/policy/dist/commands.js");
assert.equal(sha(readFileSync(path.resolve(modulePath))), publication.policyCommandsModule.sha256, "use the Policy commands module built at the recorded release commit");
const { ownableBy } = await import(pathToFileURL(path.resolve(modulePath)).href);
const combinations = [];
for (const recording of [0, 1]) for (const repairs of [0, 1]) for (const scopes of [0, 1]) {
  combinations.push({ recording, repairs, scopes, ownable: ownableBy(command, { recording, repairs, scopes }) });
}
same(combinations, load(`${suffix}/ownable-by.json`));
assert.ok(combinations.every(item => item.ownable === false));
assert.equal(combinations.filter(c => ownableBy(plain(before), c)).length, 2);

const audits = load(`${suffix}/data-write-audit.json`);
assert.equal(audits.length, 1);
const audit = audits[0].protoPayload;
assert.equal(audit.methodName, "google.firestore.v1.Firestore.Commit");
assert.equal(audits[0].timestamp, publication.auditCommitAt);
assert.equal(audit.authenticationInfo.principalEmail, intent.operator);
assert.equal(audit.request.database, "projects/graffiticode/databases/policy");
assert.ok(!audit.status?.code);
assert.equal(audit.authorizationInfo.length, 2);
assert.ok(audit.authorizationInfo.every(item => item.permissionType === "DATA_WRITE" && item.granted));
assert.equal(audit.requestMetadata.callerIp, "<operator-ip>");
const expectedKeys = [after.name, holds[0].name].sort();
same([...audit.metadata.keys].sort(), expectedKeys);
same(audit.request.writes.map(item => item.update.name).sort(), expectedKeys);

for (const item of publication.files) {
  assert.equal(sha(readFileSync(path.join(root, item.path))), item.publishedSha256, `published hash: ${item.path}`);
  if (option("--private-source")) assert.equal(sha(readFileSync(path.join(option("--private-source"), item.path))), item.originalSha256, `private original changed: ${item.path}`);
}
let filesChecked = 0;
for (const relative of readdirSync(root, { recursive: true })) {
  const file = path.join(root, relative);
  if (!statSync(file).isFile()) continue;
  const text = readFileSync(file, "utf8");
  assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text), `email remains: ${relative}`);
  assert.ok(!/ya29\.[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), `credential-like value: ${relative}`);
  if (relative.endsWith(".json")) JSON.parse(text);
  if (relative !== "verification-summary.json") filesChecked++;
}
console.log(JSON.stringify({
  commandId: intent.commandId, actId: intent.actId, appliedAt: publication.appliedAt,
  commandChange: "hold and updateTime only", unchangedSubcollections: 5,
  dropOutcomeRecordsUnchanged: true, dropOutcomeReconciliationAttempts: 1,
  brokerPathsAbsent: absent.length, ownableFalse: combinations.length,
  audit: { commitCount: 1, permissionType: "DATA_WRITE", keys: expectedKeys, principal: "<operator>" },
  evidenceFilesCheckedExcludingSummary: filesChecked, privateOriginalHashesChecked: option("--private-source") ? publication.files.length : 0,
}, null, 2));
