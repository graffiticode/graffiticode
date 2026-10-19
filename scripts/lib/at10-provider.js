/* eslint-disable camelcase -- Learnosity wire fields are snake_case */
// The AT-10 provider harness (plan: ~/.claude/plans/at10-provider.md, step 2,
// "What the harness measures"; docs/protected-execution.md, "AT-10 provider
// harness"). It measures what Learnosity itself enforces on the requests
// Graffiticode signs and the records it saves: preview scope, request
// integrity, acceptance and established-session lifetime, replay, revocation
// by secret rotation, draft-only saves, and caching of signed requests.
//
// Everything is injected (signers, browser launcher, fetch, clock, stdin), so
// the planning, the evidence, the fixture manifest and the cache checks are
// tested without a browser or the network (scripts/test/at10-provider.test.js).
// Entry point: scripts/at10-provider.js.
//
// Custody rules, enforced here rather than by convention:
//   - a signed request lives only in a SignedRequest, whose value only
//     unseal() can read; it prints, logs and serializes as "[signed request]".
//     Only the browser driver unseals it, to hand it to the page;
//   - the raw signer reads LRN_SANDBOX_KEY / LRN_SANDBOX_SECRET /
//     LRN_SANDBOX_DOMAIN from the environment only, and refuses, before any
//     network, unless the key ends in LRN_SANDBOX_KEY_SUFFIX (the development consumer);
//   - every evidence write is scanned first (assertFactsOnly): a signed
//     request, a signature, the secret or the consumer key in it stops the run.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { dirname } from "node:path";
import { argsDigest } from "@graffiticode/broker";
import { hasSignedRequest, PREVIEW_PROGRAM, SAVE_PROGRAM } from "./canary.js";
import { decodeChainId } from "@graffiticode/common/chain";

// The development consumer's key ends in LRN_SANDBOX_KEY_SUFFIX (set in the
// operator's env file, not in the repository): any other key is refused.
export const sandboxKeySuffix = (env = process.env) => {
  const suffix = env.LRN_SANDBOX_KEY_SUFFIX;
  if (!suffix || suffix.length < 4) throw new HarnessRefused("LRN_SANDBOX_KEY_SUFFIX (the last 4 or more characters of the development consumer's key) must be in the environment (set -a; . ~/.lrn-sandbox.env; set +a)");
  return suffix;
};
export const ORIGIN = "https://l0176.graffiticode.org";
export const FOREIGN_ORIGIN = "https://at10-foreign.graffiticode.org";
// The JS APIs are pinned to a named LTS (research section 7: latest-lts is
// "not production use"); Data API calls use Broker's version.
export const DEFAULT_API_VERSION = "v2026.2.LTS";
export const DEFAULT_DATA_API_VERSION = "v2025.2.LTS";
export const DATA_API = `https://data.learnosity.com/${DEFAULT_DATA_API_VERSION}`;
export const DEFAULT_AGES = ["1m", "5m", "15m", "30m", "60m", "6h", "24h"];
// Questions API types are local_practice and submit_practice; feedback (and
// offline_app) are Items API only (research section 2).
export const DEFAULT_TYPES = { questions: ["local_practice", "submit_practice"], items: ["local_practice", "submit_practice", "feedback"] };
export const DEFAULT_STATES = ["initial", "resume", "review", "preview"];
// The session case waits this long past the request's expires before its
// second probe (plan step 6: "waits expires + 1 min").
export const DEFAULT_AFTER_EXPIRY = "60s";
// The raw signer's expires for the session case when --expires isn't given.
export const DEFAULT_SESSION_EXPIRES = "5m";
export const TAMPER_FIELDS = ["questions", "type", "session_id", "domain", "user_id"];
export const CASES = ["scope", "integrity", "acceptance", "session", "replay", "rotation", "drafts", "caches", "qe-preview", "separation"];
const OPS = { questions: "learnosity.sign-questions-preview", items: "learnosity.sign-items-preview" };
// A Learnosity signature ("$02$" + 64 hex), or enough of one to matter
// (an error message may cut it short).
const SIGNATURE_RE = /\$02\$[0-9a-f]{8,}/;
const sha256 = s => createHash("sha256").update(s).digest("hex");
const digestOf = value => (value === undefined ? null : sha256(JSON.stringify(value ?? null)).slice(0, 16));

export class HarnessRefused extends Error {}

// "90s", "5m", "6h", "1d" -> milliseconds.
export const parseDuration = text => {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(String(text).trim());
  if (!m) throw new HarnessRefused(`not a duration: ${text} (use e.g. 30s, 5m, 6h, 1d)`);
  return Math.round(Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]]);
};
export const parseList = text => String(text).split(",").map(s => s.trim()).filter(Boolean);

// Learnosity's security-packet time format, UTC: YYYYMMDD-HHmm.
export const lrnTime = ms => new Date(ms).toISOString().replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}).*$/, "$1$2$3-$4$5");

// A consumer key, recorded without being printed: its last four characters
// and a short hash.
export const keyFingerprint = key => (typeof key === "string" && key ? `...${key.slice(-4)} sha256:${sha256(key).slice(0, 12)}` : null);

// Replaces each secret value (and any Learnosity signature) in a string.
export const createRedactor = (secrets = []) => {
  const values = secrets.filter(s => typeof s === "string" && s.length >= 4).sort((a, b) => b.length - a.length);
  return text => {
    let out = String(text ?? "");
    for (const v of values) out = out.split(v).join("[redacted]");
    return out.replace(/\$02\$[0-9a-f]*/g, "[signature]");
  };
};

// Throws unless `value` is facts only: no signed request (an Items `security`
// block, or a Questions request's merged security fields), no signature, no
// secret and no consumer key, anywhere in it.
export const assertFactsOnly = (value, secrets = []) => {
  const text = JSON.stringify(value ?? null);
  if (hasSignedRequest(value)) throw new Error("evidence would carry a signed request; refusing to write it");
  if (SIGNATURE_RE.test(text)) throw new Error("evidence would carry a Learnosity signature; refusing to write it");
  for (const s of secrets) {
    if (typeof s === "string" && s.length >= 4 && text.includes(s)) throw new Error("evidence would carry a credential; refusing to write it");
  }
  return value;
};

// --- Signed requests ------------------------------------------------------

const SEALED = new WeakMap();
export class SignedRequest {
  constructor(api, value, meta = {}) {
    SEALED.set(this, value);
    this.api = api;
    this.meta = Object.freeze({ id: randomBytes(4).toString("hex"), ...meta });
    Object.freeze(this);
  }

  toJSON() { return { sealed: true, api: this.api, ...this.meta }; }
  toString() { return `[signed request ${this.api} ${this.meta.id}]`; }
  [inspect.custom]() { return this.toString(); }
}
// The value, for the browser step only. A copy, so a tamper never changes it.
export const unseal = signed => {
  if (!SEALED.has(signed)) throw new Error("not a signed request");
  return structuredClone(SEALED.get(signed));
};

// The request fields a browser may change after signing. Questions requests
// are flat (security fields merged in); Items requests wrap { security, request }.
const bodyOf = (api, req) => (api === "questions" ? req : (req.request ??= {}));
export const TAMPERS = {
  questions: (api, req) => {
    const body = bodyOf(api, req);
    body.questions = [...(body.questions ?? []), { response_id: `at10-tamper-${randomBytes(3).toString("hex")}`, type: "shorttext", stimulus: "AT-10 added after signing" }];
    return req;
  },
  type: (api, req) => {
    const body = bodyOf(api, req);
    body.type = body.type === "submit_practice" ? "local_practice" : "submit_practice";
    return req;
  },
  session_id: (api, req) => {
    bodyOf(api, req).session_id = randomUUID();
    return req;
  },
  domain: (api, req) => {
    const host = new URL(FOREIGN_ORIGIN).host;
    if (api === "questions") req.domain = host;
    else req.security = { ...req.security, domain: host };
    return req;
  },
  user_id: (api, req) => {
    if (api === "questions") req.user_id = "at10-tampered-user";
    else req.security = { ...req.security, user_id: "at10-tampered-user" };
    return req;
  },
};
export const setField = (field, value) => (api, req) => {
  bodyOf(api, req)[field] = value;
  return req;
};
const compose = (...fns) => (api, req) => fns.reduce((r, f) => f(api, r), req);

// What every preview signs: one scorable MCQ, inside Broker's constraints
// (operations.ts PREVIEW_KEYS), so the raw and broker signers sign the same.
export const previewPayload = (runId, n, { type = "local_practice" } = {}) => ({
  id: `at10-${runId}-${n}`,
  name: "AT-10",
  type,
  session_id: randomUUID(),
  questions: [{
    response_id: `at10-${runId}-${n}-0`,
    type: "mcq",
    stimulus: "AT-10 probe question",
    options: [{ label: "A", value: "0" }, { label: "B", value: "1" }],
    validation: { scoring_type: "exactMatch", valid_response: { score: 1, value: ["0"] } },
  }],
});

// The established-session probe's request (research section 8, the best
// candidate): one clozeformulaV2, whose scoring is asynchronous, so its
// isValid(cb) is the call most likely to reach Learnosity. The response the
// harness types is PROBE_RESPONSE, which the validation accepts.
export const PROBE_RESPONSE = "4";
export const probePayload = (runId, n) => ({
  id: `at10-${runId}-${n}`,
  name: "AT-10 probe",
  type: "local_practice",
  session_id: randomUUID(),
  questions: [{
    response_id: `at10-${runId}-${n}-0`,
    type: "clozeformulaV2",
    is_math: true,
    stimulus: "AT-10 probe: 2 + 2 =",
    template: "{{response}}",
    validation: { scoring_type: "exactMatch", valid_response: { score: 1, value: [[{ method: "equivSymbolic", value: PROBE_RESPONSE }]] } },
  }],
});

// A security packet's expires (YYYYMMDD-HHmm, UTC, as Broker returns it) or
// an ISO time (the raw signer's record), as ms. Learnosity's granularity is
// the minute, so an ISO time is floored to the minute it was signed as.
export const parseExpires = value => {
  if (value === null || value === undefined || value === "") return null;
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(String(value));
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : Math.floor(t / 60_000) * 60_000;
};

// --- Credentials and the raw signer ----------------------------------------

// From the environment only (source ~/.lrn-sandbox.env first). Refuses any
// consumer but the sandbox's, before anything touches the network.
export const loadRawCredentials = (env = process.env) => {
  const key = env.LRN_SANDBOX_KEY;
  const secret = env.LRN_SANDBOX_SECRET;
  const domain = env.LRN_SANDBOX_DOMAIN;
  const missing = [["LRN_SANDBOX_KEY", key], ["LRN_SANDBOX_SECRET", secret], ["LRN_SANDBOX_DOMAIN", domain]].filter(([, v]) => !v).map(([n]) => n);
  if (missing.length) throw new HarnessRefused(`the raw signer needs ${missing.join(", ")} in the environment (set -a; . ~/.lrn-sandbox.env; set +a)`);
  if (!key.endsWith(sandboxKeySuffix(env))) {
    throw new HarnessRefused("LRN_SANDBOX_KEY is not the development consumer (it must end in LRN_SANDBOX_KEY_SUFFIX); refusing to sign with it");
  }
  return Object.freeze({ key, secret, domain });
};

// The consumer key alone, for the unsigned Question Editor preview: the same
// sandbox-only guard, no secret needed.
export const loadSandboxKey = (env = process.env) => {
  const key = env.LRN_SANDBOX_KEY;
  if (!key) throw new HarnessRefused("the Question Editor preview needs LRN_SANDBOX_KEY in the environment (set -a; . ~/.lrn-sandbox.env; set +a)");
  if (!key.endsWith(sandboxKeySuffix(env))) {
    throw new HarnessRefused("LRN_SANDBOX_KEY is not the development consumer (it must end in LRN_SANDBOX_KEY_SUFFIX); refusing to use it");
  }
  return Object.freeze({ key, secret: env.LRN_SANDBOX_SECRET ?? null, domain: env.LRN_SANDBOX_DOMAIN ?? null });
};

export const createRawSigner = ({ sdk, credentials, now = Date.now }) => {
  const { key, secret, domain } = credentials;
  return {
    kind: "raw",
    keyFingerprint: keyFingerprint(key),
    domain,
    canExpire: true,
    // `expires`: an absolute time (ms) or null; `timestamp`: ms, default now.
    sign: async (api, payload, { expires = null, timestamp = now(), userId = randomUUID() } = {}) => {
      if (!OPS[api]) throw new HarnessRefused(`unknown api ${api}`);
      const security = { consumer_key: key, domain, user_id: userId, timestamp: lrnTime(timestamp), ...(expires === null ? {} : { expires: lrnTime(expires) }) };
      const value = sdk.init(api, security, secret, structuredClone(payload));
      return new SignedRequest(api, value, { signer: "raw", signedAt: new Date(now()).toISOString(), expires: expires === null ? null : new Date(expires).toISOString() });
    },
  };
};

