// The C5a live gate's verdict (docs/c5-l0013-commands-plan.md, "C5a completion
// gate"), as pure functions of what scripts/c5a-gate.js observed. The runner
// collects; only this module judges, so the judgment is tested offline
// (scripts/test/c5a-gate-checks.test.js) and can be re-run on saved evidence.
//
//   verdict(observations) -> { passed, checks: [{ id, title, ok, detail }] }
//
// A check whose observation is missing fails ("not observed"): the gate passes
// only on positive evidence for every row. `observations` is plain JSON:
//
//   approvals      { l0013r: { revision, contractVersions }, l0000r: {...}, l0176r: {...},
//                    beforeDigest, afterDigest }        approval records before C5a, read before and after
//   canary         { checks, failed, l0185RegistryVersion, l0176RegistryVersion }
//   repairRoundtrip { passed }
//   v2PlanDigest   { before, after }
//   v8Artifact     { served }
//   plans          [{ name, stages: [{ lang, revision, contractVersions, registryVersion }], admitted }]
//   privateOwner   { outcome, reservedSequence, published: { bucket, captureSequence } }
//   privateNonOwner { outcome, reason }
//   narrowed       { reason }                           live: authorize-execution after access narrowed
//   publicAnonymous { outcome, subject, publicCapture, rateLimit: { allowed, refused, attempted } }
//                    rateLimit from Policy's command-reserve audit for the item (rateLimitFromAudit)
//   mixed          { invocations, tokens: [{ fn, scopeKinds }] }
//   composition    { outcome, connectionId, contractVersion, itemScopeAuthorized }
//   conditional    { attempts: [{ decisionId }], finalSequence, newerSequence }   live
//   reserveStageBind { order, repeatReserveSame, repeatStageSame, publishedSequence, reservedSequence, outOfOrderFinal, outOfOrderNewer }   live
//   elsewhere      { appspotBefore, appspotAfter, thumbnailsObjects }
//   oldWorkers     dueObservation(): { v3Fixtures, control, productionListedV3, scopedListedV3, controlListedToProduction, controlListedToScoped, productionLease }
//   fixtureCleanup c5a-gate-fixtures.js verifyRetired(): { fixtures, statuses, listedAfter }
//   deployed       { policy, broker, ... }               each service's serving commit
//   hermetic       { <row>: { service, commit, test, output, passed, result, uninducible?, fixture?, results? } }
//                  mismatches (results: [{ direction, reason }]) and preSlice6 (fixture, result.reason)
//                  are hermetic only; narrowed, conditional and reserveStageBind accept a hermetic
//                  fallback only with no live observation, and with `uninducible` saying why
//   consoleRoute   [{ caller, status }]                 policy-run and others
//   proxy          { verifyRollout, at11 }              Step 26's evidence
//   gateBucket     "graffiticode-c5a-gate"

//   errors         { <observation>: message }           a read that failed; any fails the gate
//
// The adapters below turn stored records and audit entries into these
// observations; they are tested against the shapes the services write
// (scripts/test/c5a-gate-checks.test.js).

export const GATE_BUCKET = "graffiticode-c5a-gate";
const POLICY_RUN = "policy-run@graffiticode.iam.gserviceaccount.com";
// Policy's public-capture quota (packages/policy/src/policy.ts
// PUBLIC_CAPTURE_LIMIT): the (limit+1)th reservation in its window is refused.
export const PUBLIC_CAPTURE_LIMIT = 12;
// Each scenario's chain, head first: its stages' languages.
export const SCENARIOS = Object.freeze({ private: ["0013"], composition: ["0000", "0013"], mixed: ["0013", "0176"] });

// ---------------------------------------------------------------- adapters

