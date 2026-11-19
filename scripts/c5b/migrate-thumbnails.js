#!/usr/bin/env node
// C5b slice 3: the one-time migration copy of graffiticode.appspot.com's
// thumbnails/{item}.png into graffiticode-thumbnails/{item}.png
// (docs/c5b-thumbnails-bucket-plan.md). Runs with the operator's own
// credentials (a project owner); the rules are scripts/lib/c5b-thumbnails.js.
//
//   node scripts/c5b/migrate-thumbnails.js --phase plan   --dir <evidence dir>   read-only: plan-1.json
//   node scripts/c5b/migrate-thumbnails.js --phase copy   --dir <evidence dir>   the only write: copy-<n>-<at>.json
//   node scripts/c5b/migrate-thumbnails.js --phase amend  --dir <evidence dir>   read-only: plan-<n+1>.json
//   node scripts/c5b/migrate-thumbnails.js --phase verify --dir <evidence dir>   read-only: verify-<n>-<at>.json
//
// C5d step 4, the catch-up (docs/c5d-snapshot-commands-plan.md, slice 1 item 4),
// against C5b's evidence (--dir: the final plan and every copy manifest), its
// own manifests in --out (default --dir):
//   node scripts/c5b/migrate-thumbnails.js --phase catchup        --dir <c5b dir> --out <c5d dir>   writes: catchup-<at>.json
//   node scripts/c5b/migrate-thumbnails.js --phase catchup-verify --dir <c5b dir> --out <c5d dir>   read-only: catchup-verify-<at>.json
//
// Every manifest is written once and never changed: plan-<n>.json refuses to
// overwrite, and each copy, verify, catchup or catchup-verify run writes its
// own timestamped file. copy runs against the highest-numbered plan and stops
// at the first source-changed, exists-differs or failed entry; after
// source-changed, run amend (and have the amended plan reviewed), then copy
// again. verify passes only for the final plan with every entry created or
// adopted. catchup copies every source whose generation differs from the
// final plan's (or that it lacks), fenced on the listed source generation and
// on the destination generation C5b's copy created (or 0); it stops at the
// first source-changed, destination-differs or failed entry, and a rerun
// re-lists and writes its own manifest.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { planEntries, runCopy, amendPlan, verifyPlan, selectCatchup, runCatchup, verifyCatchup, writeManifestOnce, SOURCE_BUCKET, DESTINATION_BUCKET } from "../lib/c5b-thumbnails.js";

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const phase = flag("--phase");
const dir = flag("--dir");
const out = flag("--out") ?? dir;
if (!["plan", "copy", "amend", "verify", "catchup", "catchup-verify"].includes(phase) || !dir) {
  console.error("usage: migrate-thumbnails.js --phase plan|copy|amend|verify|catchup|catchup-verify --dir <evidence dir> [--out <catch-up evidence dir>]");
  process.exit(2);
}
mkdirSync(dir, { recursive: true });
mkdirSync(out, { recursive: true });

const API = "https://storage.googleapis.com";
let token = null;
const auth = () => ({ Authorization: `Bearer ${(token ??= execFileSync("gcloud", ["auth", "print-access-token"]).toString().trim())}` });
const json = async res => { try { return await res.json(); } catch { return null; } };
const o = name => encodeURIComponent(name);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The JSON API, as scripts/lib/c5b-thumbnails.js injects it.
const storage = {
  async rewrite({ sourceBucket, source, sourceGeneration, bucket, name, ifGenerationMatch, metadata, rewriteToken }) {
    // Never an unfenced rewrite: both preconditions are always sent.
    if (!sourceGeneration || ifGenerationMatch === undefined || ifGenerationMatch === null) throw new Error(`rewrite of ${name} without both generation preconditions`);
    const q = new URLSearchParams({ ifSourceGenerationMatch: sourceGeneration, ifGenerationMatch: String(ifGenerationMatch), ...(rewriteToken ? { rewriteToken } : {}) });
    const res = await fetch(`${API}/storage/v1/b/${o(sourceBucket)}/o/${o(source)}/rewriteTo/b/${o(bucket)}/o/${o(name)}?${q}`, { method: "POST", headers: { ...auth(), "Content-Type": "application/json" }, body: JSON.stringify(metadata) });
    return { status: res.status, body: await json(res) };
  },
  async get(bucket, name) {
    const res = await fetch(`${API}/storage/v1/b/${o(bucket)}/o/${o(name)}`, { headers: auth() });
    return { status: res.status, body: await json(res) };
  },
};
const listSource = async () => {
  const items = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({ prefix: "thumbnails/", ...(pageToken ? { pageToken } : {}) });
    const res = await fetch(`${API}/storage/v1/b/${o(SOURCE_BUCKET)}/o?${q}`, { headers: auth() });
    if (res.status !== 200) throw new Error(`listing ${SOURCE_BUCKET}: ${res.status}`);
    const body = await res.json();
    items.push(...(body.items ?? []));
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return items;
};

