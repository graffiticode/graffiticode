// Offline verification of the published, redacted Step 32a fresh-drive
// evidence (run d1ca6da0). Reads local files only and performs no act.
// Run from the repository after `npm run build` (it uses the runner's own
// judge library):
//
//   node docs/evidence/c5d/step32a/verify-published.mjs \
//     [--private-literals <private JSON list of exact strings>] [--private-source <private evidence root>]
//   node docs/evidence/c5d/step32a/verify-published.mjs --self-test
//
// No exact personal value is in this file: the operator's address and IPs are
// supplied at run time by --private-literals, a JSON array kept outside the
// repository. The generic patterns below are built from fragments, so this
// file can scan itself.
//
// It checks:
//   1. every published file hashes to files.json's publishedSha256, files
//      marked identical are byte-identical to their originals, and no file
//      under drive/d1ca6da0/ or step32a/ is unlisted;
//   2. every published file — the evidence, the generated files (this one
//      included) and both parent documents — carries no token, private key,
//      local path or sealed secret, no email address but service accounts,
//      and none of the private literals; each file is scanned as written and
//      again with backslash, \uXXXX, \xXX, %XX and HTML escapes decoded, so an
//      escaped literal (50\.x, user@host, %40) is found too;
//   3. the approved judgment's provenance: the supplement, its original
//      manifest and its raw receipt are published unchanged, at the approved
//      hashes;
//   4. the aggregate verdict, recomputed here from the published manifests:
//      default judging fails older-after-newer on its original manifest (the
//      recorded failed judgment), and with the approved supplement the drive
//      passes, the supplement equal to the one the aggregate report recorded;
//   5. the named retirement decision: the confirmed unrecoverable set is
//      exactly the approved three plans, as the fresh report listed them;
//   6. with --private-source, every listed and excluded file's originalSha256
//      against the private originals.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const self = fileURLToPath(import.meta.url);
const option = key => { const i = process.argv.indexOf(key); return i < 0 ? null : process.argv[i + 1]; };
// --root: another copy of docs/evidence/c5d to verify (the self-test's scratch copies).
const c5d = path.resolve(option("--root") ?? path.dirname(path.dirname(self)));
const here = path.join(c5d, "step32a");
const repo = path.resolve(path.dirname(self), "../../../..");
const sha = b => createHash("sha256").update(b).digest("hex");
const read = rel => readFileSync(path.join(c5d, rel));
const json = rel => JSON.parse(read(rel).toString("utf8"));
const walk = d => readdirSync(d).flatMap(f => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const results = [];
const check = (name, fn) => { fn(); results.push(name); console.log(`ok    ${name}`); };

// ------------------------------------------------------------------ the scan
// Generic patterns, each built from fragments so that no source line matches.
const J = (...parts) => parts.join("");
const GENERIC = [
  [new RegExp(J("ey", "J[A-Za-z0-9_-]{8,}\\.")), "a JWT"],
  [new RegExp(J("ya", "29\\.")), "a Google access token"],
  [new RegExp(J("BEGIN [A-Z ]*PRI", "VATE KEY")), "a private key"],
  [new RegExp(J("/pri", "vate/tmp|/Us", "ers/")), "a local path"],
  [new RegExp(J("sealed", "Secret")), "a sealed secret field"],
  [new RegExp(J("AI", "za[0-9A-Za-z_-]{30}")), "a Google API key"],
];
const EMAIL = new RegExp(J("[A-Za-z0-9._%+-]+", "@", "[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}"), "g");
// Service accounts are not personal; the one other address is a systemd unit in a VM's boot log.
const allowedEmail = e => /\.gserviceaccount\.com$/.test(e) || e === J("getty", "@", "tty1.service");
// Decodes the common escapes until stable (at most four passes).
export const decodeEscapes = text => {
  let t = text;
  for (let i = 0; i < 4; i++) {
    const next = t
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/\\(.)/g, "$1");
    if (next === t) break;
    t = next;
  }
  return t;
};
// The problems in one file's text: generic patterns, non-service emails, and
// the private literals (case-insensitive), as written and decoded.
export const scanText = (text, literals = []) => {
  const problems = [];
  for (const [form, t] of [["as written", text], ["decoded", decodeEscapes(text)]]) {
    for (const [re, what] of GENERIC) if (re.test(t)) problems.push(`${what} (${form})`);
    for (const e of t.match(EMAIL) ?? []) if (!allowedEmail(e)) problems.push(`an email address (${form})`);
    const lower = t.toLowerCase();
    for (const lit of literals) if (lower.includes(String(lit).toLowerCase())) problems.push(`a private literal (${form})`);
  }
  return [...new Set(problems)];
};
// Every published path: the evidence trees (listed or not), and both parent documents.
const publishedPaths = () => [
  ...walk(path.join(c5d, "drive/d1ca6da0")).map(a => path.relative(c5d, a)),
  ...walk(here).map(a => path.relative(c5d, a)),
  "README.md",
  "REDACTIONS.txt",
];
const privateLiterals = () => {
  const file = option("--private-literals");
  if (!file) return [];
  const list = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(list) || list.some(s => typeof s !== "string" || s.length < 4)) throw new Error("--private-literals must be a JSON array of strings");
  return list;
};