// The Data API with the raw sandbox credential (fixtures and read-backs).
// call(route, action, body) -> { ok, status, data, reason }; never throws on a
// Learnosity answer, and its reason is redacted.
export const createDataApi = ({ sdk, credentials, fetch: doFetch = fetch, baseUrl = DATA_API, timeoutMs = 30_000, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) => {
  const { key, secret, domain } = credentials;
  const redact = createRedactor([key, secret]);
  // The provider build, as the Data API reports it (meta.versions
  // { requested, mapped, concrete }); the latest answer wins.
  let versions = null;
  let call = async (route, action, body) => {
    const request = sdk.init("data", { consumer_key: key, domain }, secret, body, action);
    let res;
    try {
      res = await doFetch(`${baseUrl}${route}`, { method: "POST", body: new URLSearchParams(request), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      return { ok: false, status: null, data: null, reason: redact(`network: ${e?.name ?? "error"}`) };
    }
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    const v = json?.meta?.versions;
    if (v && typeof v === "object") versions = { requested: v.requested ?? null, mapped: v.mapped ?? null, concrete: v.concrete ?? null };
    const ok = res.ok && json?.meta?.status === true;
    return { ok, status: res.status, data: ok ? json.data : null, reason: ok ? null : redact(json?.meta?.message ?? `HTTP ${res.status}`).slice(0, 300) };
  };
  // Learnosity rate-limits the Data API ("Too many requests"): back off and retry.
  const rawCall = call;
  call = async (route, action, body) => {
    for (let attempt = 0; ; attempt++) {
      const res = await rawCall(route, action, body);
      if (res.ok || !/too many requests/i.test(res.reason ?? "") || attempt >= 5) return res;
      await sleep(Math.min(2000 * 2 ** attempt, 30_000));
    }
  };
  const ROUTES = { question: "/itembank/questions", item: "/itembank/items", activity: "/itembank/activities" };
  const PLURAL = { question: "questions", item: "items", activity: "activities" };
  return {
    call,
    versions: () => versions,
    get: async (kind, references) => {
      const res = await call(ROUTES[kind], "get", { references, limit: references.length });
      const rows = Array.isArray(res.data) ? res.data : [];
      return { ...res, rows: new Map(rows.filter(r => references.includes(r?.reference)).map(r => [r.reference, r])) };
    },
    set: (kind, records) => call(ROUTES[kind], "set", { [PLURAL[kind]]: records }),
    // Change records' status. The Data API has no update action on these
    // routes, so each record is read back and written again with `set`.
    setStatus: async (kind, references, status) => {
      const there = await call(ROUTES[kind], "get", { references, limit: references.length });
      if (!there.ok) return there;
      const rows = (Array.isArray(there.data) ? there.data : []).filter(r => references.includes(r?.reference));
      if (rows.length !== references.length) return { ok: false, status: null, data: null, reason: `${references.length - rows.length} of ${references.length} records not found` };
      return call(ROUTES[kind], "set", { [PLURAL[kind]]: rows.map(r => ({ ...r, status })) });
    },
    // Retire a fixture. Learnosity's Data API has no delete or update action on
    // these routes ("Route not found"), so an item or activity is read back and
    // written again with `set` and status "archived". A question has no status
    // and can't be removed: it is left, unreferenced once its items are archived.
    // A record that was never created (a refused write) counts as absent.
    remove: async (kind, references) => {
      const there = await call(ROUTES[kind], "get", { references, limit: references.length });
      if (!there.ok) return { removed: null, reason: there.reason };
      const rows = (Array.isArray(there.data) ? there.data : []).filter(r => references.includes(r?.reference));
      if (rows.length === 0) return { removed: "absent" };
      if (kind === "question") return { removed: "left", reason: "questions have no status and the Data API can't delete them" };
      const archived = await call(ROUTES[kind], "set", { [PLURAL[kind]]: rows.map(r => ({ ...r, status: "archived" })) });
      return archived.ok ? { removed: "archived" } : { removed: null, reason: archived.reason };
    },
    responses: async sessionIds => {
      const res = await call("/sessions/responses", "get", { session_id: sessionIds, limit: sessionIds.length });
      const rows = Array.isArray(res.data) ? res.data : [];
      return { ok: res.ok, reason: res.reason, sessions: rows.length, responses: rows.reduce((n, r) => n + (Array.isArray(r?.responses) ? r.responses.length : 0), 0) };
    },
  };
};

// --- The broker signer ------------------------------------------------------

// Signs and saves through the real path, as the canary does (lib/canary.js):
// the gateway allocates an invocation for the canary user, L0176 preflights
// the program and Policy admits it (contract 2), the compiler takes a
// snapshot, mints an execution token and executes it at Broker. With
// `system`, the session is a system preview session instead (the system
// consumer: production credentials; sign only, with local_practice).
// Every signing opens its own session, so a long run never holds one.
export const createBrokerSigner = ({ http, idToken, accessToken, parse, config, system = false, runId = randomBytes(4).toString("hex") }) => {
  const { apiUrl, policyUrl, brokerUrl, gatewayAccount, compilerAccount, connectionId, languageUrl } = config;
  let seq = 0;
  let userToken = null;
  const asUser = async () => ({ Authorization: (userToken ??= await accessToken()) });
  const asService = async (account, url, urn) => ({
    "X-Serverless-Authorization": `Bearer ${await idToken(account, url)}`,
    "X-Caller-Identity": await idToken(account, urn),
  });
  const fail = (what, res) => new Error(`${what}: ${res.status} ${res.json?.error?.reason ?? res.json?.error?.code ?? ""}`.trim());
  const postTask = async src => {
    const res = await http({ method: "POST", url: `${apiUrl}/task`, headers: await asUser(), body: { task: { lang: "0176", code: await parse(src) } } });
    if (res.status !== 200 || typeof res.json?.data?.id !== "string") throw fail("POST /task", res);
    return res.json.data.id;
  };

  const openSession = async ({ program, fns }) => {
    const compilerAtPolicy = await asService(compilerAccount, policyUrl, "urn:graffiticode:policy");
    if (system) {
      const res = await http({ method: "POST", url: `${policyUrl}/v1/preview-session`, headers: compilerAtPolicy, body: { lang: "0176" } });
      if (!res.json?.data?.sessionToken) throw fail("POST /v1/preview-session", res);
      return { sessionToken: res.json.data.sessionToken, compilerAtPolicy };
    }
    const taskId = await postTask(program);
    const key = `at10:${runId}:${++seq}`;
    const gateway = { ...(await asService(gatewayAccount, policyUrl, "urn:graffiticode:policy")), ...(await asUser()) };
    const alloc = await http({ method: "POST", url: `${policyUrl}/v1/invocations`, headers: gateway, body: { connectionId, taskId, inputDigest: sha256(key), idempotencyKey: key, admission: true } });
    const inv = alloc.json?.data;
    if (typeof inv?.invocationToken !== "string") throw fail("POST /v1/invocations", alloc);
    let plan = {};
    if (inv.contract === 2) {
      if (!languageUrl) throw new Error("a marked invocation needs L0176's URL for its preflight");
      const pre = await http({ method: "POST", url: `${languageUrl}/preflight`, headers: { "X-Caller-Identity": await idToken(gatewayAccount, "urn:graffiticode:0176") }, body: { stage: "s0", lang: "0176", code: await parse(program) } });
      const manifest = pre.json?.data?.manifest;
      if (pre.status !== 200 || !manifest) throw fail("L0176 /preflight", pre);
      const admitted = await http({ method: "POST", url: `${policyUrl}/v1/admissions`, headers: gateway, body: { invocationToken: inv.invocationToken, taskIds: decodeChainId(taskId), stages: [manifest] } });
      if (typeof admitted.json?.data?.admissionToken !== "string") throw fail("POST /v1/admissions", admitted);
      plan = { admissionToken: admitted.json.data.admissionToken, manifest };
    }
    const snap = await http({ method: "POST", url: `${policyUrl}/v1/snapshot`, headers: { ...compilerAtPolicy, ...(await asUser()) }, body: { lang: "0176", connectionId, fns, invocationToken: inv.invocationToken, stage: "s0", ...plan } });
    if (!snap.json?.data?.sessionToken) throw fail("POST /v1/snapshot", snap);
    return { sessionToken: snap.json.data.sessionToken, compilerAtPolicy };
  };
  const mintAndExecute = async (session, fn, op, payload) => {
    const occurrenceId = `AT10_${fn === "init" ? "SIGN" : "SAVE"}:${++seq}.0`;
    const minted = await http({ method: "POST", url: `${policyUrl}/v1/mint`, headers: session.compilerAtPolicy, body: { sessionToken: session.sessionToken, fn, op, occurrenceId, argsDigest: argsDigest(payload) } });
    const token = minted.json?.data?.executionToken;
    if (!token) throw fail(`POST /v1/mint ${op}`, minted);
    const compilerAtBroker = await asService(compilerAccount, brokerUrl, "urn:graffiticode:broker");
    return http({ method: "POST", url: `${brokerUrl}/v1/execute`, headers: { ...compilerAtBroker, Authorization: `Bearer ${token}` }, body: { op, payload } });
  };

  return {
    kind: system ? "broker-system" : "broker",
    keyFingerprint: null,
    domain: "l0176.graffiticode.org",
    canExpire: false,
    sign: async (api, payload, { expires = null } = {}) => {
      if (!OPS[api]) throw new HarnessRefused(`unknown api ${api}`);
      if (expires !== null) throw new HarnessRefused("Broker sets its own expires (BROKER_PREVIEW_EXPIRES_MINUTES); use --signer raw for other values");
      // A fresh user token for each signing: the canary's expires within minutes,
      // and a long case signs its controls well after it starts.
      userToken = null;
      const session = await openSession({ program: PREVIEW_PROGRAM, fns: ["init"] });
      const res = await mintAndExecute(session, "init", OPS[api], payload);
      const request = res.json?.data?.result?.request;
      if (res.status !== 200 || res.json?.data?.status !== "succeeded" || !request) throw fail(`Broker ${OPS[api]}`, res);
      // Record the expires Broker set (the security packet's, which the signature covers).
      const brokerExpires = (request.security ?? request)?.expires ?? null;
      return new SignedRequest(api, request, { signer: system ? "broker-system" : "broker", signedAt: new Date().toISOString(), expires: brokerExpires });
    },
    // learnosity.write-items through Broker: { status, steps, references, reason }.
    write: async payload => {
      if (system) throw new HarnessRefused("a system session can't save");
      const session = await openSession({ program: SAVE_PROGRAM, fns: ["init", "save-to-itembank"] });
      const res = await mintAndExecute(session, "save-to-itembank", "learnosity.write-items", payload);
      const data = res.json?.data;
      return { httpStatus: res.status, status: data?.status ?? null, steps: data?.steps ?? null, references: data?.result?.references ?? null, questionReferences: data?.result?.questionReferences ?? null, reason: data?.reason ?? res.json?.error?.reason ?? null };
    },
    // The gateway save (POST /compile of a save program) as the canary user:
    // only the saved references are kept.
    gatewaySave: async (src, idempotencyKey) => {
      const id = await postTask(src);
      const res = await http({ method: "POST", url: `${apiUrl}/compile`, headers: await asUser(), body: { id, data: {}, connectionId, idempotencyKey } });
      const found = { references: [], questionReferences: [] };
      const walk = v => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (v && typeof v === "object") {
          if (v.saved === true) {
            if (Array.isArray(v.references)) found.references.push(...v.references.filter(r => typeof r === "string"));
            if (Array.isArray(v.questionReferences)) found.questionReferences.push(...v.questionReferences.filter(r => typeof r === "string"));
          }
          Object.values(v).forEach(walk);
        }
      };
      walk(res.json?.data);
      const errors = [...(res.json?.data?.errors ?? []), ...(res.json?.errors ?? [])].map(e => e?.code ?? e?.message ?? "error");
      return { httpStatus: res.status, errors, ...found };
    },
  };
};

// --- Raw saves (the Data API stand-in for Broker's write, raw signer only) --

export const createRawSaver = dataApi => ({
  write: async ({ questionRecords, itemRecords }) => {
    const steps = [];
    const q = await dataApi.set("question", questionRecords);
    if (!q.ok) return { status: "failed", steps, reason: q.reason };
    steps.push("questions");
    if (itemRecords.length) {
      const it = await dataApi.set("item", itemRecords);
      if (!it.ok) return { status: "partial", steps, reason: it.reason };
      steps.push("items");
    }
    return { status: "succeeded", steps, references: (itemRecords.length ? itemRecords : questionRecords).map(r => r.reference), questionReferences: questionRecords.map(r => r.reference), reason: null };
  },
});

// --- The browser ------------------------------------------------------------

const LEARNOSITY_HOST = /(^|\.)learnosity\.com$/i;
const VERSION_QUERY = /^(v?\d{4}\.\d+\.[A-Za-z]+|latest(-lts)?)$/i;
const VERSION_IN_PATH = /v?\d{4}\.\d+\.(LTS|[A-Za-z]+)/i;
const SCRIPT_HOST = { questions: "questions", items: "items", qe: "questioneditor", author: "authorapi" };
const scriptUrl = (api, version) => `https://${SCRIPT_HOST[api]}.learnosity.com/?${version}`;

// One network log entry: method, host, path and status. Never a body, and a
// query string only when it is just an API version (e.g. ?latest-lts).
// Of a request body only its size, and whether it (or the query) mentions a
// signature, is kept.
export const networkEntry = (url, method, status, redact = s => s, body = null) => {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!LEARNOSITY_HOST.test(u.hostname)) return null;
  const q = u.search.slice(1);
  const text = typeof body === "string" ? body : "";
  return {
    method,
    host: u.hostname,
    path: redact(u.pathname),
    status,
    ...(VERSION_QUERY.test(q) ? { version: q } : {}),
    requestBytes: text.length,
    mentionsSignature: /signature/i.test(text) || /signature/i.test(q),
  };
};
// Requests that reach an item bank (plan rev 9): the Data API or Author API
// hosts, or an item-bank path on any host. A Questions session must make none,
// however its request was changed.
export const itemBankCalls = entries => entries.filter(e => /^(data|authorapi)\.learnosity\.com$/i.test(e.host) || /itembank|\/items?\/(set|update|save)/i.test(e.path));
// Requests whose path looks like storage (session, response, save, submit).
export const storageLike = entries => entries.filter(e => /session|response|save|submit/i.test(e.path));
export const versionFromNetwork = entries => {
  for (const e of entries) {
    const m = VERSION_IN_PATH.exec(e.path) ?? (e.version && VERSION_IN_PATH.exec(e.version));
    if (m) return m[0];
  }
  return null;
};

// The page Learnosity sees: served at the l0176 origin by interception, so
// the domain check is real. It loads the real API script and exposes
// window.__at10.init / .action, which only ever report facts back.
export const harnessHtml = (api, version) => `<!doctype html>
<html><head><meta charset="utf-8"><title>AT-10 ${api}</title>
<script src="${scriptUrl(api, version)}"></script></head>
<body><div id="root"></div><script>
(function () {
  var short = function (v) { return String(v == null ? "" : v).slice(0, 300); };
  var errOf = function (e) { return { code: e && e.code != null ? String(e.code) : null, message: short(e && (e.msg || e.message) || e) }; };
  var at10 = window.__at10 = { app: null, errors: [] };
  var Global = function (api) { return api === "questions" ? window.LearnosityApp : api === "qe" ? window.LearnosityQuestionEditor : api === "author" ? window.LearnosityAuthor : window.LearnosityItems; };
  at10.version = function (api) {
    var G = Global(api), app = at10.app, tries = [
      function () { return app && typeof app.getVersion === "function" ? app.getVersion() : null; },
      function () { return app && app.version; },
      function () { return G && typeof G.getVersion === "function" ? G.getVersion() : null; },
      function () { return G && G.version; },
      function () { return window.LRNVersion || null; }
    ];
    for (var i = 0; i < tries.length; i++) {
      try { var v = tries[i](); if (typeof v === "string" || typeof v === "number") return { value: String(v), source: i }; } catch (e) {}
    }
    return { value: null, source: null };
  };
  at10.init = function (api, request, timeoutMs) {
    return new Promise(function (resolve) {
      var root = document.getElementById("root"); root.innerHTML = "";
      var body = api === "questions" ? request : (request && request.request) || {};
      if (api === "questions") {
        (body.questions || []).forEach(function (q) { var s = document.createElement("span"); s.className = "learnosity-response question-" + q.response_id; root.appendChild(s); });
      } else {
        var d = document.createElement("div"); d.id = api === "author" ? "learnosity-author" : "learnosity_assess"; root.appendChild(d);
        // An inline Items render needs an element per item.
        if (api === "items" && body.rendering_type === "inline") {
          (body.items || []).forEach(function (ref) { var s = document.createElement("span"); s.className = "learnosity-item"; s.setAttribute("data-reference", typeof ref === "string" ? ref : ref && ref.reference); root.appendChild(s); });
        }
      }
      var G = Global(api);
      if (!G) return resolve({ ready: false, errors: [{ code: null, message: "the Learnosity API script did not load" }], version: { value: null, source: null } });
      var done = false;
      var finish = function (ready) { if (done) return; done = true; resolve({ ready: ready, errors: at10.errors.slice(), version: at10.version(api) }); };
      var timer = setTimeout(function () { finish(false); }, timeoutMs);
      try {
        at10.app = G.init(request, {
          readyListener: function () { clearTimeout(timer); finish(true); },
          errorListener: function (e) { at10.errors.push(errOf(e)); if (!done) { clearTimeout(timer); setTimeout(function () { finish(false); }, 1500); } }
        });
      } catch (e) { at10.errors.push({ code: null, message: "init threw: " + short(e && e.message || e) }); clearTimeout(timer); finish(false); }
    });
  };
  // The Question Editor API with a preview-only custom layout, unsigned: the
  // consumer key only (configuration.consumer_key loads consumer CSS). Its
  // documented hooks: readyListener (call nothing before it), the
  // "widget:ready" event (the widget JSON has changed and the preview pane
  // has finished rendering; it can fire before readyListener), and
  // "preview:changed". Every event seen is reported, with its time.
  at10.qeInit = function (options, timeoutMs, renderTimeoutMs) {
    return new Promise(function (resolve) {
      var root = document.getElementById("root");
      root.innerHTML = '<div class="learnosity-question-editor"><div data-lrn-qe-layout-preview-panel></div></div>';
      var G = window.LearnosityQuestionEditor;
      if (!G) return resolve({ ready: false, events: [], finishedBy: "no-script", errors: [{ code: null, message: "the Question Editor API script did not load" }], version: { value: null, source: null } });
      var t0 = Date.now(), events = [], ready = false, done = false, renderTimer = null;
      var rendered = function () { return events.some(function (e) { return /widget:ready$/.test(e.name); }); };
      var finish = function (why) {
        if (done) return; done = true; clearTimeout(timer); clearTimeout(renderTimer);
        resolve({ ready: ready, events: events.slice(), finishedBy: why, errors: at10.errors.slice(), version: at10.version("qe") });
      };
      var note = function (name) { return function () { events.push({ name: name, ms: Date.now() - t0 }); if (ready && rendered()) setTimeout(function () { finish("widget:ready"); }, 500); }; };
      var timer = setTimeout(function () { finish("init-timeout"); }, timeoutMs);
      try {
        at10.app = G.init(options, ".learnosity-question-editor", {
          readyListener: function () {
            ready = true; events.push({ name: "readyListener", ms: Date.now() - t0 });
            clearTimeout(timer);
            if (rendered()) return setTimeout(function () { finish("widget:ready"); }, 500);
            renderTimer = setTimeout(function () { finish("render-timeout"); }, renderTimeoutMs);
          },
          errorListener: function (e) { at10.errors.push(errOf(e)); if (!done && !ready) { clearTimeout(timer); setTimeout(function () { finish("error"); }, 1500); } }
        });
        ["widget:ready", "widgetedit:widget:ready", "preview:changed", "widgetedit:preview:changed", "editor:ready"].forEach(function (n) {
          try { if (at10.app && typeof at10.app.on === "function") at10.app.on(n, note(n)); } catch (e) {}
        });
      } catch (e) { at10.errors.push({ code: null, message: "init threw: " + short(e && e.message || e) }); finish("threw"); }
    });
  };
  // The preview's Questions API instance (questionsApp(), documented: "used
  // by the set validation area and the preview area").
  var previewApp = function () {
    try { return at10.app && typeof at10.app.questionsApp === "function" ? at10.app.questionsApp() : null; } catch (e) { return null; }
  };
  // What the preview panel shows: the panel element, its rendered content,
  // whether the stimulus is visible, its inputs, any correct/incorrect
  // marking, and how many question instances the preview's Questions API has.
  at10.qePanel = function (stimulus) {
    var panel = document.querySelector("[data-lrn-qe-layout-preview-panel]");
    var text = panel ? panel.innerText || "" : "";
    var marked = panel && panel.querySelector(".lrn_correct, .lrn_incorrect, .lrn_partially_correct");
    var qa = previewApp(), count = 0;
    if (qa && typeof qa.questions === "function") { try { count = Object.keys(qa.questions() || {}).length; } catch (e) {} }
    return {
      panel: Boolean(panel),
      previewElements: panel ? panel.querySelectorAll("*").length : 0,
      responseAreas: panel ? panel.querySelectorAll(".learnosity-response").length : 0,
      stimulusShown: Boolean(stimulus) && text.indexOf(stimulus) >= 0,
      inputs: panel ? panel.querySelectorAll("input, textarea, select, [contenteditable=true]").length : 0,
      validation: marked ? (marked.className.indexOf("lrn_incorrect") >= 0 ? "incorrect" : marked.className.indexOf("lrn_partially") >= 0 ? "partial" : "correct") : null,
      questionsApp: { available: Boolean(qa), questions: count }
    };
  };
  // validateQuestions() on the preview's Questions API (the documented example).
  at10.qeValidate = function () {
    var qa = previewApp();
    if (!qa || typeof qa.validateQuestions !== "function") return { called: false };
    try { qa.validateQuestions(); return { called: true }; } catch (e) { return { called: false, error: errOf(e) }; }
  };
  // save / submit on an app, with callbacks.
  var runAction = function (app, name, timeoutMs) {
    return new Promise(function (resolve) {
      var before = at10.errors.length;
      var newErrors = function () { return at10.errors.slice(before); };
      if (!app || typeof app[name] !== "function") return resolve({ outcome: "unavailable", errors: [] });
      var timer = setTimeout(function () { resolve({ outcome: "timeout", errors: newErrors() }); }, timeoutMs);
      try {
        app[name]({
          success: function () { clearTimeout(timer); resolve({ outcome: "success", errors: newErrors() }); },
          error: function (e) { clearTimeout(timer); resolve({ outcome: "error", error: errOf(e), errors: newErrors() }); }
        });
      } catch (e) { clearTimeout(timer); resolve({ outcome: "threw", error: errOf(e), errors: newErrors() }); }
    });
  };
  at10.action = function (name, timeoutMs) { return runAction(at10.app, name, timeoutMs); };
  // Through the Question Editor preview's own Questions API session.
  at10.qeAction = function (name, timeoutMs) { return runAction(previewApp(), name, timeoutMs); };
  var show = function (v) { if (v === undefined) return "undefined"; try { return short(JSON.stringify(v)); } catch (e) { return short(v); } };
  var questionOf = function (rid) {
    try { return at10.app && typeof at10.app.question === "function" ? at10.app.question(rid) : null; } catch (e) { return null; }
  };
  // Whether the question holds a response (getResponse()), after typing one.
  at10.hasResponse = function (rid) {
    var q = questionOf(rid);
    if (!q || typeof q.getResponse !== "function") return { available: Boolean(q), hasResponse: false };
    try {
      var r = q.getResponse();
      return { available: true, hasResponse: Boolean(r) && r.value !== undefined && r.value !== null && String(r.value) !== "" };
    } catch (e) { return { available: true, hasResponse: false, error: errOf(e) }; }
  };
  // The established-session probe (research section 8): the question's
  // isValid(withPartials, callback), the callback form asynchronous scoring
  // types need. Reports the callback's value, what it returned, and any
  // errorListener error raised meanwhile; the driver adds the network log.
  at10.check = function (rid, timeoutMs) {
    return new Promise(function (resolve) {
      var before = at10.errors.length, done = false, returned, timer, poll;
      var fin = function (o) {
        if (done) return; done = true; clearTimeout(timer); clearInterval(poll);
        o.returned = returned === undefined ? null : returned; o.errors = at10.errors.slice(before); resolve(o);
      };
      var q = questionOf(rid);
      if (!q || typeof q.isValid !== "function") return fin({ outcome: "unavailable" });
      timer = setTimeout(function () { fin({ outcome: "timeout" }); }, timeoutMs);
      poll = setInterval(function () {
        if (at10.errors.length > before) { clearInterval(poll); setTimeout(function () { var e = at10.errors[at10.errors.length - 1]; fin({ outcome: "error", error: e }); }, 1000); }
      }, 250);
      try {
        returned = show(q.isValid(false, function (v) { fin({ outcome: "success", value: show(v) }); }));
      } catch (e) { fin({ outcome: "threw", error: errOf(e) }); }
    });
  };
})();
</script></body></html>`;

// launch() -> a Playwright Browser (chromium.launch). The driver never reads
// a request except to hand it to page.evaluate.
export const createBrowserDriver = async ({ launch, apiVersion = DEFAULT_API_VERSION, origin = ORIGIN, initTimeoutMs = 45_000, actionTimeoutMs = 30_000, renderTimeoutMs = 20_000, settleMs = 2000, redact = s => s }) => {
  const browser = await launch();
  const contexts = new Set();
  // Page text is redacted with the run's secrets, and of signatures always.
  const scrub = createRedactor();
  const text = s => scrub(redact(s));
  const clean = facts => ({
    ...facts,
    errors: (facts?.errors ?? []).map(e => ({ code: e.code, message: text(e.message) })),
    ...(facts?.error ? { error: { code: facts.error.code, message: text(facts.error.message) } } : {}),
  });
  const newContext = async () => {
    const context = await browser.newContext();
    contexts.add(context);
    const network = [];
    context.on("response", r => {
      const e = networkEntry(r.url(), r.request().method(), r.status(), text, r.request().postData());
      if (e) network.push(e);
    });
    context.on("requestfailed", r => {
      const e = networkEntry(r.url(), r.method(), null, text);
      if (e) network.push({ ...e, failure: text(r.failure()?.errorText ?? "failed") });
    });
    await context.route("**/__at10/**", route => {
      const requested = new URL(route.request().url()).searchParams.get("api");
      const api = ["items", "qe", "author"].includes(requested) ? requested : "questions";
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: harnessHtml(api, apiVersion) });
    });
    const open = async ({ signed, mutate = null, at = origin, name = "case" }) => {
      const api = signed.api;
      const page = await context.newPage();
      const mark = network.length;
      await page.goto(`${at}/__at10/${encodeURIComponent(name)}?api=${api}`, { waitUntil: "load" });
      const request = mutate ? mutate(api, unseal(signed)) : unseal(signed);
      const initAt = new Date().toISOString();
      const res = clean(await page.evaluate(([a, r, t]) => window.__at10.init(a, r, t), [api, request, initTimeoutMs]));
      const seen = network.slice(mark);
      const init = {
        api,
        request: signed.meta.id,
        signer: signed.meta.signer,
        signedAt: signed.meta.signedAt,
        expires: signed.meta.expires ?? null,
        initAt,
        origin: at,
        ready: res.ready === true,
        errors: res.errors,
        reportedVersion: res.version?.value ?? null,
        reportedVersionSource: res.version?.source ?? null,
        networkVersion: versionFromNetwork(seen),
        network: seen,
      };
      return {
        init,
        // save / submit; facts plus the Learnosity traffic it caused.
        action: async actionName => {
          const before = network.length;
          const out = clean(await page.evaluate(([n, t]) => window.__at10.action(n, t), [actionName, actionTimeoutMs]));
          await page.waitForTimeout(settleMs);
          return { ...out, network: network.slice(before) };
        },
        // Types `value` into the question's response area, as a user would:
        // focus the first editable element inside the question's span, then
        // the keyboard. Reports whether the question now holds a response.
        enterResponse: async (responseId, value) => {
          const scope = `.learnosity-response.question-${responseId}`;
          const targets = ["[contenteditable=true]", "textarea", "input", ""];
          let clicked = null;
          for (const t of targets) {
            try {
              await page.locator(t ? `${scope} ${t}` : scope).first().click({ timeout: 3000 });
              clicked = t || "the response span";
              break;
            } catch { /* try the next */ }
          }
          if (clicked) {
            await page.keyboard.type(value, { delay: 50 });
            await page.waitForTimeout(settleMs);
          }
          const state = clean(await page.evaluate(r => window.__at10.hasResponse(r), responseId));
          return { clicked, available: state.available === true, entered: state.hasResponse === true, ...(state.error ? { error: state.error } : {}) };
        },
        // The isValid(cb) probe; facts plus the Learnosity traffic it caused
        // (the trailing settle catches a request the callback didn't wait for).
        check: async responseId => {
          const before = network.length;
          const out = clean(await page.evaluate(([r, t]) => window.__at10.check(r, t), [responseId, actionTimeoutMs]));
          await page.waitForTimeout(settleMs);
          return { ...out, value: out.value === undefined ? null : text(out.value), returned: out.returned == null ? null : text(out.returned), network: network.slice(before) };
        },
        evaluate: (fn, arg) => page.evaluate(fn, arg),
        network: () => network.slice(mark),
        close: () => page.close(),
      };
    };
    // One Question Editor instance per question (QE renders one widget).
    // Waits for readyListener and the preview's widget:ready, judges the
    // render by the documented hooks (qeRendered), then answers the first
    // input, validates through the preview's Questions API, and, for each of
    // `actions` (save, submit), tries it on that same session.
    const openQe = async ({ consumerKey, widget, name = "qe", at = origin, actions = [] }) => {
      const page = await context.newPage();
      const mark = network.length;
      await page.goto(`${at}/__at10/${encodeURIComponent(name)}?api=qe`, { waitUntil: "load" });
      const options = { configuration: { consumer_key: consumerKey }, widget_json: widget, ui: { layout: { global_template: "custom" } } };
      const res = clean(await page.evaluate(([o, t, r]) => window.__at10.qeInit(o, t, r), [options, initTimeoutMs, renderTimeoutMs]));
      const stimulus = typeof widget?.stimulus === "string" ? widget.stimulus : null;
      const shown = await page.evaluate(s => window.__at10.qePanel(s), stimulus);
      const render = qeRendered({ ready: res.ready, events: res.events, panel: shown });
      let answered = false;
      let validate = null;
      const actionResults = [];
      if (render.rendered) {
        try {
          await page.locator("[data-lrn-qe-layout-preview-panel] input").first().click({ timeout: 5000 });
          answered = true;
        } catch { /* nothing to answer */ }
        validate = clean(await page.evaluate(() => window.__at10.qeValidate()));
        await page.waitForTimeout(settleMs);
        for (const action of actions) {
          const before = network.length;
          const out = clean(await page.evaluate(([n, t]) => window.__at10.qeAction(n, t), [action, actionTimeoutMs]));
          await page.waitForTimeout(settleMs);
          const caused = network.slice(before);
          actionResults.push({ action, ...out, network: caused, storageLikeRequests: storageLike(caused) });
        }
      } else {
        for (const action of actions) actionResults.push({ action, outcome: "not-attempted (the preview didn't render)", errors: [], network: [] });
      }
      const after = await page.evaluate(s => window.__at10.qePanel(s), stimulus);
      const seen = network.slice(mark);
      await page.close();
      return {
        type: widget?.type ?? null,
        ready: res.ready === true,
        events: res.events ?? [],
        finishedBy: res.finishedBy ?? null,
        errors: res.errors,
        reportedVersion: res.version?.value ?? null,
        networkVersion: versionFromNetwork(seen),
        rendered: render.rendered,
        render,
        panel: shown,
        stimulusShown: shown.stimulusShown,
        inputs: shown.inputs,
        answered,
        validate,
        validation: after.validation,
        actions: actionResults,
        network: seen,
        storageLikeRequests: storageLike(seen),
        anyRequestMentionsSignature: seen.some(e => e.mentionsSignature),
      };
    };
    return { open, openQe, network: () => network.slice(), close: async () => { contexts.delete(context); await context.close(); } };
  };
  return {
    newContext,
    close: async () => {
      for (const c of contexts) await c.close().catch(() => {});
      await browser.close();
    },
  };
};