// A plan's stages from its stored document in Policy's `plans` collection:
// `{ plan: { contractVersion, stages: [pinned manifest] }, invocationId, revisions }`
// (policy firestore.ts commitPlan; common contract.ts pinnedStage).
export const planStages = planDoc => (Array.isArray(planDoc?.plan?.stages) ? planDoc.plan.stages : []);
export const planContractVersion = planDoc => planDoc?.plan?.contractVersion ?? null;
// A scenario's plan observation from its command record's admission, its plan
// document, and the approval records by `${lang}/${revision}`.
export const planObservation = (name, { record, planDoc }, approvals) => {
  const manifests = new Map(planStages(planDoc).map(m => [m.stage, m]));
  const stages = Object.entries(record?.admission?.stages ?? {})
    .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
    .map(([stage, admitted]) => ({
      stage,
      lang: admitted.lang,
      revision: admitted.revision,
      contractVersions: approvals[`${admitted.lang}/${admitted.revision}`]?.contractVersions ?? null,
      registryVersion: manifests.get(stage)?.registryVersion ?? null,
    }));
  return { name, stages, admitted: Boolean(record?.admission) && !record?.admissionRefusal };
};
// Execution tokens' scopes from Broker's `execute` audit records (broker.ts:
// `connectionId` from the token's `conn`, `itemId` from its `scp`), as Cloud
// Logging entries.
export const tokensFromAudit = entries => entries
  .map(e => e?.jsonPayload ?? {})
  .filter(r => r.event === "execute" && typeof r.fn === "string")
  .map(r => ({ fn: r.fn, scopeKinds: [...(r.itemId ? ["item"] : []), ...(r.connectionId ? ["connection"] : [])] }));
export const brokerAuditFilter = invocationId => [
  "resource.type=\"cloud_run_revision\"",
  "resource.labels.service_name=\"broker\"",
  "jsonPayload.logName=\"security_audit\"",
  `jsonPayload.invocationId="${invocationId}"`,
].join(" AND ");
// The public-capture quota from Policy's `command-reserve` audit records for
// one item: the distinct commands whose reservations were allowed as public
// captures, the refusals `rate-limited`, and whether the first refusal came
// after the quota's last allowed reservation (by the entries' times).
const timeOf = e => Date.parse(e?.timestamp ?? e?.jsonPayload?.at ?? "");
export const rateLimitFromAudit = entries => {
  const reserves = entries.filter(e => e?.jsonPayload?.event === "command-reserve");
  const allowed = reserves.filter(e => e.jsonPayload.outcome === "allowed" && e.jsonPayload.publicCapture === true);
  const refused = reserves.filter(e => e.jsonPayload.outcome === "denied" && e.jsonPayload.reason === "rate-limited");
  const lastAllowed = Math.max(...allowed.map(timeOf));
  const firstRefused = Math.min(...refused.map(timeOf));
  return {
    allowed: new Set(allowed.map(e => e.jsonPayload.commandId)).size,
    refused: refused.length,
    refusedAfterQuota: allowed.length > 0 && refused.length > 0 && Number.isFinite(lastAllowed) && Number.isFinite(firstRefused) && firstRefused >= lastAllowed,
  };
};
export const policyReserveFilter = (itemId, since) => [
  "resource.type=\"cloud_run_revision\"",
  "resource.labels.service_name=\"policy\"",
  "jsonPayload.logName=\"security_audit\"",
  "jsonPayload.event=\"command-reserve\"",
  `jsonPayload.itemId="${itemId}"`,
  `timestamp>="${since}"`,
].join(" AND ");

// Policy's due query, as the production api asks it and as a `scopes` worker
// does, over the gate's pending v3 fixtures and a v2 control
// (scripts/c5a-gate.js --phase due): which fixtures each query listed, and
// whether production's query listed the control.
export const dueObservation = ({ v3Fixtures, control, productionQueries, scopedQueries, productionLease }) => {
  const listed = queries => [...new Set(queries.flatMap(q => (q.commands ?? []).map(c => c.commandId)))];
  const production = listed(productionQueries);
  const scoped = listed(scopedQueries);
  return {
    v3Fixtures,
    control,
    productionListedV3: v3Fixtures.filter(id => production.includes(id)),
    scopedListedV3: v3Fixtures.filter(id => scoped.includes(id)),
    controlListedToProduction: production.includes(control),
    controlListedToScoped: scoped.includes(control),
    productionLease,
    queries: productionQueries.length + scopedQueries.length,
  };
};

