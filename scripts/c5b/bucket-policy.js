#!/usr/bin/env node
// C5b Step 30: graffiticode-thumbnails' bucket policy, by one etag-protected
// read/modify/write (docs/capability-policy-iam-review.md, Step 30). The edit
// (scripts/lib/c5b-thumbnails.js editBucketPolicy) removes projectEditor and
// projectViewer, and merges broker-run's objectUser and allUsers'
// legacyObjectReader into their roles' bindings: never a second binding for a
// role, and applying it twice changes nothing. The etag is kept, so
// set-iam-policy fails if the policy changed since it was read.
//
//   node scripts/c5b/bucket-policy.js edit  <policy-at-creation.json>  > policy-intended.json
//   node scripts/c5b/bucket-policy.js check <policy-after.json>        exits 1 unless exactly STEP30_EXPECTED
import { readFileSync } from "node:fs";
import { editBucketPolicy, normalizedBindings, STEP30_EDIT, STEP30_EXPECTED } from "../lib/c5b-thumbnails.js";

const [command, file] = process.argv.slice(2);
if (!["edit", "check"].includes(command) || !file) {
  console.error("usage: bucket-policy.js edit|check <policy.json>");
  process.exit(2);
}
const policy = JSON.parse(readFileSync(file, "utf8"));
if (command === "edit") {
  if (!policy.etag) throw new Error("the policy has no etag: read it with get-iam-policy --format=json");
  process.stdout.write(`${JSON.stringify(editBucketPolicy(policy, STEP30_EDIT), null, 2)}\n`);
} else {
  const got = normalizedBindings(policy);
  const same = JSON.stringify(got) === JSON.stringify(STEP30_EXPECTED);
  console.log(JSON.stringify({ expected: STEP30_EXPECTED, got, same }, null, 2));
  if (!same) process.exitCode = 1;
}