const plans = () => readdirSync(dir).map(f => /^plan-(\d+)\.json$/.exec(f)).filter(Boolean).map(m => Number(m[1])).sort((a, b) => a - b);
const readJson = f => JSON.parse(readFileSync(path.join(dir, f), "utf8"));
// Exclusive creation: a manifest someone else created first is never overwritten.
const writeOnce = (f, value) => writeManifestOnce(path.join(dir, f), value);
const latestPlan = () => {
  const n = plans().at(-1);
  if (!n) throw new Error("no plan: run --phase plan first");
  return readJson(`plan-${n}.json`);
};
const copies = () => readdirSync(dir).filter(f => /^copy-\d+-.+\.json$/.test(f)).sort().map(readJson);
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
// The catch-up's manifests, oldest first (the timestamped names sort in run
// order); catchup-verify-<at>.json is not one of them.
const catchups = () => readdirSync(out).filter(f => /^catchup-\d{4}-.+\.json$/.test(f)).sort().map(f => JSON.parse(readFileSync(path.join(out, f), "utf8")));
const writeOnceOut = (f, value) => writeManifestOnce(path.join(out, f), value);
const catchupSelection = async () => {
  const plan = latestPlan();
  return selectCatchup({ plan, copies: copies(), listing: await listSource() });
};

if (phase === "plan") {
  if (plans().length) throw new Error("a plan exists: use --phase amend for a later one");
  const listing = await listSource();
  const { entries, problems } = planEntries(listing);
  const file = writeOnce("plan-1.json", { number: 1, at: new Date().toISOString(), source: SOURCE_BUCKET, destination: DESTINATION_BUCKET, entries, problems });
  console.log(`plan 1: ${entries.length} entries, ${problems.length} problem(s); ${file}`);
  if (problems.length) process.exitCode = 1;
}

if (phase === "amend") {
  const plan = latestPlan();
  const amended = amendPlan({ plan, copies: copies(), listing: await listSource() });
  const file = writeOnce(`plan-${amended.number}.json`, { ...amended, at: new Date().toISOString(), source: SOURCE_BUCKET, destination: DESTINATION_BUCKET });
  console.log(`plan ${amended.number} (amends ${plan.number}): changed ${JSON.stringify(amended.changed)}, ${amended.problems.length} problem(s); ${file}`);
  if (amended.problems.length) process.exitCode = 1;
}

if (phase === "copy") {
  const plan = latestPlan();
  if (plan.problems?.length) throw new Error(`plan ${plan.number} has problems; it can't be copied`);
  const at = new Date().toISOString();
  const result = await runCopy({ plan, storage, sleep, onEntry: e => console.log(`${e.outcome.padEnd(14)} ${e.destination}${e.reason ? ` (${e.reason})` : ""}`) });
  const file = writeOnce(`copy-${plan.number}-${stamp()}.json`, { at, finishedAt: new Date().toISOString(), ...result });
  console.log(result.complete ? `copy of plan ${plan.number} complete; ${file}` : `copy of plan ${plan.number} STOPPED at ${result.stoppedAt}; ${file}`);
  if (!result.complete) process.exitCode = 1;
}