// ------------------------------------------------------------- the self-test
// Regressions on synthetic values only (TEST-NET-3 addresses, example.com):
// leaks planted in generated files, in a parent document and in an evidence
// file, plain and escaped, must each fail check 2; a clean copy must pass.
if (process.argv.includes("--self-test")) {
  const { mkdtempSync, cpSync, writeFileSync: write, appendFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const IP = J("203.0.", "113.77");
  const MAIL = J("someone", "@", "example.com");
  const JWT = J("ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiJ4In0", ".", "c2ln");
  const lits = path.join(mkdtempSync(path.join(tmpdir(), "c5d-literals-")), "literals.json");
  write(lits, JSON.stringify([IP, MAIL]));
  const unit = [
    ["a plain literal", `addr ${IP}`],
    ["a regex-escaped literal", `/\\b${IP.replaceAll(".", "\\.")}\\b/`],
    ["a JSON-escaped literal", JSON.stringify(`x ${MAIL}`).replace("@", "\\u0040")],
    ["a percent-escaped email", MAIL.replace("@", "%40")],
    ["an HTML-escaped email", MAIL.replace("@", "&#64;")],
    ["a doubly escaped literal", IP.replaceAll(".", "\\\\.")],
    ["a synthetic JWT", `token ${JWT}`],
    ["a non-service email", J("x", "@", "example.org")],
  ];
  for (const [name, text] of unit) assert.ok(scanText(text, [IP, MAIL]).length > 0, `unit: ${name} is found`);
  assert.deepEqual(scanText(J("svc", "@", "p.iam.gserviceaccount.com"), [IP]), [], "unit: a service account is allowed");
  console.log(`ok    self-test: ${unit.length} unit leaks found; a service account allowed`);
  const run = root => spawnSync(process.execPath, [self, "--root", root, "--private-literals", lits, "--scan-only"], { encoding: "utf8" });
  const copy = () => {
    const root = mkdtempSync(path.join(tmpdir(), "c5d-selftest-"));
    for (const p of ["drive/d1ca6da0", "step32a", "README.md", "REDACTIONS.txt"]) cpSync(path.join(c5d, p), path.join(root, p), { recursive: true });
    return root;
  };
  const clean = copy();
  const ok = run(clean);
  assert.equal(ok.status, 0, `a clean copy passes: ${ok.stdout}${ok.stderr}`);
  rmSync(clean, { recursive: true, force: true });
  const planted = [
    ["a JWT in the generated README", "step32a/README.md", `\n${JWT}\n`],
    ["a literal in the generated publication.json", "step32a/publication.json", null, t => t.replace('"schema": 1', `"schema": 1, "x": "${IP}"`)],
    ["an escaped literal in the verifier itself", "step32a/verify-published.mjs", `\n// ${IP.replaceAll(".", "\\.")}\n`],
    ["an escaped email in files.json", "step32a/files.json", null, t => t.replace('"schema": 1', `"schema": 1, "x": "${MAIL.replace("@", "\\u0040")}"`)],
    ["a literal in the parent REDACTIONS.txt", "REDACTIONS.txt", `\n${IP}\n`],
    ["a non-service email in the parent README.md", "README.md", `\n${J("a", "@", "example.net")}\n`],
    ["a literal in an unlisted evidence file", "step32a/stray.txt", `${IP}\n`],
  ];
  for (const [name, rel, append, transform] of planted) {
    const root = copy();
    const file = path.join(root, rel);
    if (transform) write(file, transform(readFileSync(file, "utf8")));
    else appendFileSync(file, append);
    const r = run(root);
    assert.notEqual(r.status, 0, `planted ${name}: the verifier must fail`);
    assert.match(`${r.stdout}${r.stderr}`, /2\. |unlisted file/, `planted ${name}: failed on the scan (or as unlisted)`);
    rmSync(root, { recursive: true, force: true });
    console.log(`ok    self-test: planted ${name} -> fails`);
  }
  console.log("\nself-test passed");
  process.exit(0);
}

const publication = json("step32a/publication.json");
const { files, excluded } = json("step32a/files.json");
const GENERATED = new Set(publication.generatedFiles);

check("1. every published file matches files.json; identical files equal their originals; nothing unlisted", () => {
  for (const f of files) {
    const h = sha(read(f.path));
    assert.equal(h, f.publishedSha256, `${f.path}: published hash`);
    if (f.identical) assert.equal(f.originalSha256, f.publishedSha256, `${f.path}: marked identical`);
    else assert.ok(f.operatorEmailReplacements + f.operatorIpReplacements + f.localPathNormalizations + f.userDataElisions > 0, `${f.path}: a derivative names its changes`);
  }
  const listed = new Set([...files.map(f => f.path), ...GENERATED]);
  for (const abs of [...walk(path.join(c5d, "drive/d1ca6da0")), ...walk(here)]) {
    const rel = path.relative(c5d, abs);
    assert.ok(listed.has(rel), `unlisted file ${rel}`);
  }
});

const literals = privateLiterals();
check(`2. every published file (${publishedPaths().length}, generated files and both parent documents included) is clean: no token, key, local path, sealed secret, personal email${literals.length ? `, or any of ${literals.length} private literals` : " (no --private-literals: exact addresses not checked)"}, as written or decoded`, () => {
  const found = [];
  for (const rel of publishedPaths()) {
    const problems = scanText(read(rel).toString("utf8"), literals);
    if (problems.length) found.push(`${rel}: ${problems.join(", ")}`);
  }
  assert.deepEqual(found, [], `2. leaks found:\n${found.join("\n")}`);
});
if (process.argv.includes("--scan-only")) process.exit(0);

const P = publication.provenance;
check("3. the approved supplement, its original manifest and raw receipt are published unchanged at the approved hashes", () => {
  for (const key of ["originalManifest", "approvedSupplement", "receipt", "aggregateReport"]) {
    const { path: p, sha256 } = P[key];
    assert.equal(sha(read(p)), sha256, `${key} ${p}`);
    const entry = files.find(f => f.path === p);
    assert.ok(entry?.identical, `${key} is published byte-identical to its original`);
  }
  const supplement = json(P.approvedSupplement.path);
  assert.equal(supplement.rejudge.of.file, path.basename(P.originalManifest.path));
  assert.equal(supplement.rejudge.of.sha256, P.originalManifest.sha256);
  assert.equal(supplement.rejudge.receipt.sha256, P.receipt.sha256);
  const original = json(P.originalManifest.path);
  assert.equal(original.observations.olderOutcome, undefined, "the original manifest is the unfixed one");
});

const lib = await import(pathToFileURL(path.join(repo, "scripts/lib/c5d-drive-checks.js")).href);
{
  const runDir = path.join(c5d, "drive/d1ca6da0");
  const latest = lib.latestByPhase(readdirSync(runDir));
  const load = f => JSON.parse(readFileSync(path.join(runDir, f), "utf8")).observations;
  const phasesWith = approved => {
    const phases = { baseline: load(lib.BASELINE_FILE) };
    for (const p of lib.DRIVE_PHASES) {
      if (p === "baseline" || !latest[p]) continue;
      phases[p] = approved?.phase === p ? approved.observations : load(latest[p]);
      const step = { "drop-outcome": "drop-outcome-retry", "staging-gone": "staging-gone-delete" }[p];
      if (step && latest[step]) {
        const extra = load(latest[step]);
        phases[p] = { ...phases[p], ...extra, errors: { ...(phases[p].errors ?? {}), ...(extra.errors ?? {}) } };
      }
    }
    if (phases.boundary) phases.boundary = { ...phases.boundary, thumbnailsBefore: phases.baseline?.thumbnails };
    return phases;
  };
  const plain = lib.verdict(phasesWith(null));
  const failed = plain.phases.flatMap(p => p.checks.filter(c => !c.ok).map(c => `${p.phase}/${c.id}`));
  assert.deepEqual(failed, ["older-after-newer/older-newer-present"], "default judging fails exactly the recorded check");
  assert.equal(latest["older-after-newer"], path.basename(P.originalManifest.path), "the failed original is the phase's latest manifest");
  const approved = lib.approvedRejudge({
    runId: "d1ca6da0", latest, sourceText: readFileSync(path.join(runDir, latest["older-after-newer"])),
    reportFile: path.basename(P.approvedSupplement.path), reportText: read(P.approvedSupplement.path),
    receiptFile: path.basename(P.receipt.path), receiptText: read(P.receipt.path),
  });
  const result = lib.verdict(phasesWith(approved));
  assert.equal(result.passed, true, "the drive passes with the approved supplement");
  assert.equal(result.phases.length, 18);
  assert.equal(result.phases.reduce((n, p) => n + p.checks.length, 0), P.aggregateChecks);
  const aggregate = json(P.aggregateReport.path);
  assert.equal(aggregate.passed, true);
  assert.deepEqual(aggregate.supplements, [approved.supplement], "the aggregate recorded exactly this supplement");
  assert.equal(aggregate.manifests["older-after-newer"], path.basename(P.originalManifest.path), "the aggregate keeps the failed original");
  results.push("4");
  console.log("ok    4. the aggregate, recomputed offline: the original failed judgment, and DRIVE PASSED only with the approved supplement");
  console.log(`      default: 1 failed check (older-after-newer/older-newer-present); approved: DRIVE PASSED, ${result.phases.length} phases, ${P.aggregateChecks} checks`);
}

check("5. the named retirement decision: the confirmed unrecoverable set is exactly the approved three plans", () => {
  const approvedSet = [...publication.retirementDecision.plans].sort();
  const listed = rel => [...read(rel).toString("utf8").matchAll(/^ {2}([0-9a-f]{64}) /gm)].map(m => m[1]).sort();
  assert.deepEqual(listed(publication.retirementDecision.freshReport), approvedSet, "the fresh report's set");
  assert.deepEqual(listed(publication.retirementDecision.confirmedTranscript), approvedSet, "the confirmed run's set");
  const record = json(publication.retirementDecision.revisionRecord).fields;
  const confirmed = (record.unrecoverable?.arrayValue?.values ?? []).map(v => v.stringValue).sort();
  assert.deepEqual(confirmed, approvedSet, "the revision record's confirmed set");
  assert.equal(record.status.stringValue, "retired");
  const l0176r = json(publication.retirementDecision.normalRetirementRecord).fields;
  assert.equal(l0176r.status.stringValue, "retired");
  assert.deepEqual(l0176r.unrecoverable?.arrayValue?.values ?? [], [], "l0176r-c5d-drive retired with an empty report: nothing confirmed unrecoverable");
});

const priv = option("--private-source");
if (priv) check("6. every listed and excluded file's original hash, against the private originals", () => {
  for (const f of files) assert.equal(sha(readFileSync(path.join(priv, f.source))), f.originalSha256, f.source);
  for (const x of excluded) assert.equal(sha(readFileSync(path.join(priv, x.source))), x.originalSha256, x.source);
});
else console.log("skip  6. (no --private-source)");

console.log(`\n${results.length} checks passed; ${files.length} files (${files.filter(f => f.identical).length} identical, ${files.filter(f => !f.identical).length} redacted derivatives), ${excluded.length} excluded with hashes`);
if (!existsSync(path.join(repo, "packages/broker/dist"))) console.log("(note: run npm run build first)");