// ------------------------------------------------------------------ checks

const has = v => v !== undefined && v !== null;

// Hermetic evidence (the gate amendment): a test run at the commit that is
// serving now, `{ service, commit, test, output, passed, ... }`, valid only
// when `commit` is `o.deployed[service]`.
export const hermeticProblem = (o, row) => {
  const h = o.hermetic?.[row];
  if (!h) return `no hermetic evidence for ${row}`;
  const deployed = o.deployed?.[h.service];
  if (!h.service || !deployed) return `${row}: the deployed ${h.service ?? "service"} commit wasn't observed`;
  if (h.commit !== deployed) return `${row}: tested at ${h.commit}, but ${h.service} serves ${deployed}`;
  if (typeof h.test !== "string" || !h.test || typeof h.output !== "string" || !h.output) return `${row}: the test or its output isn't recorded`;
  if (h.passed !== true) return `${row}: the test didn't pass`;
  return null;
};
// A live row with a hermetic fallback (the amendment): a live observation,
// when there is one, decides, and is never replaced. Without one, hermetic
// evidence that says why the case couldn't be induced live.
const liveOrFallback = (o, row, judge) => {
  const live = o[row];
  if (has(live)) return judge(live);
  const problem = hermeticProblem(o, row);
  if (problem) return `not observed live, and ${problem}`;
  if (typeof o.hermetic[row].uninducible !== "string" || !o.hermetic[row].uninducible) return `${row}: a fallback must say why the case couldn't be induced live`;
  return judge(o.hermetic[row].result ?? {});
};
const same = (a, b) => has(a) && has(b) && JSON.stringify(a) === JSON.stringify(b);
const versions = v => JSON.stringify([...(v ?? [])].sort((a, b) => a - b));