// --- Question Editor render detection -----------------------------------------

// Whether the Question Editor preview rendered a question, from the
// documented hooks only: readyListener fired, the preview panel element
// (data-lrn-qe-layout-preview-panel) is there, the preview finished
// rendering (the widget:ready event, or a question instance in the
// preview's questionsApp()), and the question is visible in the panel (its
// stimulus, or a response input). `missing` names what wasn't seen.
export const qeRendered = ({ ready, events = [], panel = {} } = {}) => {
  const widgetReady = (events ?? []).some(e => /(^|:)widget:ready$/.test(e?.name ?? ""));
  const questionInstances = panel?.questionsApp?.questions ?? 0;
  const finished = widgetReady || questionInstances > 0;
  const visible = panel?.stimulusShown === true || (panel?.inputs ?? 0) > 0;
  const missing = [
    ready !== true && "readyListener",
    panel?.panel !== true && "the preview panel element",
    !finished && "widget:ready or a question instance in questionsApp()",
    !visible && "the stimulus or a response input in the panel",
  ].filter(Boolean);
  return { rendered: missing.length === 0, widgetReady, questionInstances, visible, missing };
};

// --- Probes for an established session --------------------------------------

// probe(session, { responseId }) -> raw facts with the network it caused.
//   - isvalid: research section 8's best candidate, the clozeformulaV2
//     question's isValid(cb) (asynchronous scoring), on a contained
//     (local_practice) session;
//   - save, submit: meaningful only where the session may store
//     (submit_practice); a contained session refuses them before any expiry.
export const PROBES = {
  isvalid: (session, { responseId }) => session.check(responseId),
  save: session => session.action("save"),
  submit: session => session.action("submit"),
};
export const DEFAULT_PROBE = "isvalid";

