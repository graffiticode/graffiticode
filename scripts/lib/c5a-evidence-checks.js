// The C5a gate's L0176 compatibility evidence (docs/c5-l0013-commands-plan.md,
// "C5a completion gate": "L0176 is unchanged"), as pure functions over what
// the producers in scripts/c5a-evidence/ read, so each verdict is tested
// offline (scripts/test/c5a-evidence-checks.test.js). Nothing here reads a
// service. The owner's review of r36074e set what each row must show:
//
//   v2 plan digest   pre-C5a and current plan construction over identical
//                    recorded inputs (invocation, revisions, registry fields):
//                    both admit, both construct exactly the recorded plan and
//                    digest. Different admissions prove nothing.
//   v8 artifact      an artifact demonstrably created by a registry-8 api, read
//                    through today's api: served, its bindings and content
//                    unchanged, and no provider dispatch.
//   registry versions  the canary command's stored plan: command id, digest,
//                    pinned revisions and manifest versions.

const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(n => [n, x[n]])) : x));

// ------------------------------------------------------------ v2 plan digest

// One recorded plan, constructed at both commits (scripts/c5a-evidence/
// v2-construct.mjs): { recorded: { digest, plan, invocationId }, before, after }
// where before/after are { admitted, planDigest, plan, recomputed, invocationId, refusal? }.
export const v2DigestProblems = cases => {
  if (!Array.isArray(cases) || cases.length === 0) return ["no recorded plan was constructed"];
  const problems = [];
  for (const { recorded, before, after } of cases) {
    const name = recorded?.digest?.slice(0, 12) ?? "?";
    for (const [side, r] of [["before", before], ["after", after]]) {
      if (!r) { problems.push(`${name}: not constructed ${side}`); continue; }
      if (r.admitted !== true) { problems.push(`${name}: refused ${side} (${r.refusal ?? "no reason"})`); continue; }
      if (r.invocationId !== recorded.invocationId) problems.push(`${name}: ${side} used invocation ${r.invocationId}, not the recorded ${recorded.invocationId}`);
      if (r.planDigest !== recorded.digest) problems.push(`${name}: ${side} constructed ${r.planDigest}`);
      if (r.recomputed !== r.planDigest) problems.push(`${name}: ${side}'s stored plan digests to ${r.recomputed}`);
      if (canon(r.plan) !== canon(recorded.plan)) problems.push(`${name}: ${side}'s plan differs from the recorded plan`);
    }
    if (before?.planDigest && after?.planDigest && before.planDigest !== after.planDigest) problems.push(`${name}: before ${before.planDigest} and after ${after.planDigest} differ`);
  }
  return problems;
};

// ---------------------------------------------------------------- v8 artifact

// What makes an artifact a registry-8 api's (scripts/c5a-evidence/v8-provenance.mjs):
//   provenance { artifact: { registryVersion, createdAt, contentDigest, recomputedDigest, invocationId, ... },
//                head: { invocationId }, plan: { registryVersion, stages } }
//   apiWindows [{ revision, registryVersion, from, until }]: each api revision's
//                serving window (release receipts and the revision list), with
//                the REGISTRY_VERSION of its commit
export const v8ProvenanceProblems = ({ provenance, apiWindows }) => {
  const problems = [];
  const a = provenance?.artifact;
  if (!a) return ["the artifact wasn't read"];
  if (a.registryVersion !== 8) problems.push(`the artifact binds registry ${a.registryVersion}`);
  if (!a.contentDigest || a.recomputedDigest !== a.contentDigest) problems.push("its content doesn't digest to its recorded contentDigest");
  if (provenance.head?.invocationId !== a.invocationId) problems.push("its head names another invocation, so a view wouldn't serve it");
  if (provenance.plan?.registryVersion !== 8) problems.push(`its plan is registry ${provenance.plan?.registryVersion ?? "not read"}`);
  const serving = (apiWindows ?? []).filter(w => w.from <= a.createdAt && (!w.until || a.createdAt < w.until));
  if (serving.length !== 1) problems.push(`${serving.length} api revisions were serving at ${a.createdAt}`);
  else if (serving[0].registryVersion !== 8) problems.push(`${serving[0].revision} (registry ${serving[0].registryVersion}) was serving at ${a.createdAt}`);
  return problems;
};