if (phase === "verify") {
  const plan = latestPlan();
  const destinations = {};
  const sources = {};
  const reads = {};
  for (const e of plan.entries) {
    const d = await storage.get(DESTINATION_BUCKET, e.destination);
    destinations[e.destination] = d.status === 200 ? d.body : null;
    const s = await storage.get(SOURCE_BUCKET, e.source);
    if (s.status === 200) sources[e.source] = s.body.generation;
    else if (s.status === 404) sources[e.source] = null;
    // Anonymously: no credentials at all.
    const res = await fetch(`${API}/${DESTINATION_BUCKET}/${e.destination.split("/").map(encodeURIComponent).join("/")}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    reads[e.destination] = { status: res.status, md5Hash: res.status === 200 ? createHash("md5").update(bytes).digest("base64") : null };
  }
  const list = {
    json: (await fetch(`${API}/storage/v1/b/${DESTINATION_BUCKET}/o?maxResults=1`)).status,
    xml: (await fetch(`${API}/${DESTINATION_BUCKET}`)).status,
  };
  const result = verifyPlan({ plan, copies: copies(), destinations, anonymous: { reads, list }, sources });
  const file = writeOnce(`verify-${plan.number}-${stamp()}.json`, { at: new Date().toISOString(), plan: plan.number, ...result, anonymousList: list });
  for (const p of result.problems) console.log(`FAILED ${p}`);
  for (const u of result.updatedSinceCopy) console.log(`updated since copy (for C5d): ${u.source} ${u.copied} -> ${u.now}`);
  console.log(`${result.ok ? "verified" : "NOT verified"}: plan ${plan.number}, ${plan.entries.length} entries; ${file}`);
  if (!result.ok) process.exitCode = 1;
}

if (phase === "catchup") {
  const at = new Date().toISOString();
  const selection = await catchupSelection();
  if (selection.problems.length) {
    for (const p of selection.problems) console.log(`REFUSED ${p}`);
    console.log("the catch-up selection has problems; nothing copied, no manifest written");
    process.exit(1);
  }
  for (const s of selection.absentFromListing) console.log(`no longer in the old bucket (left as copied): ${s}`);
  const result = await runCatchup({ selection, storage, sleep, onEntry: e => console.log(`${e.outcome.padEnd(19)} ${e.destination} (source ${e.sourceGeneration}, ifGenerationMatch ${e.ifGenerationMatch})${e.reason ? ` ${e.reason}` : ""}`) });
  const file = writeOnceOut(`catchup-${stamp()}.json`, { at, finishedAt: new Date().toISOString(), source: SOURCE_BUCKET, destination: DESTINATION_BUCKET, selected: selection.entries, absentFromListing: selection.absentFromListing, ...result });
  console.log(result.complete ? `catch-up against plan ${selection.plan} complete: ${selection.entries.length} selected; ${file}` : `catch-up STOPPED at ${result.stoppedAt}; ${file}`);
  if (!result.complete) process.exitCode = 1;
}

if (phase === "catchup-verify") {
  const selection = await catchupSelection();
  const destinations = {};
  for (const e of selection.entries) {
    const d = await storage.get(DESTINATION_BUCKET, e.destination);
    if (d.status !== 200 && d.status !== 404) throw new Error(`reading ${e.destination}: ${d.status}`);
    destinations[e.destination] = d.status === 200 ? d.body : null;
  }
  const result = verifyCatchup({ selection, catchups: catchups(), destinations });
  const file = writeOnceOut(`catchup-verify-${stamp()}.json`, { at: new Date().toISOString(), ...result });
  for (const p of result.problems) console.log(`FAILED ${p}`);
  console.log(`${result.ok ? "verified" : "NOT verified"}: catch-up against plan ${selection.plan}, ${result.selected} selected; ${file}`);
  if (!result.ok) process.exitCode = 1;
}