// A request for a static asset is never the probe's server call.
const STATIC_PATH = /\.(js|mjs|css|woff2?|ttf|otf|eot|png|jpe?g|gif|svg|ico|map|json)$/i;
// One probe call's facts: its outcome, value and errors, and the network
// log of the *.learnosity.com calls it caused (method, host, path, status
// only). A call that caused no non-static Learnosity request didn't reach
// the provider, so it proves nothing about expiry: `confirmed` is false and
// the finding is "probe-unconfirmed".
export const probeFacts = (name, raw = {}) => {
  const network = (raw.network ?? []).map(({ method, host, path, status, failure }) => ({ method, host, path, status: status ?? null, ...(failure ? { failure } : {}) }));
  const server = network.filter(e => !STATIC_PATH.test(e.path ?? ""));
  const refused = server.filter(e => e.status === null || e.status >= 400);
  return {
    probe: name,
    outcome: raw.outcome ?? null,
    ...(raw.value !== undefined ? { value: raw.value } : {}),
    ...(raw.returned !== undefined ? { returned: raw.returned } : {}),
    error: raw.error ?? null,
    errors: raw.errors ?? [],
    ...(raw.detail ? { detail: raw.detail } : {}),
    network,
    serverCalls: server.length,
    refusedCalls: refused.length,
    confirmed: server.length > 0,
    ...(server.length ? {} : { finding: "probe-unconfirmed" }),
  };
};
const probeOk = p => p?.outcome === "success" && p.refusedCalls === 0 && (p.errors ?? []).length === 0;

// The series' verdict, from the probe before expires, the one after, and a
// fresh control's probe at the same moment:
//   - probe-unconfirmed: either probe made no server call, so it can't
//     speak for expiry (a local-only check is never an expiry result);
//   - failed-before-expires: the probe didn't work while the request was valid;
//   - accepted-after-expires: the session still reached Learnosity, accepted;
//   - refused-after-expires: refused after, worked before, and the control
//     worked then (so the refusal is the expiry's);
//   - refused-control-too: the control was refused as well, so it isn't.
export const sessionVerdict = (before, after, controlProbe = null) => {
  if (!before || !after) return "incomplete";
  if (!before.confirmed || !after.confirmed) return "probe-unconfirmed";
  if (!probeOk(before)) return "failed-before-expires";
  if (probeOk(after)) return "accepted-after-expires";
  if (controlProbe && !probeOk(controlProbe)) return "refused-control-too";
  return "refused-after-expires";
};

// A probe that fails in the harness (a closed page, a timeout) is recorded
// as such, unconfirmed; a long series goes on.
export const runProbe = async (name, session, opts = {}) => {
  const probe = PROBES[name];
  if (!probe) throw new HarnessRefused(`unknown probe ${name} (${Object.keys(PROBES).join(", ")})`);
  try {
    return probeFacts(name, await probe(session, opts));
  } catch (e) {
    return probeFacts(name, { outcome: "harness-error", detail: String(e?.message ?? e).slice(0, 300) });
  }
};

// --- Planning (pure; dry-run prints it) -------------------------------------

// One fresh, unused request per age, all signed at t0 and each initialised at
// its age, each with its own control signed fresh at that moment. With
// expires values (raw signer), each value adds one request just inside it
// and one just past it.
export const planAcceptance = ({ ages = DEFAULT_AGES, expires = [], t0 = 0 } = {}) => {
  const steps = ages.map(age => ({ id: `age-${age}`, age, ageMs: parseDuration(age), expires: null }));
  for (const e of expires) {
    const ms = parseDuration(e);
    steps.push({ id: `expires-${e}-inside`, age: `${Math.round(ms / 2000)}s`, ageMs: Math.round(ms / 2), expires: e, expiresMs: ms });
    steps.push({ id: `expires-${e}-past`, age: `${Math.round((ms + 60_000) / 1000)}s`, ageMs: ms + 60_000, expires: e, expiresMs: ms });
  }
  return steps
    .map(s => ({ ...s, signAt: new Date(t0).toISOString(), initAt: new Date(t0 + s.ageMs).toISOString(), freshRequest: true, control: "fresh, signed at initAt", status: "planned" }))
    .sort((a, b) => a.ageMs - b.ageMs);
};

// Each replay mode with its own fresh, unused request and its own control.
export const REPLAY_MODES = ["same-browser", "two-contexts", "after-first-use"];
export const planReplay = () => REPLAY_MODES.map(mode => ({ id: `replay-${mode}`, mode, freshRequest: true, control: true }));

export const planIntegrity = () => TAMPER_FIELDS.map(field => ({ id: `tamper-${field}`, field, freshRequest: true }))
  .concat([{ id: "origin-foreign", field: "origin", freshRequest: true }]);

// With `store: false` (--no-store) the step that stores a response is left
// out, so a run against a production consumer writes nothing.
export const planScope = ({ api = "questions", types = DEFAULT_TYPES[api], states = DEFAULT_STATES, store = true } = {}) => [
  ...types.map(t => ({ id: `type-${t}`, change: { type: t }, freshRequest: true })),
  ...states.map(s => ({ id: `state-${s}`, change: { state: s }, freshRequest: true })),
  { id: "questions-added", change: { questions: "added" }, freshRequest: true },
  { id: "session-changed", change: { session_id: "new" }, freshRequest: true },
  ...(store ? [{ id: "store-submit_practice", change: { type: "submit_practice", session_id: "new" }, action: "submit", readBack: "Data API /sessions/responses", freshRequest: true }] : []),
];

// One series per expires: the raw signer's --expires values (default
// DEFAULT_SESSION_EXPIRES), or Broker's own. Each signs one request,
// initialises it in one page, enters a response, probes it just after
// initialising and again once expires + afterExpiry has passed, in the same
// page, and then probes a fresh control signed at that moment.
export const planSession = ({ expires = [], probe = DEFAULT_PROBE, signer = "broker", afterExpiry = DEFAULT_AFTER_EXPIRY } = {}) => {
  const values = signer === "raw" ? (expires.length ? expires : [DEFAULT_SESSION_EXPIRES]) : [null];
  return values.map(e => ({
    id: e ? `session-expires-${e}` : "session-broker-expires",
    expires: e ?? "Broker's own",
    expiresMs: e ? parseDuration(e) : null,
    probe,
    afterExpiry,
    phases: [
      { phase: "before-expires", when: "just after initialising and entering a response" },
      { phase: "after-expires", when: `expires + ${afterExpiry}, in the same page; then a fresh control` },
    ],
  }));
};

export const DRAFT_CASES = {
  a: "a normal save, read back as unpublished",
  b: "itemRecords: [], a question-only save",
  c: "a question reference used by a published fixture item and activity, written through Broker",
  d: "as (c), with the item write failing after the question write",
  e: "save -> publish -> save again with Graffiticode's own references",
  f: "a save reusing an already-published item's reference: does the item become unpublished",
};

// The Question Editor preview (plan option A4, research section 4): inline
// question JSON, one editor per question, unsigned. A single MCQ, and the
// questions of an L0158-shaped activity (as L0158 hands them to L0176).
export const QE_SINGLE = [{ type: "mcq", stimulus: "AT-10 Question Editor preview", options: [{ label: "A", value: "0" }, { label: "B", value: "1" }], validation: { scoring_type: "exactMatch", valid_response: { score: 1, value: ["0"] } } }];
export const L0158_ACTIVITY = {
  type: "questions",
  data: {
    id: "at10-l0158",
    name: "L0158 item",
    questions: [
      { response_id: "artcompiler-mcq-x-0", type: "mcq", stimulus: "What is 7 + 5?", options: [{ label: "12", value: "0" }, { label: "13", value: "1" }], validation: { scoring_type: "exactMatch", valid_response: { score: 1, value: ["0"] } } },
      { response_id: "artcompiler-custom-x-1", type: "custom", js: { question: "https://example.org/q.js" }, data: { cells: { A1: { text: "7" } } } },
    ],
    dynamic_content_data: { cols: ["A1"], rows: { r1: { values: ["7"] } } },
  },
};
// A question as Question Editor's widget_json: the question without its
// response_id.
export const qeWidgets = activity => (activity?.data?.questions ?? activity?.questions ?? []).map(q => {
  const { response_id: _rid, ...widget } = q;
  return widget;
});
export const QE_ACTIONS = ["save", "submit"];
export const qeVariants = ({ activity = L0158_ACTIVITY } = {}) => [
  { id: "qe-single-mcq", widgets: QE_SINGLE, actions: [], detail: "one MCQ, preview-only layout, no signature" },
  { id: "qe-l0158-activity", widgets: qeWidgets(activity), actions: [], detail: "an L0158-shaped activity's questions, one editor each" },
  { id: "qe-preview-save", widgets: QE_SINGLE, actions: QE_ACTIONS, detail: `one MCQ; after it renders, ${QE_ACTIONS.join(" then ")} through the preview's own Questions API session (questionsApp())` },
];
export const planQePreview = opts => qeVariants(opts).map(({ id, widgets, detail }) => ({ id, questions: widgets.length, detail }));

