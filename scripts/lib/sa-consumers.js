// Key retirement checklist, step 4 (docs/capability-policy-iam-review.md,
// Step 11): check a service account for remaining consumers, and record what
// was covered. Read-only. Entry point: scripts/sa-consumers.js.
//
// Every check reports one status:
//   PASS        the check ran completely and found nothing
//   FOUND       it found a consumer, or a principal able to act as the account
//   INCOMPLETE  it couldn't establish the answer: a command failed (including
//               an API that's disabled, which isn't an empty inventory), a
//               response wasn't fully explored, or the evidence is ambiguous
//   ACCEPTED    INCOMPLETE, accepted by the operator with a recorded reason
// The verdict passes only if every check is PASS or ACCEPTED. Nothing is ever
// read as "none" because a command failed.
//
// `gcloud(args)` runs one gcloud command and resolves { code, stdout, stderr };
// it never throws. Everything else is pure, for the tests
// (scripts/test/sa-consumers.test.js).

const json = out => {
  try {
    return { value: JSON.parse(out.stdout || "null") };
  } catch (e) {
    return { error: `unparseable output: ${e.message}` };
  }
};
const firstLine = s => String(s ?? "").trim().split("\n").find(l => l.trim()) ?? "";
const failure = (out, what) => `${what}: exit ${out.code}${out.stderr ? `: ${firstLine(out.stderr)}` : ""}`;

// Runs gcloud expecting JSON; returns { value } or { incomplete: reason }.
const query = async (gcloud, args, what) => {
  const out = await gcloud([...args, "--format=json"]);
  if (out.code !== 0) return { incomplete: failure(out, what) };
  const parsed = json(out);
  if (parsed.error) return { incomplete: `${what}: ${parsed.error}` };
  return { value: parsed.value ?? [] };
};

const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

// One check over a list of (possibly regional) queries: FOUND if any item runs
// as the account, INCOMPLETE if any query failed, else PASS.
const scan = async (gcloud, { name, queries, identities }, account) => {
  const found = [];
  const incomplete = [];
  let scanned = 0;
  for (const q of queries) {
    const r = await query(gcloud, q.args, q.what);
    if (r.incomplete) {
      incomplete.push(r.incomplete);
      continue;
    }
    for (const item of r.value) {
      scanned += 1;
      for (const id of identities(item)) {
        if (same(id.account, account)) found.push(id.label);
      }
    }
  }
  return {
    check: name,
    status: found.length ? "FOUND" : incomplete.length ? "INCOMPLETE" : "PASS",
    scanned,
    ...(found.length ? { found } : {}),
    ...(incomplete.length ? { incomplete } : {}),
  };
};

// Regions to enumerate, from a listing command. Returns { regions } or
// { incomplete }.
const regionsFrom = async (gcloud, args, field, what) => {
  const r = await query(gcloud, args, what);
  if (r.incomplete) return r;
  const regions = r.value.map(x => x?.[field]).filter(Boolean);
  return regions.length ? { regions } : { incomplete: `${what}: no regions listed` };
};

// Cloud Run: every REACHABLE revision of every service (serving, or kept by a
// tag), read from the revision itself: the service template only says what
// the next revision will run as.
const cloudRunRevisions = async (gcloud, account) => {
  const services = await query(gcloud, ["run", "services", "list"], "run services list");
  if (services.incomplete) return { check: "cloud-run-revisions", status: "INCOMPLETE", scanned: 0, incomplete: [services.incomplete] };
  const queries = [];
  for (const s of services.value) {
    const region = s.metadata?.labels?.["cloud.googleapis.com/location"];
    const reachable = new Set((s.status?.traffic ?? []).map(t => t.revisionName ?? (t.latestRevision ? s.status?.latestReadyRevisionName : null)).filter(Boolean));
    for (const rev of reachable) {
      queries.push({ args: ["run", "revisions", "describe", rev, `--region=${region}`], what: `run revisions describe ${rev}`, label: `${s.metadata?.name}/${rev}` });
    }
  }
  const found = [];
  const incomplete = [];
  for (const q of queries) {
    const r = await query(gcloud, q.args, q.what);
    if (r.incomplete) incomplete.push(r.incomplete);
    else if (same(r.value?.spec?.serviceAccountName, account)) found.push(q.label);
  }
  return {
    check: "cloud-run-revisions",
    status: found.length ? "FOUND" : incomplete.length ? "INCOMPLETE" : "PASS",
    scanned: queries.length,
    ...(found.length ? { found } : {}),
    ...(incomplete.length ? { incomplete } : {}),
  };
};