// The live read through today's api (scripts/c5a-evidence/v8-read.mjs):
//   before, after   the artifact and its head, read just before and after
//                   ({ binding, contentDigest, updateTime, head })
//   stored          the artifact's stored envelope ({ data: activity, errors })
//   served          { status, body } of GET /data through today's api
//   readInvocationId  the view's own read invocation (Policy's
//                   idempotency-keys record for read.<artifact invocation>)
//   broker          { entries, complete, truncated }: Broker security_audit
//                   from the read's start, polled until the read invocation's
//                   signing evidence arrived (complete) and never cut off by a
//                   read limit (truncated) ({ invocationId, connectionId, opid,
//                   op, event, purpose, outcome })
// The view re-signs an L0176 activity per render (a read invocation and a
// preview signature: Broker sign steps), so the served activity may carry
// fields the stored one doesn't (recorded as `added`); its type and item data
// must be exactly the stored ones. The #421 review: an empty or late audit
// never passes; the read's signing must be seen, and nothing dispatched.
export const SIGN_PREVIEW = /^learnosity\.sign-[a-z]+-preview$/;
export const v8ReadProblems = ({ before, after, stored, served, readInvocationId, broker }) => {
  const problems = [];
  if (!before || !after) return ["the artifact wasn't read before and after"];
  if (canon(before.binding) !== canon(after.binding)) problems.push("its bindings changed");
  if (before.contentDigest !== after.contentDigest) problems.push("its content digest changed");
  if (before.updateTime !== after.updateTime) problems.push("the artifact document was rewritten");
  if (before.head?.invocationId !== after.head?.invocationId || before.head?.invocationId !== before.binding?.invocationId) problems.push("its head moved");
  if (served?.status !== 200) problems.push(`GET /data answered ${served?.status ?? "nothing"}`);
  const envelope = served?.body?.data;
  if (!envelope || (envelope.errors ?? []).length) problems.push(`the view answered errors ${JSON.stringify(envelope?.errors?.map(e => e.code) ?? null)}`);
  const activity = envelope?.data;
  const storedActivity = stored?.data;
  if (!storedActivity) problems.push("the stored activity wasn't read");
  else if (!activity || activity.type !== storedActivity.type || canon(activity.data) !== canon(storedActivity.data)) problems.push("the served activity isn't the stored one");
  if (!readInvocationId) problems.push("the view's read invocation wasn't found");
  if (!broker || !Array.isArray(broker.entries)) return [...problems, "Broker's audit wasn't read"];
  if (broker.truncated !== false) problems.push("Broker's audit collection may be truncated");
  if (broker.complete !== true) problems.push("the read's signing evidence never arrived");
  const entries = broker.entries;
  const dispatched = entries.filter(e => e.event === "execute-step" && e.purpose === "dispatch" && (e.connectionId === before.binding?.connectionId || e.invocationId === readInvocationId));
  if (dispatched.length) problems.push(`Broker dispatched ${JSON.stringify(dispatched.map(e => `${e.op}:${e.step}`))}`);
  const original = entries.filter(e => e.invocationId === before.binding?.invocationId);
  if (original.length) problems.push(`Broker recorded ${original.length} record(s) under the artifact's own invocation`);
  if (readInvocationId) {
    const read = entries.filter(e => e.invocationId === readInvocationId);
    const signs = read.filter(e => e.event === "execute-step" && e.purpose === "sign" && e.outcome === "allowed" && SIGN_PREVIEW.test(e.op ?? ""));
    const executes = read.filter(e => e.event === "execute" && e.outcome === "allowed" && SIGN_PREVIEW.test(e.op ?? ""));
    if (!signs.length || !executes.length) problems.push(`the read invocation's preview signing wasn't recorded (${signs.length} sign step(s), ${executes.length} execute(s))`);
    const other = read.filter(e => !SIGN_PREVIEW.test(e.op ?? "") || (e.event === "execute-step" && e.purpose !== "sign"));
    if (other.length) problems.push(`the read invocation recorded other operations ${JSON.stringify(other.map(e => `${e.op}:${e.event}:${e.purpose ?? ""}`))}`);
  }
  return problems;
};
// The read's signing evidence has arrived: a sign step and its execute.
export const readSigningSeen = (entries, readInvocationId) => {
  const read = (entries ?? []).filter(e => e.invocationId === readInvocationId && SIGN_PREVIEW.test(e.op ?? "") && e.outcome === "allowed");
  return read.some(e => e.event === "execute-step" && e.purpose === "sign") && read.some(e => e.event === "execute");
};
export const addedFields = (stored, served) => Object.keys(served?.body?.data?.data ?? {}).filter(k => !(k in (stored?.data ?? {})));

// ---------------------------------------------------------- registry versions

// The canary's L0185 -> L0176 command and its stored plan: the gate's
// canary.l0185RegistryVersion and canary.l0176RegistryVersion.
//   command { commandId, admission: { planDigest } }, planDoc { plan, revisions }, digest = planDigest(planDoc.plan)
export const registryVersionsObservation = ({ command, planDoc, digest }) => {
  const problems = [];
  const planDigest = command?.admission?.planDigest ?? null;
  if (!planDigest) problems.push("the command has no admitted plan");
  if (!planDoc?.plan) problems.push("the plan wasn't read");
  if (planDigest && digest !== planDigest) problems.push(`the stored plan digests to ${digest}, not ${planDigest}`);
  const stages = (planDoc?.plan?.stages ?? []).map(s => ({ stage: s.stage, lang: s.lang, revision: s.revision, imageDigest: s.imageDigest, registryVersion: s.registryVersion }));
  const of = lang => {
    const found = stages.filter(s => s.lang === lang);
    if (found.length !== 1) problems.push(`${found.length} L${lang} stages`);
    return found[0]?.registryVersion ?? null;
  };
  const l0185 = of("0185");
  const l0176 = of("0176");
  return { commandId: command?.commandId ?? null, planDigest, digestVerified: Boolean(planDigest) && digest === planDigest, revisions: planDoc?.revisions ?? null, stages, l0185RegistryVersion: l0185, l0176RegistryVersion: l0176, problems };
};