// What each case needs, and whether it touches the sandbox beyond signing.
export const caseNeeds = (name, { signer = "broker", expires = [] } = {}) => {
  if (name === "qe-preview") {
    return { signer: "none (unsigned)", raw: false, key: true, broker: false, browser: true, sandboxWrites: null };
  }
  const raw = signer === "raw" || expires.length > 0 || name === "drafts" || name === "separation";
  return {
    signer,
    raw,
    key: raw,
    broker: signer !== "raw" || name === "caches" || name === "drafts",
    browser: !["drafts", "caches"].includes(name),
    sandboxWrites: name === "drafts"
      ? "creates, publishes and removes fixture items, questions and an activity"
      : name === "scope"
        ? "one submit_practice run stores a response in the sandbox"
        : name === "rotation"
          ? "the operator rotates the sandbox consumer's secret"
          : name === "separation" ? "creates one published fixture item and question, archived after" : null,
  };
};

export const planCase = (name, opts = {}) => {
  const { api = "questions", ages = DEFAULT_AGES, expires = [], types, states, probe, signer = "broker", afterExpiry } = opts;
  const steps = {
    scope: () => planScope({ types, states, api, store: opts.store !== false }),
    integrity: () => planIntegrity(),
    acceptance: () => planAcceptance({ ages, expires, t0: opts.t0 ?? Date.now() }),
    session: () => planSession({ expires, probe, signer, afterExpiry }),
    replay: () => planReplay(),
    rotation: () => [
      { id: "pre-rotation", detail: "sign an unused request; sign and initialise an established session; probe it" },
      { id: "operator", detail: "rotate the sandbox consumer's secret, then confirm on stdin" },
      { id: "after-rotation", detail: "initialise the unused pre-rotation request; probe the established session; sign a fresh control with the old secret" },
    ],
    drafts: () => Object.entries(DRAFT_CASES).map(([id, detail]) => ({ id: `draft-${id}`, detail })),
    caches: () => [
      { id: "data-system", detail: "GET /data?id=<L0176 preview task> as the canary user (system preview)" },
      { id: "data-connection", detail: "GET /data?id=<task>&connection=<canary connection>" },
      { id: "compile", detail: "POST /compile of the preview program through the connection" },
      { id: "preview-sign", detail: "POST /preview/sign (system preview, anonymous)" },
    ],
    "qe-preview": () => planQePreview({ activity: opts.qeActivity }),
    separation: () => planSeparation(),
  }[name];
  if (!steps) throw new HarnessRefused(`unknown case ${name} (${CASES.join(", ")})`);
  return { case: name, api, needs: caseNeeds(name, { signer: opts.signer, expires }), steps: steps() };
};

// --- Evidence -----------------------------------------------------------------

// Facts only, written whole after every step (atomically), so a long run can
// be followed and resumed. Every write is scanned first.
export const createEvidence = ({ file, fs, secrets = [], initial }) => {
  const data = initial;
  let chain = Promise.resolve();
  const save = () => {
    chain = chain.then(async () => {
      assertFactsOnly(data, secrets);
      await fs.mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
      await fs.rename(tmp, file);
    });
    return chain;
  };
  return { data, save, file };
};

// --- Fixture manifest -----------------------------------------------------------

// Every record the drafts case creates is entered here BEFORE it is created,
// so --cleanup can remove what a crashed run left behind.
const REMOVE_ORDER = ["activity", "item", "question"];
export const createManifest = ({ file, fs }) => {
  let state = null;
  const load = async () => {
    if (state) return state;
    try { state = JSON.parse(await fs.readFile(file, "utf8")); } catch (e) {
      if (e.code !== "ENOENT") throw e;
      state = { entries: [] };
    }
    return state;
  };
  const persist = async () => {
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
    await fs.rename(`${file}.tmp`, file);
  };
  return {
    file,
    load,
    record: async (runId, kind, reference, by) => {
      await load();
      if (!state.entries.some(e => e.reference === reference && e.kind === kind && e.removed === null)) {
        state.entries.push({ runId, kind, reference, by, createdAt: new Date().toISOString(), removed: null, reason: null });
        await persist();
      }
    },
    // Removes every entry not yet removed (for `runId`, or all), activities
    // first, then items, then questions. Returns facts.
    cleanup: async (dataApi, { runId = null } = {}) => {
      await load();
      const out = [];
      for (const kind of REMOVE_ORDER) {
        const pending = state.entries.filter(e => e.kind === kind && e.removed === null && (runId === null || e.runId === runId));
        for (const entry of pending) {
          const res = await dataApi.remove(kind, [entry.reference]);
          entry.removed = res.removed;
          entry.reason = res.removed ? null : (res.reason ?? "not removed");
          entry.removedAt = res.removed ? new Date().toISOString() : null;
          out.push({ kind, reference: entry.reference, removed: entry.removed, reason: entry.reason });
        }
        if (pending.length) await persist();
      }
      return { removed: out.filter(o => o.removed).length, failed: out.filter(o => !o.removed).length, records: out };
    },
    pending: async () => (await load()).entries.filter(e => e.removed === null),
  };
};

// --- Cache-Control -----------------------------------------------------------------

// A response that can carry a signed request must not be stored anywhere:
// Cache-Control must say no-store, and must not say public, immutable or a
// positive max-age / s-maxage.
export const cacheVerdict = ({ cacheControl, carriesSignedRequest }) => {
  const cc = String(cacheControl ?? "").toLowerCase();
  const noStore = /(^|[\s,])no-store($|[\s,])/.test(cc);
  const storable = /(^|[\s,])(public|immutable)($|[\s,])/.test(cc) || /(s-)?max-age=\s*[1-9]/.test(cc);
  return { noStore, storable, ok: carriesSignedRequest ? noStore && !storable : true };
};

export const checkCaches = async ({ http, apiUrl, userToken, connectionId, parse }) => {
  const asUser = { Authorization: userToken };
  const facts = [];
  const look = async (id, req) => {
    let res;
    try {
      res = await http(req);
    } catch (e) {
      facts.push({ id, route: `${req.method} ${new URL(req.url).pathname}`, error: String(e?.message ?? e).slice(0, 200), ok: false });
      return;
    }
    const cacheControl = res.headers?.["cache-control"] ?? null;
    const carriesSignedRequest = hasSignedRequest(res.json);
    facts.push({
      id,
      route: `${req.method} ${new URL(req.url).pathname}`,
      status: res.status,
      cacheControl,
      cdnCacheControl: res.headers?.["cdn-cache-control"] ?? null,
      surrogateControl: res.headers?.["surrogate-control"] ?? null,
      carriesSignedRequest,
      ...cacheVerdict({ cacheControl, carriesSignedRequest }),
    });
  };
  const task = await http({ method: "POST", url: `${apiUrl}/task`, headers: asUser, body: { task: { lang: "0176", code: await parse(PREVIEW_PROGRAM) } } });
  const taskId = task.json?.data?.id;
  if (typeof taskId !== "string") throw new Error(`POST /task: ${task.status}`);
  await look("data-system", { method: "GET", url: `${apiUrl}/data?id=${encodeURIComponent(taskId)}`, headers: asUser });
  await look("data-connection", { method: "GET", url: `${apiUrl}/data?id=${encodeURIComponent(taskId)}&connection=${encodeURIComponent(connectionId)}`, headers: asUser });
  await look("compile", { method: "POST", url: `${apiUrl}/compile`, headers: asUser, body: { id: taskId, data: {}, connectionId, idempotencyKey: `at10:caches:${randomBytes(4).toString("hex")}` } });
  await look("preview-sign", {
    method: "POST",
    url: `${apiUrl}/preview/sign`,
    body: { activity: { type: "questions", data: { id: "at10-caches", questions: [{ type: "mcq", response_id: "at10-caches-0", stimulus: "AT-10", options: [{ label: "A", value: "0" }] }] } } },
  });
  return { taskId, routes: facts, ok: facts.every(f => f.ok) };
};

// Read-only Firestore scan (Jeff's credentials): any `signature` field, or a
// signed request, in the documents that hold compiled output, artifacts and
// publications. Prints counts and paths only.
// listPage(db, collection, afterId, limit) -> [{ id, data }], ordered by id
export const signaturePaths = (value, at = "") => {
  const out = [];
  const walk = (v, p) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        const here = p ? `${p}.${k}` : k;
        if (k === "signature") out.push(here);
        else walk(x, here);
      }
      return;
    }
    if (typeof v === "string") {
      if (SIGNATURE_RE.test(v)) out.push(`${p} (signature text)`);
      else if ((v.includes("\"signature\"") || v.includes("\"security\"")) && hasSignedRequest(v)) out.push(`${p} (signed request text)`);
    }
  };
  walk(value, at);
  return out;
};
export const SCAN_COLLECTIONS = [
  { db: "api", collection: "compiles" },
  { db: "api", collection: "artifacts" },
  { db: "api", collection: "artifact-heads" },
  { db: "policy", collection: "publications" },
];
export const scanDocuments = async ({ listPage, collections = SCAN_COLLECTIONS, pageSize = 300, log = () => {} }) => {
  const result = [];
  for (const { db, collection } of collections) {
    let after = null;
    let scanned = 0;
    const hits = [];
    for (;;) {
      const page = await listPage(db, collection, after, pageSize);
      for (const doc of page) {
        scanned++;
        const paths = signaturePaths(doc.data);
        if (paths.length) hits.push({ doc: `${collection}/${doc.id}`, fields: paths.slice(0, 10) });
      }
      if (page.length < pageSize) break;
      after = page[page.length - 1].id;
      log(`  ${db}:${collection} ${scanned} scanned`);
    }
    result.push({ db, collection, scanned, withSignature: hits.length, hits });
  }
  return { collections: result, ok: result.every(c => c.withSignature === 0) };
};

// --- Cases ---------------------------------------------------------------------------

// ctx: { signer, browser, dataApi, saver, runId, api, log, now, sleep, prompt,
//        evidence, opts }. Each case returns a facts object.
let counter = 0;
const nextN = () => ++counter;
const payloadFor = (ctx, overrides) => previewPayload(ctx.runId, nextN(), overrides);

// Sign one fresh request and initialise it in its own browser context.
const freshInit = async (ctx, { api = ctx.api, mutate = null, at, signOpts = {}, name, payload } = {}) => {
  const signed = await ctx.signer.sign(api, payload ?? payloadFor(ctx), signOpts);
  const context = await ctx.browser.newContext();
  try {
    const session = await context.open({ signed, mutate, at, name });
    return session.init;
  } finally {
    await context.close();
  }
};
const control = (ctx, name) => freshInit(ctx, { name: `${name}-control` });

export const scopeCase = async ctx => {
  const { opts = {} } = ctx;
  const results = [];
  for (const step of planScope({ types: opts.types, states: opts.states, api: ctx.api, store: opts.store !== false })) {
    const fns = [];
    if (step.change.type) fns.push(setField("type", step.change.type));
    if (step.change.state) fns.push(setField("state", step.change.state));
    if (step.change.questions) fns.push(TAMPERS.questions);
    let sessionId = null;
    if (step.change.session_id) {
      sessionId = randomUUID();
      fns.push(setField("session_id", sessionId));
    }
    if (!step.action) {
      results.push({ id: step.id, change: step.change, signedType: "local_practice", init: await freshInit(ctx, { mutate: compose(...fns), name: step.id }) });
      continue;
    }
    // Can a modified Questions session store responses?
    const signed = await ctx.signer.sign(ctx.api, payloadFor(ctx));
    const context = await ctx.browser.newContext();
    try {
      const session = await context.open({ signed, mutate: compose(...fns), name: step.id });
      const action = session.init.ready ? await session.action(step.action) : { outcome: "not-initialised" };
      const readBack = ctx.dataApi ? await ctx.dataApi.responses([sessionId]) : { ok: false, reason: "no raw Data API credentials (LRN_SANDBOX_*)" };
      results.push({ id: step.id, change: step.change, signedType: "local_practice", sessionId, init: session.init, action, readBack, stored: readBack.ok ? readBack.sessions > 0 || readBack.responses > 0 : null });
    } finally {
      await context.close();
    }
  }
  // Every Learnosity request each session made, init and actions alike.
  const seen = results.flatMap(r => [...(r.init?.network ?? []), ...(r.action?.network ?? [])]);
  const bank = itemBankCalls(seen);
  return { case: "scope", api: ctx.api, control: await control(ctx, "scope"), results, requestsSeen: seen.length, itemBankCalls: bank, noItemBankCalls: bank.length === 0 };
};

export const integrityCase = async ctx => {
  const results = [];
  for (const step of planIntegrity()) {
    const init = step.field === "origin"
      ? await freshInit(ctx, { at: ctx.opts?.foreignOrigin ?? FOREIGN_ORIGIN, name: step.id })
      : await freshInit(ctx, { mutate: TAMPERS[step.field], name: step.id });
    results.push({ id: step.id, field: step.field, accepted: init.ready, init });
  }
  return {
    case: "integrity",
    api: ctx.api,
    expected: ctx.api === "items" ? "every tamper refused (the request is signed)" : "request-body changes accepted (only the security packet is signed)",
    control: await control(ctx, "integrity"),
    results,
  };
};

// Long: runs until the last age. The plan and each result are written to the
// evidence as they happen. Signed requests are never written, so a resumed
// run re-signs what was still pending, as a new batch measured from its own
// signing time; finished steps are kept.
export const acceptanceCase = async ctx => {
  const { opts = {}, now = Date.now, sleep } = ctx;
  const prior = opts.resume?.case === "acceptance" ? opts.resume : null;
  const ages = opts.ages ?? DEFAULT_AGES;
  const expires = opts.expires ?? [];
  const record = ctx.evidence?.data ?? {};
  record.acceptance = prior ?? { case: "acceptance", api: ctx.api, batches: [], steps: [] };
  const state = record.acceptance;
  const done = new Set(state.steps.filter(s => s.status === "done").map(s => s.id));
  const t0 = now();
  const steps = planAcceptance({ ages, expires, t0 }).filter(s => !done.has(s.id));
  const batch = state.batches.length + 1;
  state.batches.push({ batch, t0: new Date(t0).toISOString(), steps: steps.map(s => s.id) });
  for (const s of state.steps) if (s.status === "planned" && !done.has(s.id)) s.status = "lost (resumed; re-signed)";
  // Sign every step's request now, at t0.
  const signed = new Map();
  for (const s of steps) {
    const expiresAt = s.expiresMs ? t0 + s.expiresMs : null;
    signed.set(s.id, await ctx.signer.sign(ctx.api, payloadFor(ctx), { expires: expiresAt }));
    state.steps.push({ ...s, batch, status: "planned" });
  }
  await ctx.evidence?.save();
  for (const s of steps) {
    const wait = Date.parse(s.initAt) - now();
    if (wait > 0) {
      ctx.log(`acceptance: ${s.id} initialises at ${s.initAt} (in ${Math.round(wait / 1000)} s)`);
      await sleep(wait);
    }
    const entry = state.steps.find(x => x.id === s.id && x.batch === batch);
    // A failure in one step (the browser, or the control's signing) is
    // recorded, and the series goes on: it runs unattended for a day.
    try {
      const context = await ctx.browser.newContext();
      try {
        const session = await context.open({ signed: signed.get(s.id), name: s.id });
        entry.result = session.init;
      } finally {
        await context.close();
      }
      entry.control = await control(ctx, s.id);
      entry.accepted = entry.result.ready;
      entry.status = "done";
    } catch (e) {
      entry.status = "error";
      entry.error = String(e?.message ?? e).slice(0, 300);
    }
    signed.delete(s.id);
    await ctx.evidence?.save();
  }
  return state;
};