// A regional listing: enumerate the regions, then list in each.
const regional = async (gcloud, account, { name, regionArgs, regionField, regionWhat, listArgs, identities }) => {
  const r = await regionsFrom(gcloud, regionArgs, regionField, regionWhat);
  if (r.incomplete) return { check: name, status: "INCOMPLETE", scanned: 0, incomplete: [r.incomplete] };
  return scan(gcloud, { name, identities, queries: r.regions.map(region => ({ args: listArgs(region), what: `${name} in ${region}` })) }, account);
};

export const workloadChecks = (gcloud, account) => [
  () => cloudRunRevisions(gcloud, account),
  () => regional(gcloud, account, {
    name: "cloud-run-jobs",
    regionArgs: ["run", "regions", "list"],
    regionField: "locationId",
    regionWhat: "run regions list",
    listArgs: region => ["run", "jobs", "list", `--region=${region}`],
    identities: j => [{ account: j.spec?.template?.spec?.template?.spec?.serviceAccountName, label: j.metadata?.name }],
  }),
  () => scan(gcloud, {
    name: "cloud-functions",
    queries: [{ args: ["functions", "list", "--regions=-"], what: "functions list" }],
    identities: f => [{ account: f.serviceConfig?.serviceAccountEmail ?? f.serviceAccountEmail, label: f.name }],
  }, account),
  () => appEngine(gcloud, account),
  () => scan(gcloud, {
    name: "compute-instances",
    queries: [{ args: ["compute", "instances", "list"], what: "compute instances list" }],
    identities: i => (i.serviceAccounts ?? []).map(sa => ({ account: sa.email, label: i.name })),
  }, account),
  async () => {
    const r = await regionsFrom(gcloud, ["compute", "regions", "list"], "name", "compute regions list");
    if (r.incomplete) return { check: "cloud-build-triggers", status: "INCOMPLETE", scanned: 0, incomplete: [r.incomplete] };
    return scan(gcloud, {
      name: "cloud-build-triggers",
      queries: ["global", ...r.regions].map(region => ({ args: ["builds", "triggers", "list", `--region=${region}`], what: `builds triggers list in ${region}` })),
      identities: t => [{ account: String(t.serviceAccount ?? "").split("/").pop(), label: t.name ?? t.id }],
    }, account);
  },
  () => regional(gcloud, account, {
    name: "cloud-scheduler-jobs",
    regionArgs: ["scheduler", "locations", "list"],
    regionField: "locationId",
    regionWhat: "scheduler locations list",
    listArgs: region => ["scheduler", "jobs", "list", `--location=${region}`],
    identities: j => [j.httpTarget?.oidcToken?.serviceAccountEmail, j.httpTarget?.oauthToken?.serviceAccountEmail].map(a => ({ account: a, label: j.name })),
  }),
  () => regional(gcloud, account, {
    name: "eventarc-triggers",
    regionArgs: ["eventarc", "locations", "list"],
    regionField: "locationId",
    regionWhat: "eventarc locations list",
    listArgs: region => ["eventarc", "triggers", "list", `--location=${region}`],
    identities: t => [{ account: t.serviceAccount, label: t.name }],
  }),
  () => scan(gcloud, {
    name: "pubsub-push-subscriptions",
    queries: [{ args: ["pubsub", "subscriptions", "list"], what: "pubsub subscriptions list" }],
    identities: s => [{ account: s.pushConfig?.oidcToken?.serviceAccountEmail, label: s.name }],
  }, account),
];

// App Engine: a project with no App Engine application has no versions; that,
// and only that, is a PASS without a listing.
const appEngine = async (gcloud, account) => {
  const app = await gcloud(["app", "describe", "--format=json"]);
  if (app.code !== 0) {
    if (/does not contain an App Engine application/i.test(app.stderr)) return { check: "app-engine-versions", status: "PASS", scanned: 0, note: "the project has no App Engine application" };
    return { check: "app-engine-versions", status: "INCOMPLETE", scanned: 0, incomplete: [failure(app, "app describe")] };
  }
  return scan(gcloud, {
    name: "app-engine-versions",
    queries: [{ args: ["app", "versions", "list"], what: "app versions list" }],
    // `gcloud app versions list` wraps the version resource: { id, service, version: {...} }.
    identities: v => [{ account: v.version?.serviceAccount ?? v.serviceAccount, label: `${v.service}/${v.id}` }],
  }, account);
};

// Supplementary only: Asset Inventory text search covers selected metadata,
// not every field, so it never decides a verdict.
export const assetSearch = async (gcloud, account, project) => {
  const r = await query(gcloud, ["asset", "search-all-resources", `--scope=projects/${project}`, `--query=${account}`], "asset search-all-resources");
  return {
    check: "asset-search (supplementary)",
    status: "SUPPLEMENTARY",
    ...(r.incomplete ? { incomplete: [r.incomplete] } : { resources: r.value.map(x => `${x.assetType} ${x.name}`) }),
  };
};

