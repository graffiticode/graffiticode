#!/usr/bin/env node
// C5d fresh drive (IAM review Step 32a §0 and §9), read-only: compare the two
// retained commands' Policy records and the specified Broker records with the
// post-hold baseline (scripts/lib/c5d-retained-records.js says which).
//
//   node scripts/c5d-retained-records.js --hold <private after-2026-11-23 dir> --out <new dir> [--before <dir>]
//
// --hold   the PRIVATE originals of docs/evidence/c5d/hold/after-2026-11-23
//          (the published copies are redacted). Each baseline file must hash
//          to publication.json's originalSha256, or the record is unreadable.
// --out    a new directory: one <record id>.json per fresh read ({ status,
//          body }), and comparison.json. Never overwritten (it must not exist).
// --before the drive's own first capture (§0's --out), for the one record no
//          post-hold read saved (C2's Broker steps). Without it (only at §0),
//          that record is recorded, not compared.
//
// Exit 0: every record same. 1: any record changed. 2: any read or baseline
// unreadable (a status other than expected, bad JSON, a truncated or looping
// listing, a baseline that's missing or doesn't hash to publication.json), or
// a record left unbaselined after §0. The access token comes from gcloud and
// is never printed or written.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { compareAll, exitCode, holdReader } from "./lib/c5d-retained-records.js";

const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const hold = opt("--hold"); const out = opt("--out"); const before = opt("--before");
if (!hold || !out) {
  console.error("usage: c5d-retained-records.js --hold <private after-2026-11-23 dir> --out <new dir> [--before <dir>]");
  process.exit(2);
}
if (existsSync(out)) {
  console.error(`refused: ${out} exists (evidence is never overwritten)`);
  process.exit(2);
}
const ROOT = new URL("..", import.meta.url).pathname;
const publication = JSON.parse(readFileSync(path.join(ROOT, "docs/evidence/c5d/hold/publication.json"), "utf8"));
const token = execFileSync("gcloud", ["auth", "print-access-token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const call = async (url, init = {}) => {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" } });
  return { status: res.status, text: await res.text() };
};
const result = await compareAll({
  get: url => call(url),
  post: (url, body) => call(url, { method: "POST", body: JSON.stringify(body) }),
  readHold: holdReader({ readFile: name => readFileSync(path.join(hold, name), "utf8"), publication }),
  readBefore: before ? name => readFileSync(path.join(before, name), "utf8") : null,
});
mkdirSync(out, { recursive: true });
for (const [id, read] of Object.entries(result.fresh)) writeFileSync(path.join(out, `${id}.json`), `${JSON.stringify(read, null, 2)}\n`, { flag: "wx" });
const code = exitCode(result, { first: !before });
const summary = { at: new Date().toISOString(), before: before ?? null, changed: result.changed, unreadable: result.unreadable, unbaselined: result.unbaselined, exit: code, rows: result.rows };
writeFileSync(path.join(out, "comparison.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
for (const r of result.rows) console.log(`${r.verdict.padEnd(10)} ${r.id}${r.note ? ` — ${r.note}` : ""}`);
console.log(`\n${result.rows.length} records: ${result.changed} changed, ${result.unreadable} unreadable, ${result.unbaselined} recorded without a baseline; exit ${code}`);
process.exit(code);