// Opens `signed` in `context` and readies it for `probe`: for isvalid, types
// PROBE_RESPONSE into its question first. -> { session, responseId, response }
const openForProbe = async (context, signed, { name, probe, responseId }) => {
  const session = await context.open({ signed, name });
  const response = probe === "isvalid" && session.init.ready ? await session.enterResponse(responseId, PROBE_RESPONSE) : null;
  return { session, response };
};
const probeRequest = (ctx, probe, type) => {
  const payload = probe === "isvalid" ? probePayload(ctx.runId, nextN()) : payloadFor(ctx, { type });
  return { payload, responseId: payload.questions[0].response_id };
};

// The established-session lifetime (plan step 6's row): one request, one
// page. The probe runs shortly after initialising, and again once the
// request's expires + afterExpiry has passed; then a control signed fresh at
// that moment, in its own context, runs the same probe. A probe that made no
// server call is "probe-unconfirmed", never an expiry result.
export const sessionCase = async ctx => {
  const { opts = {}, now = Date.now, sleep } = ctx;
  const probe = opts.probe ?? DEFAULT_PROBE;
  const afterExpiry = opts.afterExpiry ?? DEFAULT_AFTER_EXPIRY;
  const afterMs = parseDuration(afterExpiry);
  const settleMs = parseDuration(opts.probeSettle ?? "5s");
  const type = opts.sessionType ?? "local_practice";
  const plan = planSession({ expires: opts.expires ?? [], probe, signer: ctx.signer.kind === "raw" ? "raw" : "broker", afterExpiry });
  const record = ctx.evidence?.data ?? {};
  record.session = { case: "session", api: ctx.api, probe, signer: ctx.signer.kind, afterExpiry, series: [] };
  for (const series of plan) {
    const t0 = now();
    const { payload, responseId } = probeRequest(ctx, probe, type);
    const signed = await ctx.signer.sign(ctx.api, payload, { expires: series.expiresMs === null ? null : t0 + series.expiresMs });
    const expiresAt = parseExpires(signed.meta.expires);
    const out = {
      id: series.id,
      request: signed.meta.id,
      signedAt: signed.meta.signedAt,
      expires: expiresAt === null ? null : new Date(expiresAt).toISOString(),
      expiresSource: series.expiresMs === null ? "broker" : `raw ${series.expires}`,
      question: payload.questions[0].type,
      probes: [],
    };
    record.session.series.push(out);
    const context = await ctx.browser.newContext();
    try {
      const { session, response } = await openForProbe(context, signed, { name: series.id, probe, responseId });
      out.init = session.init;
      out.response = response;
      await ctx.evidence?.save();
      if (!session.init.ready) {
        out.verdict = "not-initialised";
        continue;
      }
      await sleep(settleMs);
      out.probes.push({ phase: "before-expires", at: new Date(now()).toISOString(), ...(await runProbe(probe, session, { responseId })) });
      await ctx.evidence?.save();
      if (expiresAt === null) {
        out.verdict = "no-expires";
        out.note = "the signed request carries no expires, so there is no expiry to probe past";
        continue;
      }
      const until = expiresAt + afterMs;
      out.probeAfter = new Date(until).toISOString();
      const wait = until - now();
      if (wait > 0) {
        ctx.log(`session: ${series.id} probes again at ${out.probeAfter} (expires ${out.expires} + ${afterExpiry}; in ${Math.round(wait / 1000)} s)`);
        await sleep(wait);
      }
      out.probes.push({ phase: "after-expires", at: new Date(now()).toISOString(), ...(await runProbe(probe, session, { responseId })) });
      await ctx.evidence?.save();
      out.control = await probeControl(ctx, { name: `${series.id}-control`, probe, type, settleMs });
      out.verdict = sessionVerdict(out.probes[0], out.probes[1], out.control.probe);
      await ctx.evidence?.save();
    } finally {
      await context.close();
    }
  }
  return record.session;
};

// A fresh request, signed now, initialised in its own context and probed
// the same way.
const probeControl = async (ctx, { name, probe, type, settleMs }) => {
  const { payload, responseId } = probeRequest(ctx, probe, type);
  const signed = await ctx.signer.sign(ctx.api, payload);
  const context = await ctx.browser.newContext();
  try {
    const { session, response } = await openForProbe(context, signed, { name, probe, responseId });
    if (!session.init.ready) return { init: session.init, response, probe: null };
    await ctx.sleep(settleMs);
    return { init: session.init, response, probe: { at: new Date((ctx.now ?? Date.now)()).toISOString(), ...(await runProbe(probe, session, { responseId })) } };
  } finally {
    await context.close();
  }
};

export const replayCase = async ctx => {
  const { opts = {}, sleep } = ctx;
  const gapMs = parseDuration(opts.replayGap ?? "30s");
  const results = [];
  for (const step of planReplay()) {
    const signed = await ctx.signer.sign(ctx.api, payloadFor(ctx));
    const out = { id: step.id, mode: step.mode, control: await control(ctx, step.id) };
    if (step.mode === "same-browser") {
      const context = await ctx.browser.newContext();
      try {
        out.first = (await context.open({ signed, name: `${step.id}-1` })).init;
        out.second = (await context.open({ signed, name: `${step.id}-2` })).init;
      } finally {
        await context.close();
      }
    } else if (step.mode === "two-contexts") {
      const [a, b] = [await ctx.browser.newContext(), await ctx.browser.newContext()];
      try {
        const [x, y] = await Promise.all([a.open({ signed, name: `${step.id}-a` }), b.open({ signed, name: `${step.id}-b` })]);
        out.first = x.init;
        out.second = y.init;
      } finally {
        await a.close();
        await b.close();
      }
    } else {
      const a = await ctx.browser.newContext();
      try {
        out.first = (await a.open({ signed, name: `${step.id}-1` })).init;
      } finally {
        await a.close();
      }
      await sleep(gapMs);
      const b = await ctx.browser.newContext();
      try {
        out.second = (await b.open({ signed, name: `${step.id}-2` })).init;
      } finally {
        await b.close();
      }
      out.gap = opts.replayGap ?? "30s";
    }
    out.secondAccepted = out.second.ready;
    results.push(out);
  }
  return { case: "replay", api: ctx.api, results };
};

export const ROTATION_INSTRUCTIONS = [
  "Rotate the development consumer's secret now (the consumer whose key ends in LRN_SANDBOX_KEY_SUFFIX), in the Learnosity console.",
  "Do NOT update ~/.lrn-sandbox.env or the canary connection yet: the harness needs the old secret for its control.",
  "When the console shows the new secret, type  rotated  and press Enter (anything else aborts).",
];
export const ROTATION_AFTER = [
  "Rotation recorded. Now: put the new secret in ~/.lrn-sandbox.env, and rotate the canary connection's",
  "credential (console, or Policy POST /v1/connections/<id>/rotate) so the canary keeps signing.",
];

export const rotationCase = async ctx => {
  const { opts = {}, now = Date.now, sleep, prompt } = ctx;
  const probe = opts.probe ?? DEFAULT_PROBE;
  const intervals = opts.rotationIntervals ?? ["0s", "1m", "5m"];
  const unused = await ctx.signer.sign(ctx.api, payloadFor(ctx));
  const { payload, responseId } = probeRequest(ctx, probe, opts.sessionType ?? "local_practice");
  const established = await ctx.signer.sign(ctx.api, payload);
  const keep = await ctx.browser.newContext();
  const out = { case: "rotation", api: ctx.api, signer: ctx.signer.kind, keyFingerprint: ctx.signer.keyFingerprint, probe };
  try {
    const { session, response } = await openForProbe(keep, established, { name: "rotation-established", probe, responseId });
    out.established = { init: session.init, response, before: await runProbe(probe, session, { responseId }) };
    out.controlBefore = await control(ctx, "rotation-before");
    await ctx.evidence?.save();
    for (const line of ROTATION_INSTRUCTIONS) ctx.log(line);
    const answer = String(await prompt("rotated? ")).trim();
    if (answer !== "rotated") {
      out.aborted = `operator answered ${JSON.stringify(answer.slice(0, 20))}`;
      return out;
    }
    const rotatedAt = now();
    out.rotatedAt = new Date(rotatedAt).toISOString();
    const fresh = await ctx.browser.newContext();
    try {
      out.unusedPreRotation = (await fresh.open({ signed: unused, name: "rotation-unused" })).init;
    } finally {
      await fresh.close();
    }
    out.established.after = [];
    for (const i of intervals) {
      const wait = rotatedAt + parseDuration(i) - now();
      if (wait > 0) await sleep(wait);
      out.established.after.push({ after: i, ...(await runProbe(probe, session, { responseId })) });
      await ctx.evidence?.save();
    }
    // Signed with the old secret after rotation: refused means rotation took effect.
    out.oldSecretControl = await control(ctx, "rotation-old-secret");
    // The LTS name is compared; the concrete build is information (it moves
    // within an LTS). The build is the Data API's meta.versions where known.
    out.fingerprint = {
      consumerKeys: [ctx.signer.keyFingerprint].filter(Boolean),
      apiBuild: {
        lts: ctx.opts?.apiVersion ?? DEFAULT_API_VERSION,
        dataApi: ctx.dataApi?.versions?.() ?? null,
        [`${ctx.api}Js`]: { reported: out.established.init.reportedVersion, network: out.established.init.networkVersion },
      },
      signing: { signer: ctx.signer.kind, expires: null, pinned: [] },
      providerSettings: null,
      providerSettingsNote: "no authoritative snapshot read; a dated attestation from Learnosity is required (plan step 6)",
    };
    for (const line of ROTATION_AFTER) ctx.log(line);
  } finally {
    await keep.close();
  }
  return out;
};

// The records the drafts case writes. Contents are fixed test text; only
// digests and statuses go to the evidence.
const question = (reference, stimulus) => ({ type: "mcq", reference, data: { type: "mcq", stimulus, options: [{ label: "A", value: "0" }, { label: "B", value: "1" }], validation: { scoring_type: "exactMatch", valid_response: { score: 1, value: ["0"] } } } });
const item = (reference, questionRefs, status = "unpublished") => ({ reference, status, definition: { widgets: questionRefs.map(r => ({ reference: r })) }, questions: questionRefs.map(r => ({ reference: r })) });
const contentOf = row => {
  if (!row) return null;
  const data = structuredClone(row.data ?? row);
  if (data?.metadata) delete data.metadata.gc_operation;
  return digestOf(data);
};
const markOf = row => row?.data?.metadata?.gc_operation ?? row?.metadata?.gc_operation ?? null;