// Who can act as the account: the full Analyzer response, kept as evidence,
// and complete only if fully explored with no errors, no unexpanded groups and
// no conditional bindings. Any identity outside `allowed` (the operators, and
// the account itself) is FOUND.
export const IMPERSONATION_PERMISSIONS = [
  "iam.serviceAccounts.actAs",
  "iam.serviceAccounts.getAccessToken",
  "iam.serviceAccounts.signJwt",
  "iam.serviceAccounts.signBlob",
  "iam.serviceAccounts.getOpenIdToken",
  "iam.serviceAccounts.implicitDelegation",
];
export const analyzeImpersonation = (response, { allowed }) => {
  const problems = [];
  const analyses = [
    ...(response?.mainAnalysis ? [["main", response.mainAnalysis]] : []),
    ...(response?.serviceAccountImpersonationAnalysis ?? []).map((a, i) => [`impersonation ${i}`, a]),
  ];
  if (!response?.mainAnalysis) problems.push("no main analysis in the response");
  if (response?.fullyExplored !== true) problems.push("the response is not fully explored");
  const found = new Map();
  for (const [label, a] of analyses) {
    if (a.fullyExplored !== true) problems.push(`${label}: not fully explored`);
    for (const e of a.nonCriticalErrors ?? []) problems.push(`${label}: ${e.cause ?? JSON.stringify(e)}`);
    for (const r of a.analysisResults ?? []) {
      if (r.fullyExplored === false) problems.push(`${label}: a result is not fully explored (${r.iamBinding?.role})`);
      for (const acl of r.accessControlLists ?? []) {
        if (acl.conditionEvaluation?.evaluationValue === "CONDITIONAL") problems.push(`${label}: a conditional binding (${r.iamBinding?.role}) can't be evaluated`);
      }
      for (const id of r.identityList?.identities ?? []) {
        if (/^group:/i.test(id.name)) problems.push(`${label}: group ${id.name} not expanded`);
        if (!allowed.some(a => same(a, id.name))) {
          const via = found.get(id.name) ?? new Set();
          via.add(`${r.iamBinding?.role} on ${r.attachedResourceFullName}${label === "main" ? "" : " (indirect)"}`);
          found.set(id.name, via);
        }
      }
    }
  }
  const foundList = [...found].map(([identity, via]) => ({ identity, via: [...via] }));
  return {
    check: "who-can-act-as-it",
    status: foundList.length ? "FOUND" : problems.length ? "INCOMPLETE" : "PASS",
    ...(foundList.length ? { found: foundList } : {}),
    ...(problems.length ? { incomplete: problems } : {}),
  };
};

// Its authentications since the key was disabled. Disabling a key doesn't
// revoke short-lived credentials already issued with it (up to an hour), so
// activity with the key in that hour is told apart from later activity.
// Policy Analyzer reports by day only: a last authentication on the day of
// the disable can't be ordered against it.
export const SHORT_LIVED_MS = 60 * 60 * 1000;
// An audit entry for a call that succeeded: no error status, not an ERROR.
const succeeded = e => !(e?.protoPayload?.status?.code) && e?.severity !== "ERROR";

// The observation window starts at the key's FIRST successful disable in the
// lookback: a failed attempt never moves it, and a later re-enable is reported,
// since the key was usable again in between.
export const disableWindow = keyEvents => {
  const ok = (keyEvents ?? []).filter(succeeded).sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  const disables = ok.filter(e => /DisableServiceAccountKey$/.test(e.protoPayload?.methodName ?? ""));
  if (!disables.length) return { disabledAt: null };
  const disabledAt = disables[0].timestamp;
  const reenabled = ok.filter(e => /EnableServiceAccountKey$/.test(e.protoPayload?.methodName ?? "") && !/Disable/.test(e.protoPayload?.methodName) && e.timestamp > disabledAt).map(e => e.timestamp);
  const failed = (keyEvents ?? []).filter(e => !succeeded(e)).map(e => `${e.timestamp} ${e.protoPayload?.methodName} failed`);
  return { disabledAt, reenabled, failed };
};

