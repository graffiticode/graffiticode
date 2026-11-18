// The C5a gate's after-phase reads (scripts/c5a-gate.js), made testable: the
// r36074e run found two measurement defects (the owner's review, 2026-11-18).
//
//   runCapturing(command, args, { timeoutMs, spawnImpl }) -> stdout
//     A child process whose exit code and stderr are kept: it rejects with a
//     CommandFailed carrying { code, signal, stderr, timedOut }. (The deploy
//     CLI's run() inherits stderr and reports only the exit code, so a bucket's
//     404 couldn't be told from any other failure.)
//   bucketObjectCount({ bucket, describe, list }) -> number
//     0 only for gcloud's exact not-found answer for that bucket; a permission
//     error, a timeout, any other failure or a malformed listing throws.
//   collectIndependently({ name: read }) -> { values, errors }
//     Each read runs on its own: one failing keeps the others' results.
//   approvalInventory(docsByLang) -> [{ name, fields }]  stable by document name
//   inventoryDigest(inventory)    -> canonicalDigest of it (key order never counts)
//   compareInventories(baseline, current) -> { added, deleted, modified, baselineCount, currentCount, identical }
//   historyReadTime(baselineAt, now) -> { readTime, exact }
//     Firestore serves any read time within the last hour, and older ones
//     (point-in-time recovery) only on a whole minute: the baseline's own time
//     while it can, else the whole minute at or before it.
import { spawn } from "node:child_process";
import { canonicalDigest } from "@graffiticode/common/canonical";

export class CommandFailed extends Error {
  constructor(command, args, { code = null, signal = null, stderr = "", timedOut = false }) {
    super(`${command} ${args.slice(0, 4).join(" ")} ${timedOut ? "timed out" : `failed (${code ?? signal})`}${stderr ? `: ${stderr.trim().split("\n").at(-1).slice(0, 300)}` : ""}`);
    Object.assign(this, { command, code, signal, stderr, timedOut });
  }
}

export const runCapturing = (command, args, { timeoutMs = 120_000, spawnImpl = spawn } = {}) => new Promise((resolve, reject) => {
  const child = spawnImpl(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  child.stdout.on("data", d => { stdout += d; });
  child.stderr.on("data", d => { stderr += d; });
  child.on("error", e => { clearTimeout(timer); reject(e); });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    if (code === 0 && !timedOut) resolve(stdout);
    else reject(new CommandFailed(command, args, { code, signal, stderr, timedOut }));
  });
});

// gcloud's answer for a bucket that doesn't exist, and nothing else.
export const isBucketNotFound = (e, bucket) =>
  e instanceof CommandFailed && e.code === 1 && !e.timedOut &&
  new RegExp(`^ERROR: \\(gcloud\\.storage\\.buckets\\.describe\\) gs://${bucket.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} not found: 404\\.?$`, "m").test(e.stderr);

export const bucketObjectCount = async ({ bucket, describe, list }) => {
  try {
    await describe();
  } catch (e) {
    if (isBucketNotFound(e, bucket)) return 0;
    throw e;
  }
  const out = await list();
  let listed;
  try {
    listed = JSON.parse(out || "[]");
  } catch {
    throw new Error(`gs://${bucket}: the listing isn't JSON`);
  }
  if (!Array.isArray(listed)) throw new Error(`gs://${bucket}: the listing isn't a list`);
  return listed.length;
};

export const collectIndependently = async readers => {
  const values = {};
  const errors = {};
  for (const [name, read] of Object.entries(readers)) {
    try {
      values[name] = await read();
    } catch (e) {
      errors[name] = String(e?.message ?? e).slice(0, 300);
    }
  }
  return { values, errors };
};

// Approval records as the revisions database returns them (REST documents,
// { name, fields }, fields already decoded), across languages, ordered by
// document name.
export const approvalInventory = docsByLang => Object.values(docsByLang).flat()
  .map(d => ({ name: d.name, fields: d.fields }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
export const inventoryDigest = inventory => canonicalDigest(inventory);

export const compareInventories = (baseline, current) => {
  const before = new Map(baseline.map(d => [d.name, canonicalDigest(d.fields)]));
  const after = new Map(current.map(d => [d.name, canonicalDigest(d.fields)]));
  const added = [...after.keys()].filter(n => !before.has(n)).sort();
  const deleted = [...before.keys()].filter(n => !after.has(n)).sort();
  const modified = [...after.keys()].filter(n => before.has(n) && before.get(n) !== after.get(n)).sort();
  return { added, deleted, modified, baselineCount: before.size, currentCount: after.size, identical: added.length === 0 && deleted.length === 0 && modified.length === 0 && before.size > 0 };
};

export const HISTORY_EXACT_WINDOW_MS = 55 * 60_000;
export const historyReadTime = (baselineAt, now = Date.now()) => {
  const t = Date.parse(baselineAt);
  if (!Number.isFinite(t)) throw new Error(`baseline time ${baselineAt}`);
  if (now - t < HISTORY_EXACT_WINDOW_MS) return { readTime: new Date(t).toISOString(), exact: true };
  return { readTime: new Date(Math.floor(t / 60_000) * 60_000).toISOString(), exact: false };
};