export const draftsCase = async ctx => {
  const { dataApi, saver, manifest, runId, signer } = ctx;
  if (!dataApi) throw new HarnessRefused("the drafts case needs the raw sandbox credential for its fixtures and read-backs");
  const ref = s => `at10-${runId}-${s}`;
  const by = saver.kind ?? "broker";
  const track = async (kind, reference, who = by) => manifest.record(runId, kind, reference, who);
  const readQ = async reference => (await dataApi.get("question", [reference])).rows.get(reference) ?? null;
  const readI = async reference => (await dataApi.get("item", [reference])).rows.get(reference) ?? null;
  const readA = async reference => (await dataApi.get("activity", [reference])).rows.get(reference) ?? null;
  const fixture = async tag => {
    const [q, i, a] = [ref(`${tag}-q0`), ref(tag), ref(`${tag}-act`)];
    await track("question", q, "raw");
    await track("item", i, "raw");
    await track("activity", a, "raw");
    const steps = [
      await dataApi.set("question", [question(q, "AT-10 published fixture")]),
      await dataApi.set("item", [item(i, [q], "published")]),
      await dataApi.set("activity", [{ reference: a, status: "published", data: { items: [i] } }]),
    ];
    const failed = steps.find(s => !s.ok);
    if (failed) throw new Error(`fixture ${tag}: ${failed.reason}`);
    return { q, i, a, before: { question: contentOf(await readQ(q)), questionMark: markOf(await readQ(q)), itemStatus: (await readI(i))?.status ?? null, activityStatus: (await readA(a))?.status ?? null } };
  };
  const after = async fx => {
    const q = await readQ(fx.q);
    return { question: contentOf(q), questionMark: markOf(q), itemStatus: (await readI(fx.i))?.status ?? null, activityStatus: (await readA(fx.a))?.status ?? null };
  };
  const writeOf = w => ({ status: w.status, steps: w.steps, reason: w.reason ?? null });
  // From registry v8 Broker writes under references of its own (gc-…), and
  // returns them. Each is recorded for cleanup, and the case reads back what
  // was written; `sent` is what the payload named (a raw save writes those).
  const written = async (w, { items = [], questions = [] }) => {
    const qs = w?.questionReferences ?? (items.length ? null : w?.references) ?? questions;
    const is = items.length ? (w?.references ?? items) : [];
    for (const r of qs ?? []) if (!questions.includes(r)) await track("question", r);
    for (const r of is) if (!items.includes(r)) await track("item", r);
    return { items: is, questions: qs ?? [] };
  };
  const results = {};
  try {
    // (a)
    {
      const [q, i] = [ref("a-q0"), ref("a")];
      await track("question", q);
      await track("item", i);
      const w = await saver.write({ questionRecords: [question(q, "AT-10 draft a")], itemRecords: [item(i, [q])] });
      const at = await written(w, { items: [i], questions: [q] });
      const row = await readI(at.items[0] ?? i);
      results.a = { write: writeOf(w), reference: at.items[0] === i ? "as sent" : "mapped", itemStatus: row?.status ?? null, unpublished: row?.status === "unpublished", sentReferenceUntouched: at.items[0] === i ? null : !(await readI(i)) };
    }
    // (b)
    {
      const q = ref("b-q0");
      await track("question", q);
      const w = await saver.write({ questionRecords: [question(q, "AT-10 question only")], itemRecords: [] });
      const at = await written(w, { questions: [q] });
      results.b = { write: writeOf(w), reference: at.questions[0] === q ? "as sent" : "mapped", questionStored: Boolean(await readQ(at.questions[0] ?? q)), accepted: w.status === "succeeded" };
    }
    // (c)
    {
      const fx = await fixture("fxc");
      const draft = ref("c");
      await track("item", draft);
      const w = await saver.write({ questionRecords: [question(fx.q, "AT-10 overwritten by a draft save")], itemRecords: [item(draft, [fx.q])] });
      await written(w, { items: [draft], questions: [fx.q] });
      const now = await after(fx);
      results.c = { write: writeOf(w), before: fx.before, after: now, publishedContentChanged: now.question !== fx.before.question, publishedItemStatusChanged: now.itemStatus !== fx.before.itemStatus };
    }
    // (d)
    {
      const fx = await fixture("fxd");
      // An item reference Broker accepts (<= 250 characters) but Learnosity
      // is expected to refuse, so the item step fails after the question step.
      const bad = ref("d-").padEnd(250, "x");
      await track("item", bad);
      const w = await saver.write({ questionRecords: [question(fx.q, "AT-10 overwritten, item write fails")], itemRecords: [item(bad, [fx.q])] });
      await written(w, { items: [bad], questions: [fx.q] });
      const now = await after(fx);
      results.d = { write: writeOf(w), itemStepFailed: Array.isArray(w.steps) ? !w.steps.includes("items") : null, before: fx.before, after: now, publishedContentChanged: now.question !== fx.before.question };
      if (results.d.itemStepFailed === false) results.d.inconclusive = "Learnosity accepted the item; the failure after the question write wasn't produced";
    }
    // (e) Graffiticode's own references: the gateway save (L0176 chooses
    // them), else the same stable references written twice through Broker.
    {
      let refs = null;
      let path = "direct";
      if (signer?.gatewaySave && saver.kind !== "raw") {
        const src = `set-var "lrn-id" "at10-${runId}" ${SAVE_PROGRAM.replace(/^set-var "lrn-id" "canary" /, "")}`;
        const first = await signer.gatewaySave(src, `at10:${runId}:e1`);
        if (first.references.length) {
          refs = { items: first.references, questions: first.questionReferences };
          path = "gateway";
          for (const r of refs.items) await track("item", r, "gateway");
          for (const r of refs.questions) await track("question", r, "gateway");
          results.e = { path, first: { httpStatus: first.httpStatus, errors: first.errors } };
          const pubE = await dataApi.setStatus("item", refs.items, "published");
          results.e.publish = { ok: pubE.ok, reason: pubE.reason };
          const published = { status: (await readI(refs.items[0]))?.status ?? null, mark: markOf(await readQ(refs.questions[0])) };
          const second = await signer.gatewaySave(src, `at10:${runId}:e2`);
          for (const r of second.references) if (!refs.items.includes(r)) await track("item", r, "gateway");
          for (const r of second.questionReferences) if (!refs.questions.includes(r)) await track("question", r, "gateway");
          const q = await readQ(refs.questions[0]);
          results.e = { ...results.e, second: { httpStatus: second.httpStatus, errors: second.errors }, published, itemStatusAfter: (await readI(refs.items[0]))?.status ?? null, questionRewritten: markOf(q) !== published.mark };
        } else {
          results.e = { gatewayNote: `the gateway save returned no references (${first.httpStatus} ${first.errors.join(",")}); used Broker directly` };
        }
      }
      if (!refs) {
        const [q, i] = [ref("e-q0"), ref("e")];
        await track("question", q);
        await track("item", i);
        const w1 = await saver.write({ questionRecords: [question(q, "AT-10 e v1")], itemRecords: [item(i, [q])] });
        // What the first save wrote (mapped from v8): that is what's published.
        const at1 = await written(w1, { items: [i], questions: [q] });
        const [pi, pq] = [at1.items[0] ?? i, at1.questions[0] ?? q];
        const pub = await dataApi.setStatus("item", [pi], "published");
        const atPublish = { status: (await readI(pi))?.status ?? null, question: contentOf(await readQ(pq)), mark: markOf(await readQ(pq)) };
        const w2 = await saver.write({ questionRecords: [question(q, "AT-10 e v2")], itemRecords: [item(i, [q])] });
        await written(w2, { items: [i], questions: [q] });
        const qAfter = await readQ(pq);
        results.e = { ...(results.e ?? {}), path, first: writeOf(w1), publish: { ok: pub.ok, reason: pub.reason }, atPublish, second: writeOf(w2), itemStatusAfter: (await readI(pi))?.status ?? null, questionContentChanged: contentOf(qAfter) !== atPublish.question };
      }
      // Only meaningful if the item really was published before the second save.
      const wasPublished = (results.e.published?.status ?? results.e.atPublish?.status) === "published";
      results.e.publishedBeforeSecondSave = wasPublished;
      results.e.publishedItemUnchanged = wasPublished
        ? results.e.itemStatusAfter === "published" && results.e.questionRewritten !== true && results.e.questionContentChanged !== true
        : "inconclusive (the item was never published)";
    }
    // (f) A save whose item reference is an already-published item's, with a
    // fresh question: Set Items upserts, and Broker forces "unpublished".
    {
      const fx = await fixture("fxf");
      const q = ref("f-q0");
      await track("question", q);
      const w = await saver.write({ questionRecords: [question(q, "AT-10 f")], itemRecords: [item(fx.i, [q])] });
      await written(w, { items: [fx.i], questions: [q] });
      const now = await after(fx);
      const row = await readI(fx.i);
      results.f = {
        write: writeOf(w),
        before: fx.before,
        after: now,
        itemStatusAfter: row?.status ?? null,
        itemUnpublished: fx.before.itemStatus === "published" && row?.status === "unpublished",
        itemQuestionsAfter: Array.isArray(row?.questions) ? row.questions.map(x => x?.reference).filter(Boolean) : null,
      };
    }
  } finally {
    results.cleanup = await manifest.cleanup(dataApi, { runId });
  }
  return { case: "drafts", saver: by, results };
};

export const cachesCase = async ctx => ({ case: "caches", ...(await checkCaches(ctx.caches)) });

// A4: does the Question Editor preview render inline JSON with no signature,
// does validation work, and does anything look like storage or carry a
// signature? Signs nothing; the consumer key goes only to the page.
export const qePreviewCase = async ctx => {
  if (!ctx.consumerKey) throw new HarnessRefused("the Question Editor preview needs the sandbox consumer key (LRN_SANDBOX_KEY)");
  const results = [];
  for (const v of qeVariants({ activity: ctx.opts?.qeActivity ?? L0158_ACTIVITY })) {
    const context = await ctx.browser.newContext();
    try {
      const questions = [];
      for (const [index, widget] of v.widgets.entries()) {
        questions.push({ index, ...(await context.openQe({ consumerKey: ctx.consumerKey, widget, name: `${v.id}-${index}`, actions: v.actions })) });
      }
      const actions = questions.flatMap(q => q.actions);
      results.push({
        id: v.id,
        questions,
        allRendered: questions.every(q => q.rendered),
        ...(v.actions.length ? { actions: actions.map(a => ({ action: a.action, outcome: a.outcome, error: a.error ?? null, requests: a.network.length, storageLike: a.storageLikeRequests?.length ?? 0 })) } : {}),
      });
    } finally {
      await context.close();
    }
  }
  const all = results.flatMap(r => r.questions);
  return {
    case: "qe-preview",
    signed: false,
    consumerKey: keyFingerprint(ctx.consumerKey),
    rendered: all.filter(q => q.rendered).length,
    of: all.length,
    results,
    storageLikeRequests: all.flatMap(q => q.storageLikeRequests),
    anyRequestMentionsSignature: all.some(q => q.anyRequestMentionsSignature),
  };
};