// How an audit entry reached the account. Credential minting (iamcredentials)
// names the requester as the principal and the account as the resource.
const how = (e, account, keyId) => {
  const p = e.protoPayload ?? {};
  if (p.serviceName === "iamcredentials.googleapis.com" && !same(p.authenticationInfo?.principalEmail, account)) {
    return `a credential for it minted by ${p.authenticationInfo?.principalEmail ?? "an unknown principal"}`;
  }
  const keyName = p.authenticationInfo?.serviceAccountKeyName ?? "";
  if (keyId && keyName.includes(keyId)) return "the key";
  if (/keys\//.test(keyName)) return "another key";
  return "credential source unknown (the entry names no key; some services omit it)";
};

// `disableIncomplete`: why the disable time couldn't be read, if the read failed.
export const authentications = ({ disabledAt, disableIncomplete = null, reenabled = [], entries, analyzer, account = null, keyId = null }) => {
  const results = [];
  const disabled = disabledAt ? Date.parse(disabledAt) : NaN;
  if (Number.isNaN(disabled)) {
    results.push({ check: "key-disable-time", status: "INCOMPLETE", incomplete: [disableIncomplete ?? "the key's disable time wasn't found in the audit logs"] });
  } else if (reenabled.length) {
    results.push({ check: "key-disable-time", status: "FOUND", disabledAt, found: reenabled.map(t => `the key was re-enabled at ${t}`) });
  } else {
    results.push({ check: "key-disable-time", status: "PASS", disabledAt });
  }
  // Audit log entries made as the account since the disable.
  if (entries.incomplete) {
    results.push({ check: "audit-log-activity", status: "INCOMPLETE", incomplete: [entries.incomplete] });
  } else {
    const after = entries.value.filter(e => !Number.isNaN(disabled) && Date.parse(e.timestamp) >= disabled);
    const classify = e => {
      const via = how(e, account, keyId);
      const within = Date.parse(e.timestamp) - disabled <= SHORT_LIVED_MS;
      const detail = via === "the key" ? (within ? "a credential issued with the key before it was disabled" : "the key, after its credentials expired") : via;
      return `${e.timestamp} ${e.protoPayload?.serviceName} ${e.protoPayload?.methodName}: ${detail}`;
    };
    results.push({
      check: "audit-log-activity",
      status: Number.isNaN(disabled) ? "INCOMPLETE" : after.length ? "FOUND" : "PASS",
      ...(after.length ? { found: after.map(classify) } : {}),
      limits: "Admin Activity logs only: Data Access logging (Firestore and Auth reads, and iamcredentials token minting) is off, so an empty result doesn't rule those out",
    });
  }
  // Policy Analyzer's last authentications (by day).
  for (const a of analyzer) {
    if (a.incomplete) {
      results.push({ check: a.check, status: "INCOMPLETE", incomplete: [a.incomplete] });
      continue;
    }
    if (!a.last) {
      results.push({ check: a.check, status: "PASS", note: "no authentication in Policy Analyzer's observation period" });
      continue;
    }
    const day = a.last.slice(0, 10);
    const disableDay = Number.isNaN(disabled) ? null : new Date(disabled).toISOString().slice(0, 10);
    const status = !disableDay ? "INCOMPLETE" : day < disableDay ? "PASS" : day === disableDay ? "INCOMPLETE" : "FOUND";
    results.push({
      check: a.check,
      status,
      lastAuthenticated: a.last,
      ...(status === "INCOMPLETE" && disableDay ? { incomplete: [`last authenticated ${day}, the day the key was disabled: reported by day, so it can't be ordered against the disable; re-check after it ages out or accept it`] } : {}),
      ...(status === "FOUND" ? { found: [`authenticated ${day}, after the key was disabled (${disableDay})`] } : {}),
    });
  }
  return results;
};

// The verdict: PASS only if every deciding check is PASS or ACCEPTED.
// `accept` maps a check name to the operator's reason for accepting it
// INCOMPLETE; it never turns a FOUND into anything else.
export const verdict = (results, accept = {}) => {
  const checks = results.map(r => (r.status === "INCOMPLETE" && accept[r.check] ? { ...r, status: "ACCEPTED", acceptedBecause: accept[r.check] } : r));
  const deciding = checks.filter(r => r.status !== "SUPPLEMENTARY");
  const status = deciding.some(r => r.status === "FOUND") ? "FOUND" : deciding.every(r => r.status === "PASS" || r.status === "ACCEPTED") ? "PASS" : "INCOMPLETE";
  const unused = Object.keys(accept).filter(k => !results.some(r => r.check === k && r.status === "INCOMPLETE"));
  return { status, checks, ...(unused.length ? { unusedAcceptances: unused } : {}) };
};

// What the workload checks don't cover, recorded with the evidence.
export const NOT_COVERED = [
  "Workflows, Cloud Tasks, Dataflow, Vertex AI and GKE workload identity",
  "resources in other projects that run as, or can impersonate, this account",
  "Cloud Run revisions that serve no traffic and carry no tag (unreachable until traffic is moved to them)",
  "short-lived credentials minted from the account before the checks, and anything Data Access logs would show",
];
