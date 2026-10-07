// The protected-chain inventory (capability plan W4, decision 2; runbook
// docs/protected-execution.md, "W4 activation and cutover"). Under
// CHAIN_ADMISSION=all every stage of a compile through a connection must be
// pinnable, so a chain with a stage in any other language fails admission
// (stage-not-pinnable). This is the evidence, from what actually ran, that no
// chain in use does: every invocation Policy allocated in a window (each is
// one compile through a connection, publication views included), its chain
// decoded, and each task's language read.
//
// Incomplete evidence is never a pass. The verdict fails on:
//   scan-failed         the invocation scan stopped with an error
//   coverage-mismatch   the scan saw a different number of invocations than
//                       the window's count
//   no-invocations      nothing in the window, so nothing was shown
//   unsupported-chains  a chain with a stage in a language that isn't pinnable
//   unreadable-chains   a chain that couldn't be decoded, or a task that is
//                       missing or unreadable, or has no language
//
// Everything it reads is injected (scripts/test/chain-inventory.test.js).
// The evidence names chains by their task ids and languages only: no users,
// owners or connections. Entry point: scripts/chain-inventory.js.

import { decodeChainId } from "@graffiticode/common/chain";

const normalizeLang = lang => {
  const s = String(lang ?? "").replace(/^L/i, "");
  return /^\d{1,4}$/.test(s) ? s.padStart(4, "0") : null;
};

// invocations.count({ since, until }) -> the number in the window
// invocations.scan({ since, until }) -> async iterable of { taskId, createdAt }
// taskLang(taskId) -> its language, null if the task doesn't exist, or
//   undefined if it has none (throws if it can't be read)
// pinnable: the languages whose revisions can be pinned (deploy.json)
export const buildChainInventory = async ({ invocations, taskLang, pinnable, since, until, now = () => new Date() }) => {
  const supportedLangs = new Set(pinnable.map(normalizeLang));
  const generatedAt = now().toISOString();
  const window = { since: since.toISOString(), until: until.toISOString() };

  let counted = null;
  let countError = null;
  try {
    counted = await invocations.count({ since, until });
  } catch (e) {
    countError = e?.message ?? String(e);
  }

  // One entry per distinct chain.
  const chains = new Map();
  let scanned = 0;
  let scanError = null;
  try {
    for await (const invocation of invocations.scan({ since, until })) {
      scanned += 1;
      const key = typeof invocation?.taskId === "string" && invocation.taskId.length ? invocation.taskId : null;
      const id = key ?? "(none)";
      const entry = chains.get(id) ?? { chainId: id, invocations: 0, firstSeen: null, lastSeen: null, hasTaskId: Boolean(key) };
      entry.invocations += 1;
      const at = typeof invocation?.createdAt === "string" ? invocation.createdAt : null;
      if (at && (!entry.firstSeen || at < entry.firstSeen)) entry.firstSeen = at;
      if (at && (!entry.lastSeen || at > entry.lastSeen)) entry.lastSeen = at;
      chains.set(id, entry);
    }
  } catch (e) {
    scanError = e?.message ?? String(e);
  }

  // Each task's language, read once.
  const langs = new Map();
  const langOf = async taskId => {
    if (!langs.has(taskId)) {
      langs.set(taskId, (async () => {
        try {
          const lang = await taskLang(taskId);
          if (lang === null) return { problem: "task-missing" };
          const normalized = normalizeLang(lang);
          return normalized ? { lang: normalized } : { problem: "task-lang-unreadable" };
        } catch {
          return { problem: "task-unreadable" };
        }
      })());
    }
    return langs.get(taskId);
  };

  const supported = [];
  const unsupported = [];
  const unreadable = [];
  for (const entry of chains.values()) {
    const { hasTaskId, ...seen } = entry;
    if (!hasTaskId) {
      unreadable.push({ ...seen, reason: "no-task-id" });
      continue;
    }
    let taskIds;
    try {
      taskIds = decodeChainId(entry.chainId);
    } catch {
      unreadable.push({ ...seen, reason: "undecodable-chain" });
      continue;
    }
    const stages = await Promise.all(taskIds.map(async (taskId, i) => ({ stage: `s${i}`, taskId, ...(await langOf(taskId)) })));
    const broken = stages.filter(s => s.problem);
    if (broken.length) {
      unreadable.push({ ...seen, reason: broken[0].problem, stages });
      continue;
    }
    const chain = { ...seen, langs: stages.map(s => s.lang) };
    if (stages.every(s => supportedLangs.has(s.lang))) supported.push(chain);
    else unsupported.push({ ...chain, stages: stages.filter(s => !supportedLangs.has(s.lang)) });
  }

  // How often each language sequence ran, for the release notes.
  const bySignature = new Map();
  for (const c of supported) {
    const key = c.langs.join(" <- ");
    const row = bySignature.get(key) ?? { langs: c.langs, chains: 0, invocations: 0 };
    row.chains += 1;
    row.invocations += c.invocations;
    bySignature.set(key, row);
  }

  const reasons = [];
  if (scanError) reasons.push("scan-failed");
  if (countError || counted !== scanned) reasons.push("coverage-mismatch");
  if (!countError && counted === 0) reasons.push("no-invocations");
  if (unsupported.length) reasons.push("unsupported-chains");
  if (unreadable.length) reasons.push("unreadable-chains");

  return {
    generatedAt,
    window,
    pinnable: [...supportedLangs].sort(),
    coverage: {
      invocationsCounted: counted,
      invocationsScanned: scanned,
      complete: !scanError && !countError && counted === scanned,
      ...(scanError ? { scanError } : {}),
      ...(countError ? { countError } : {}),
      distinctChains: chains.size,
      tasksRead: langs.size,
    },
    totals: { supported: supported.length, unsupported: unsupported.length, unreadable: unreadable.length },
    bySignature: [...bySignature.values()].sort((a, b) => b.invocations - a.invocations),
    unsupported,
    unreadable,
    verdict: reasons.length ? "fail" : "pass",
    reasons,
  };
};