// --- Service separation (plan rev 8) -------------------------------------------
//
// Every Learnosity consumer can write to its item bank, so a Questions
// preview signature must not be usable with any other service. The Questions
// API signs only the security packet; the Items, Author and Data APIs also sign
// the request (and the Data API its action). This presents a Questions
// preview's security packet, unchanged, to each of them, beside a control of
// the same request signed properly for that service. Reads only: a Data API
// get, an Items API local_practice init with no items, an Author API item list.
const SECURITY_FIELDS = ["consumer_key", "domain", "timestamp", "expires", "user_id", "signature"];
// A Questions request carries no `domain` (the browser supplies it), but its
// signature covers the signer's domain, which a holder knows: it's added.
export const securityPacket = (request, domain = undefined) => ({
  ...Object.fromEntries(SECURITY_FIELDS.filter(f => request?.[f] !== undefined).map(f => [f, request[f]])),
  ...(request?.domain === undefined && domain ? { domain } : {}),
});
export const SEPARATION_TARGETS = Object.freeze([
  { id: "data-get", service: "data", request: { limit: 1 }, detail: "Data API get /itembank/items, limit 1" },
  { id: "data-get-no-request", service: "data", request: null, detail: "Data API get /itembank/items with no request" },
  { id: "items-init", service: "items", request: "items", detail: "Items API init, local_practice, one published fixture item" },
  { id: "author-init", service: "author", request: "author", detail: "Author API init, item_list" },
]);
export const planSeparation = () => SEPARATION_TARGETS.map(({ id, detail }) => ({ id, detail: `${detail}: the Questions preview's packet must be refused; a control signed for the service accepted` }));
const separationRequest = (target, userId, itemRef) => {
  if (target.request === "items") return { activity_id: "at10-separation", name: "AT-10 separation", rendering_type: "inline", type: "local_practice", session_id: randomUUID(), user_id: userId, items: [itemRef] };
  if (target.request === "author") return { mode: "item_list", user: { id: userId } };
  return target.request;
};
// One Data API call with a given security packet; accepted only on Learnosity's success.
const dataAttempt = async (ctx, security, request) => {
  const body = new URLSearchParams({ security: JSON.stringify(security), action: "get", ...(request === null ? {} : { request: JSON.stringify(request) }) });
  let res;
  try {
    res = await ctx.fetch(`${DATA_API}/itembank/items`, { method: "POST", body, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    return { accepted: null, status: null, reason: `network: ${e?.name ?? "error"}` };
  }
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  const accepted = res.ok && json?.meta?.status === true;
  return { accepted, status: res.status, reason: accepted ? null : ctx.redactKeys(String(json?.meta?.message ?? `HTTP ${res.status}`)).slice(0, 300) };
};
const browserAttempt = async (ctx, api, value, name) => {
  const context = await ctx.browser.newContext();
  try {
    const session = await context.open({ signed: new SignedRequest(api, value, { signer: "separation" }), name });
    return { accepted: session.init.ready, errors: session.init.errors, network: session.init.network };
  } finally {
    await context.close();
  }
};
export const separationVerdict = (attempt, control) =>
  attempt.accepted === true ? "ACCEPTED" : attempt.accepted === false && control.accepted === true ? "refused" : "inconclusive";

export const separationCase = async ctx => {
  if (!ctx.rawInit || !ctx.dataApi) throw new HarnessRefused("separation needs the raw sandbox credential for its controls (LRN_SANDBOX_*)");
  const signed = await ctx.signer.sign("questions", payloadFor(ctx));
  const packet = securityPacket(unseal(signed), ctx.signer.domain ?? new URL(ORIGIN).hostname);
  // A provider message may echo a key: never into the evidence.
  ctx = { ...ctx, redactKeys: createRedactor([packet.consumer_key, ctx.consumerKey].filter(Boolean)) };
  // The Items API renders only published items: one fixture, archived after.
  const fixtureQ = `at10-${ctx.runId}-sep-q0`;
  const fixtureI = `at10-${ctx.runId}-sep`;
  await ctx.manifest.record(ctx.runId, "question", fixtureQ, "raw");
  await ctx.manifest.record(ctx.runId, "item", fixtureI, "raw");
  const results = [];
  try {
    for (const step of [await ctx.dataApi.set("question", [question(fixtureQ, "AT-10 separation fixture")]), await ctx.dataApi.set("item", [item(fixtureI, [fixtureQ], "published")])]) {
      if (!step.ok) throw new Error(`separation fixture: ${step.reason}`);
    }
    await separationTargets(ctx, packet, fixtureI, results);
  } finally {
    ctx.cleanup = await ctx.manifest.cleanup(ctx.dataApi, { runId: ctx.runId });
  }
  return separationOutcome(ctx, signed, packet, results);
};

const separationTargets = async (ctx, packet, itemRef, results) => {
  for (const target of SEPARATION_TARGETS) {
    const request = separationRequest(target, packet.user_id, itemRef);
    let attempt;
    let control;
    if (target.service === "data") {
      attempt = await dataAttempt(ctx, packet, request);
      const res = await ctx.dataApi.call("/itembank/items", "get", request ?? {});
      control = { accepted: res.ok, reason: res.reason };
    } else {
      attempt = await browserAttempt(ctx, target.service, { security: packet, request: structuredClone(request) }, target.id);
      control = await browserAttempt(ctx, target.service, ctx.rawInit(target.service, request), `${target.id}-control`);
    }
    results.push({ id: target.id, service: target.service, attempt, control, verdict: separationVerdict(attempt, control) });
    ctx.log(`   ${target.id}: ${results.at(-1).verdict}`);
  }
};

const separationOutcome = (ctx, signed, packet, results) => {
  const accepted = results.filter(r => r.verdict === "ACCEPTED").map(r => r.id);
  return {
    case: "separation",
    packetSigner: signed.meta.signer,
    packetConsumer: keyFingerprint(packet.consumer_key),
    controlConsumer: keyFingerprint(ctx.consumerKey),
    results,
    cleanup: ctx.cleanup,
    separated: accepted.length === 0 && results.every(r => r.verdict === "refused"),
    accepted,
    conclusion: accepted.length
      ? `A3 FAILS: a Questions preview signature was accepted by ${accepted.join(", ")}`
      : results.every(r => r.verdict === "refused") ? "every other service refused the Questions preview signature" : "inconclusive: a control failed, so a refusal there proves nothing",
  };
};

export const CASE_FNS = { scope: scopeCase, integrity: integrityCase, acceptance: acceptanceCase, session: sessionCase, replay: replayCase, rotation: rotationCase, drafts: draftsCase, caches: cachesCase, "qe-preview": qePreviewCase, separation: separationCase };

// --- The CLI -------------------------------------------------------------------------

export const USAGE = `usage: node scripts/at10-provider.js <case...> [--run] [--signer broker|raw] [--system]
         [--api questions|items] [--api-version ${DEFAULT_API_VERSION}] [--data-api-version ${DEFAULT_DATA_API_VERSION}]
         [--ages 1m,5m,15m,30m,60m,6h,24h] [--expires 5m,15m] [--types ...] [--states ...]
         [--probe isvalid|save|submit] [--after-expiry 60s] [--probe-settle 5s] [--session-type local_practice|submit_practice]
         [--replay-gap 30s] [--rotation-intervals 0s,1m,5m] [--qe-activity <file.json>]
         [--out <file>] [--resume <file>] [--manifest <file>] [--chromium <path>] [--headed]
       node scripts/at10-provider.js --cleanup [--run]
       node scripts/at10-provider.js --scan-documents [--run]
cases: ${CASES.join(", ")}, or all. Without --run it prints the plan and touches nothing.`;

export const parseArgs = argv => {
  const opts = { cases: [], run: false, signer: "broker", system: false, api: "questions", apiVersion: DEFAULT_API_VERSION, dataApiVersion: DEFAULT_DATA_API_VERSION, ages: DEFAULT_AGES, expires: [], probe: DEFAULT_PROBE };
  const VALUE = {
    "--signer": v => { opts.signer = v; },
    "--api": v => { opts.api = v; },
    "--api-version": v => { opts.apiVersion = v; },
    "--data-api-version": v => { opts.dataApiVersion = v; },
    "--ages": v => { opts.ages = parseList(v); },
    "--expires": v => { opts.expires = parseList(v); },
    "--types": v => { opts.types = parseList(v); },
    "--states": v => { opts.states = parseList(v); },
    "--after-expiry": v => { opts.afterExpiry = v; },
    "--probe-settle": v => { opts.probeSettle = v; },
    "--rotation-intervals": v => { opts.rotationIntervals = parseList(v); },
    "--probe": v => { opts.probe = v; },
    "--session-type": v => { opts.sessionType = v; },
    "--replay-gap": v => { opts.replayGap = v; },
    "--qe-activity": v => { opts.qeActivityFile = v; },
    "--out": v => { opts.out = v; },
    "--resume": v => { opts.resumeFile = v; },
    "--manifest": v => { opts.manifest = v; },
    "--foreign-origin": v => { opts.foreignOrigin = v; },
    "--chromium": v => { opts.chromium = v; },
    "--uid": v => { opts.uid = v; },
    "--connection": v => { opts.connectionId = v; },
  };
  const FLAG = { "--run": "run", "--system": "system", "--cleanup": "cleanup", "--scan-documents": "scanDocuments", "--headed": "headed", "--help": "help", "--no-store": "noStore" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE[a]) {
      if (i + 1 >= argv.length) throw new HarnessRefused(`${a} needs a value`);
      VALUE[a](argv[++i]);
    } else if (FLAG[a]) opts[FLAG[a]] = true;
    else if (a.startsWith("--")) throw new HarnessRefused(`unknown option ${a}`);
    else if (a === "all") opts.cases.push(...CASES);
    else if (CASES.includes(a)) opts.cases.push(a);
    else throw new HarnessRefused(`unknown case ${a} (${CASES.join(", ")})`);
  }
  if (!["broker", "raw"].includes(opts.signer)) throw new HarnessRefused("--signer must be broker or raw");
  if (opts.system && opts.signer !== "broker") throw new HarnessRefused("--system is a broker-signer option");
  if (!["questions", "items"].includes(opts.api)) throw new HarnessRefused("--api must be questions or items");
  if (!/^(v\d{4}\.\d+\.LTS|latest-lts|latest|v\d+(\.\d+)*)$/.test(opts.apiVersion)) throw new HarnessRefused(`--api-version ${opts.apiVersion} isn't a Learnosity version (e.g. ${DEFAULT_API_VERSION})`);
  if (!/^v\d{4}\.\d+\.LTS$/.test(opts.dataApiVersion)) throw new HarnessRefused(`--data-api-version must be a named LTS (e.g. ${DEFAULT_DATA_API_VERSION})`);
  if (!PROBES[opts.probe]) throw new HarnessRefused(`--probe must be one of ${Object.keys(PROBES).join(", ")}`);
  for (const d of [...opts.ages, ...opts.expires, ...(opts.rotationIntervals ?? [])]) parseDuration(d);
  for (const d of [opts.afterExpiry, opts.probeSettle]) if (d !== undefined) parseDuration(d);
  if (opts.replayGap) parseDuration(opts.replayGap);
  if (opts.expires.length && opts.signer !== "raw") throw new HarnessRefused("--expires needs --signer raw (Broker sets its own expires)");
  if (opts.system && opts.cases.some(c => ["drafts", "rotation", "acceptance", "session", "separation"].includes(c))) {
    throw new HarnessRefused("--system (the production system consumer) is for scope, integrity and replay only, with local_practice");
  }
  if (opts.noStore) opts.store = false;
  opts.cases = [...new Set(opts.cases)];
  if (!opts.help && !opts.cleanup && !opts.scanDocuments && opts.cases.length === 0) throw new HarnessRefused("name at least one case");
  return opts;
};

// deps: { env, out(line), err(line), now, sleep, prompt, fs, makeRawSdk(),
//         fetch, launchBrowser(opts), brokerEnv(opts) -> { signerDeps, caches },
//         firestoreLister() }. Nothing is called in a dry run but out/err/now.
// Returns the exit code.
export const main = async (argv, deps) => {
  const { out, err, env = {}, now = Date.now, fs } = deps;
  let opts;
  try {
    opts = parseArgs(argv);
    if (opts.qeActivityFile) opts.qeActivity = JSON.parse(await fs.readFile(opts.qeActivityFile, "utf8"));
  } catch (e) {
    err(e.message);
    err(USAGE);
    return 2;
  }
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
  const outFile = opts.out ?? `.gc-deploy/provider/at10-${stamp}.json`;
  const manifestFile = opts.manifest ?? ".gc-deploy/provider/at10-fixtures.json";
  const needs = opts.cases.map(c => caseNeeds(c, opts));
  const needsRaw = opts.cleanup || needs.some(n => n.raw);
  const needsKey = needsRaw || needs.some(n => n.key);

  // The sandbox check comes first, offline, in every mode: a key that isn't
  // the sandbox's is refused whenever it is set.
  let creds = null;
  try {
    if (needsRaw) creds = loadRawCredentials(env);
    else if (needsKey || env.LRN_SANDBOX_KEY) creds = loadSandboxKey(env);
  } catch (e) {
    if (!(e instanceof HarnessRefused)) throw e;
    if (opts.run || env.LRN_SANDBOX_KEY) {
      err(e.message);
      return 2;
    }
  }
  const secrets = creds ? [creds.key, creds.secret].filter(Boolean) : [];
  const redact = createRedactor(secrets);

  if (!opts.run) {
    out("AT-10 provider harness: DRY RUN (nothing signed, launched or sent; add --run to execute)");
    out(`Learnosity JS APIs ${opts.apiVersion}; Data API ${opts.dataApiVersion}`);
    if (opts.scanDocuments) out(`scan-documents: read-only scan of ${SCAN_COLLECTIONS.map(c => `${c.db}:${c.collection}`).join(", ")} for signature fields (counts and paths only)`);
    if (opts.cleanup) out(`cleanup: remove every fixture still listed in ${manifestFile}`);
    out(`sandbox credentials: ${creds ? `key ${keyFingerprint(creds.key)}${creds.secret ? `, secret set, domain ${creds.domain}` : " (key only)"}` : "not set"}${needsRaw ? " (secret needed)" : needsKey ? " (key needed)" : ""}`);
    for (const c of opts.cases) {
      const plan = planCase(c, { ...opts, t0: now() });
      const uses = [plan.needs.raw && "the raw sandbox credential", !plan.needs.raw && plan.needs.key && "the sandbox consumer key", plan.needs.broker && "the canary's Policy/Broker access", plan.needs.browser && "chromium"].filter(Boolean);
      out(`\n${c} (${c === "qe-preview" ? "Question Editor, unsigned" : `${opts.api}; signer ${opts.signer}${opts.system ? ", system session" : ""}`}; needs ${uses.join(", ")})`);
      if (plan.needs.sandboxWrites) out(`  touches the sandbox: ${plan.needs.sandboxWrites}`);
      for (const s of plan.steps) out(`  - ${s.id}${s.initAt ? ` signs ${s.signAt}, initialises ${s.initAt}${s.expires ? ` (expires ${s.expires})` : ""}; control signed fresh then` : ""}${s.detail ? `: ${s.detail}` : ""}${s.change ? ` ${JSON.stringify(s.change)}` : ""}${s.phases ? ` (expires ${s.expires}; probe ${s.probe}): ${s.phases.map(p => `${p.phase} at ${p.when}`).join("; ")}` : ""}`);
    }
    out(`\nevidence would be written to ${opts.resumeFile ?? outFile}`);
    return 0;
  }

  if (needsRaw && !creds?.secret) {
    err("the raw sandbox credential is needed (set -a; . ~/.lrn-sandbox.env; set +a)");
    return 2;
  }
  const sdk = creds?.secret ? await deps.makeRawSdk() : null;
  const dataApi = sdk ? createDataApi({ sdk, credentials: creds, fetch: deps.fetch, baseUrl: `https://data.learnosity.com/${opts.dataApiVersion}` }) : null;
  const manifest = createManifest({ file: manifestFile, fs });

  if (opts.cleanup) {
    const res = await manifest.cleanup(dataApi);
    out(`cleanup: ${res.removed} removed, ${res.failed} not removed`);
    for (const r of res.records) out(`  ${r.kind} ${r.reference}: ${r.removed ?? `NOT removed (${r.reason})`}`);
    return res.failed ? 1 : 0;
  }
  if (opts.scanDocuments) {
    const res = await scanDocuments({ listPage: await deps.firestoreLister(), log: out });
    for (const c of res.collections) {
      out(`${c.db}:${c.collection}: ${c.scanned} scanned, ${c.withSignature} with a signature field`);
      for (const h of c.hits) out(`  ${h.doc}: ${h.fields.join(", ")}`);
    }
    return res.ok ? 0 : 1;
  }

  const resume = opts.resumeFile ? JSON.parse(await fs.readFile(opts.resumeFile, "utf8")) : null;
  const runId = resume?.runId ?? randomBytes(4).toString("hex");
  const evidence = createEvidence({
    file: opts.resumeFile ?? outFile,
    fs,
    secrets,
    initial: resume ?? {
      harness: "at10-provider",
      version: 1,
      runId,
      startedAt: new Date(now()).toISOString(),
      signer: opts.signer,
      system: opts.system,
      api: opts.api,
      origin: ORIGIN,
      sandboxKey: creds ? keyFingerprint(creds.key) : null,
      providerBuild: { lts: opts.apiVersion, dataApiVersion: opts.dataApiVersion, dataApi: null },
      cases: {},
    },
  });
  // The provider build, from the Data API's own meta.versions (a read only).
  if (dataApi) {
    await dataApi.call("/itembank/questions", "get", { limit: 1 });
    evidence.data.providerBuild = { ...(evidence.data.providerBuild ?? {}), dataApi: dataApi.versions() };
  }
  const needsBroker = needs.some(n => n.broker);
  const brokerEnv = needsBroker ? await deps.brokerEnv(opts) : null;
  const signer = opts.signer === "raw"
    ? createRawSigner({ sdk, credentials: creds, now })
    : brokerEnv ? createBrokerSigner({ ...brokerEnv.signerDeps, system: opts.system, runId }) : null;
  const saver = opts.signer === "raw" ? { kind: "raw", ...createRawSaver(dataApi) } : signer ? { kind: "broker", write: signer.write } : null;
  const needsBrowser = needs.some(n => n.browser);
  const browser = needsBrowser ? await createBrowserDriver({ launch: () => deps.launchBrowser(opts), apiVersion: opts.apiVersion, redact }) : null;
  const log = line => out(redact(line));
  let code = 0;
  try {
    for (const c of opts.cases) {
      log(`== ${c}`);
      const ctx = {
        signer,
        browser,
        dataApi,
        saver,
        manifest,
        runId,
        api: opts.api,
        log,
        now,
        sleep: deps.sleep,
        prompt: deps.prompt,
        consumerKey: creds?.key ?? null,
        evidence: { data: evidence.data.cases, save: evidence.save },
        opts: { ...opts, resume: resume?.cases?.[c] ?? null },
        caches: brokerEnv?.caches,
        fetch: deps.fetch,
        // Signs a request of any service with the raw sandbox credential:
        // the controls of the separation case.
        rawInit: sdk ? (service, body, action) => sdk.init(service, { consumer_key: creds.key, domain: creds.domain, user_id: randomUUID(), timestamp: lrnTime(now()) }, creds.secret, structuredClone(body), action) : null,
      };
      try {
        evidence.data.cases[c] = await CASE_FNS[c](ctx);
      } catch (e) {
        code = 1;
        evidence.data.cases[c] = { ...(evidence.data.cases[c] ?? {}), error: redact(e?.message ?? String(e)).slice(0, 500) };
        err(`${c}: ${redact(e?.message ?? String(e))}`);
      }
      evidence.data.finishedAt = new Date(now()).toISOString();
      await evidence.save();
      log(`   ${c} recorded in ${evidence.file}`);
    }
  } finally {
    if (browser) await browser.close();
  }
  return code;
};