// Each check: [id, title, (o) => true | string (why not)].
export const CHECKS = [
  ["observations-read", "every observation was read: no read failed", o => {
    const failed = Object.entries(o.errors ?? {});
    return failed.length === 0 ? true : `reads failed: ${failed.map(([k, m]) => `${k} (${m})`).join("; ")}`;
  }],
  ["scenarios", "each scenario's plan has exactly its expected stages: private [L0013], composition [L0000 head, L0013], mixed [L0013, L0176]", o => {
    for (const [name, langs] of Object.entries(SCENARIOS)) {
      const plan = (o.plans ?? []).find(p => p.name === name);
      if (!plan) return `${name}: no plan observed`;
      const got = (plan.stages ?? []).map(st => st.lang);
      const ok = name === "mixed" ? same([...got].sort(), [...langs].sort()) : same(got, langs);
      if (!ok) return `${name}: stages ${JSON.stringify(got)}, expected ${JSON.stringify(langs)}`;
    }
    return true;
  }],
  ["l0176-unchanged", "L0176 is unchanged: the staged canary passes 36/36, the B6 repair round-trip passes, a v2 plan digest is identical, a v8 artifact is still served", o => {
    if (!o.canary || o.canary.checks !== 36 || o.canary.failed !== 0) return `canary ${o.canary ? `${o.canary.checks - o.canary.failed}/${o.canary.checks}` : "not observed"}`;
    if (o.repairRoundtrip?.passed !== true) return "the repair round-trip didn't pass";
    if (!same(o.v2PlanDigest?.before, o.v2PlanDigest?.after)) return "the v2 plan digest changed or wasn't read";
    if (o.v8Artifact?.served !== true) return "the v8 artifact wasn't served";
    return true;
  }],
  ["plans-pin-approved", "every plan pins approved revisions: l0013r at [3], l0000r and l0176r at [1, 2]", o => {
    if (!Array.isArray(o.plans) || o.plans.length === 0) return "no plans observed";
    const want = { "0013": "[3]", "0000": "[1,2]", "0176": "[1,2]" };
    const pinned = { "0013": o.approvals?.l0013r, "0000": o.approvals?.l0000r, "0176": o.approvals?.l0176r };
    const unnamed = Object.entries(pinned).filter(([, a]) => !a?.revision).map(([lang]) => `L${lang}`);
    if (unnamed.length) return `no approved revision named for ${unnamed.join(", ")}`;
    for (const plan of o.plans) {
      for (const st of plan.stages ?? []) {
        if (!want[st.lang]) continue;
        if (versions(st.contractVersions) !== want[st.lang]) return `${plan.name}: L${st.lang} pins contract ${versions(st.contractVersions)}`;
        if (!pinned[st.lang] || st.revision !== pinned[st.lang].revision) return `${plan.name}: L${st.lang} pins ${st.revision}, not the approved ${pinned[st.lang]?.revision}`;
      }
    }
    return true;
  }],
  ["private-owner", "a private item is captured by its owner, published in the gate bucket with its reserved sequence", o => {
    const p = o.privateOwner;
    if (p?.outcome !== "completed") return `owner's capture ${p?.outcome ?? "not observed"}`;
    if (p.published?.bucket !== (o.gateBucket ?? GATE_BUCKET)) return `published to ${p.published?.bucket}`;
    if (!has(p.reservedSequence) || p.published.captureSequence !== p.reservedSequence) return `published sequence ${p.published?.captureSequence} isn't the reserved ${p.reservedSequence}`;
    return true;
  }],
  ["private-non-owner", "a private item is refused for a non-owner, at admission and again at authorize-execution after access is narrowed", o => {
    if (o.privateNonOwner?.outcome !== "failed" || o.privateNonOwner?.reason !== "not-owner") return `non-owner ${o.privateNonOwner?.outcome ?? "not observed"} (${o.privateNonOwner?.reason})`;
    const narrowed = liveOrFallback(o, "narrowed", n => (n.reason === "not-owner" ? true : `after narrowing: ${n.reason ?? "not observed"}`));
    return narrowed;
  }],
  ["public-anonymous", "a public item is captured anonymously, rate-limited, and recorded as anonymous with publicCapture", o => {
    const p = o.publicAnonymous;
    if (p?.outcome !== "completed") return `anonymous capture ${p?.outcome ?? "not observed"}`;
    if (p.subject !== "anonymous" || p.publicCapture !== true) return `recorded as ${p.subject}, publicCapture ${p.publicCapture}`;
    // A fresh fixture: exactly the quota of distinct captures allowed, then
    // the quota's refusal.
    const q = p.rateLimit;
    if (!q || q.allowed !== PUBLIC_CAPTURE_LIMIT || !(q.refused >= 1) || q.refusedAfterQuota !== true) return `Policy's reservations for the public item: ${JSON.stringify(q ?? "not observed")}; expected ${PUBLIC_CAPTURE_LIMIT} allowed, then rate-limited`;
    return true;
  }],
  ["mixed-chain", "a capture plus an L0176 save is one v3 invocation, each execution token carrying only its own scope", o => {
    const m = o.mixed;
    if (m?.invocations !== 1) return `invocations: ${m?.invocations ?? "not observed"}`;
    const tokens = m.tokens ?? [];
    const snap = tokens.filter(t => t.fn === "snap");
    const save = tokens.filter(t => t.fn === "save-to-itembank");
    if (!snap.length || !save.length) return "both an item token and a connection token are needed";
    if (!snap.every(t => same(t.scopeKinds, ["item"])) || !save.every(t => same(t.scopeKinds, ["connection"]))) return "a token carried another stage's scope";
    return true;
  }],
  ["mismatches", "credential-scope-mismatch holds both ways (hermetic: Broker's test at the deployed commit)", o => {
    const problem = hermeticProblem(o, "mismatches");
    if (problem) return problem;
    const reasons = Object.fromEntries((o.hermetic.mismatches.results ?? []).map(m => [m.direction, m.reason]));
    for (const d of ["service-with-connection", "connection-with-item"]) if (reasons[d] !== "credential-scope-mismatch") return `${d}: ${reasons[d] ?? "not observed"}`;
    return true;
  }],
  ["composition", "an L0000 head over an L0013 capture of the private item runs as a connectionless v3 command, its item scope authorized", o => {
    const c = o.composition;
    if (c?.outcome !== "completed") return `composition ${c?.outcome ?? "not observed"}`;
    if (c.connectionId !== null || c.contractVersion !== 3 || c.itemScopeAuthorized !== true) return `connection ${c.connectionId}, contract ${c.contractVersion}, item scope ${c.itemScopeAuthorized}`;
    return true;
  }],
  ["per-stage-contracts", "mixed and composed plans pin [1, 2] for L0176 and L0000 and are admitted; a pre-slice-6 l0013r is refused; earlier approval records are byte-identical", o => {
    for (const name of ["mixed", "composition"]) {
      const plan = (o.plans ?? []).find(p => p.name === name);
      if (!plan?.admitted) return `${name} plan ${plan ? "not admitted" : "not observed"}`;
      if (plan.stages.some(st => (st.lang === "0176" || st.lang === "0000") && versions(st.contractVersions) !== "[1,2]")) return `${name}: an L0176 or L0000 stage isn't at [1, 2]`;
    }
    // Hermetic: Policy's admission test at the deployed commit, with an
    // approved l0013r fixture at [1, 2] (an unapproved one tests another
    // refusal).
    const pre = hermeticProblem(o, "preSlice6");
    if (pre) return pre;
    const fixture = o.hermetic.preSlice6.fixture ?? {};
    if (fixture.lang !== "0013" || fixture.approved !== true || versions(fixture.contractVersions) !== "[1,2]") return `pre-slice-6 fixture ${JSON.stringify(fixture)}: an approved l0013r at [1, 2] is needed`;
    if (o.hermetic.preSlice6.result?.reason !== "contract-version-unsupported") return `pre-slice-6 plan: ${o.hermetic.preSlice6.result?.reason ?? "not observed"}`;
    if (!same(o.approvals?.beforeDigest, o.approvals?.afterDigest)) return "earlier approval records changed or weren't read";
    return true;
  }],
  ["registry-versions", "manifests report l0000r 0 and l0176r and l0013r 9; the canary's L0185 is 0 beside L0176 at 9", o => {
    const want = { "0000": 0, "0176": 9, "0013": 9 };
    const seen = (o.plans ?? []).flatMap(p => p.stages ?? []).filter(st => has(want[st.lang]));
    const missing = Object.keys(want).filter(lang => !seen.some(st => st.lang === lang));
    if (missing.length) return `no manifest observed for ${missing.map(l => `L${l}`).join(", ")}`;
    const wrong = seen.find(st => st.registryVersion !== want[st.lang]);
    if (wrong) return `L${wrong.lang} reported ${wrong.registryVersion}`;
    if (o.canary?.l0185RegistryVersion !== 0 || o.canary?.l0176RegistryVersion !== 9) return `canary: L0185 ${o.canary?.l0185RegistryVersion}, L0176 ${o.canary?.l0176RegistryVersion}`;
    return true;
  }],
  ["conditional-retry", "with the older capture published first, the newer's audit shows two execute-step attempts with distinct decision ids, and the object ends on the newer capture", o => {
    return liveOrFallback(o, "conditional", c => {
      const ids = (c?.attempts ?? []).map(a => a.decisionId);
      if (ids.length !== 2 || new Set(ids).size !== 2 || ids.some(id => !id)) return `attempts: ${JSON.stringify(ids)}`;
      if (!has(c.newerSequence) || c.finalSequence !== c.newerSequence) return `ended on ${c.finalSequence}, newer is ${c.newerSequence}`;
      return true;
    });
  }],
  ["reserve-stage-bind", "reserve, stage and bind run in order; repeats return the recorded state; the published object carries the reserved sequence; an out-of-order pair ends on the newer", o => {
    return liveOrFallback(o, "reserveStageBind", r => {
      if (!same(r?.order, ["reserve", "stage", "bind"])) return `order ${JSON.stringify(r?.order)}`;
      if (r.repeatReserveSame !== true || r.repeatStageSame !== true) return "a repeat changed the recorded state";
      if (!has(r.reservedSequence) || r.publishedSequence !== r.reservedSequence) return `published ${r.publishedSequence}, reserved ${r.reservedSequence}`;
      if (!has(r.outOfOrderNewer) || r.outOfOrderFinal !== r.outOfOrderNewer) return `out-of-order pair ended on ${r.outOfOrderFinal}`;
      return true;
    });
  }],
  ["nothing-elsewhere", "graffiticode.appspot.com's thumbnails are unchanged, and graffiticode-thumbnails gets nothing", o => {
    const e = o.elsewhere;
    if (!same(e?.appspotBefore, e?.appspotAfter)) return "the appspot thumbnails listing changed or wasn't read";
    if (e.thumbnailsObjects !== 0) return `graffiticode-thumbnails holds ${e.thumbnailsObjects}`;
    return true;
  }],
  ["old-workers", "Policy's due query, as production asks it, lists none of the gate's pending v3 commands but does list a v2 control; as a scopes worker asks it, lists them all; and production's lease of one is refused", o => {
    const w = o.oldWorkers;
    if (!w || !Array.isArray(w.v3Fixtures) || w.v3Fixtures.length === 0) return "no pending v3 fixture observed";
    if (w.productionListedV3?.length !== 0) return `production's due query listed ${JSON.stringify(w.productionListedV3)}`;
    if (w.controlListedToProduction !== true) return "production's due query never listed the v2 control, so it proves nothing";
    // A scopes worker owns v2 commands too: its query must list the control.
    if (w.controlListedToScoped !== true) return "a scopes worker's due query never listed the v2 control";
    if (!same([...w.scopedListedV3 ?? []].sort(), [...w.v3Fixtures].sort())) return `a scopes worker's due query listed ${JSON.stringify(w.scopedListedV3)} of ${JSON.stringify(w.v3Fixtures)}`;
    if (w.productionLease !== "worker-unsupported") return `production's lease of a v3 fixture: ${w.productionLease ?? "not observed"}`;
    return true;
  }],
  ["fixtures-retired", "the due phase's never-run fixtures are retired: none pending, none listed by any due query", o => {
    const w = o.oldWorkers;
    const c = o.fixtureCleanup;
    if (!c || !Array.isArray(c.fixtures)) return "the fixtures' retirement wasn't observed";
    const expected = [...(w?.v3Fixtures ?? []), ...(w?.control ? [w.control] : [])];
    if (!expected.length) return "no fixture ids observed";
    const unchecked = expected.filter(id => !c.fixtures.includes(id));
    if (unchecked.length) return `not checked: ${JSON.stringify(unchecked)}`;
    const pending = expected.filter(id => !c.statuses?.[id] || c.statuses[id] === "pending");
    if (pending.length) return `still pending: ${JSON.stringify(pending)}`;
    if ((c.listedAfter ?? []).length) return `still listed as due: ${JSON.stringify(c.listedAfter)}`;
    return true;
  }],
  ["console-route", "the console route refuses any caller but policy-run", o => {
    const probes = o.consoleRoute ?? [];
    const ok = probes.find(p => p.caller === POLICY_RUN);
    const others = probes.filter(p => p.caller !== POLICY_RUN);
    if (ok?.status !== 200) return `policy-run answered ${ok?.status ?? "not observed"}`;
    if (!others.length || others.some(p => p.status !== 403)) return `others: ${JSON.stringify(others.map(p => [p.caller, p.status]))}`;
    return true;
  }],
  ["proxy", "the proxy lets l0013r reach Policy and Broker and nothing else new", o => {
    if (o.proxy?.verifyRollout !== true) return "verify-rollout not ok";
    if (!["passed", "step26-exception"].includes(o.proxy?.at11)) return `AT-11: ${o.proxy?.at11 ?? "not observed"}`;
    return true;
  }],
];

export const verdict = observations => {
  const o = observations ?? {};
  const checks = CHECKS.map(([id, title, check]) => {
    let result;
    try {
      result = check(o);
    } catch (e) {
      result = `not observed (${e?.message ?? e})`;
    }
    return { id, title, ok: result === true, detail: result === true ? "ok" : result };
  });
  return { passed: checks.every(c => c.ok), checks };
};
