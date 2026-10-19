/* eslint-disable camelcase -- Learnosity wire fields are snake_case */
// The AT-10 provider harness (scripts/lib/at10-provider.js), without a
// browser or the network: Playwright, fetch, the Data API and the clock are
// all stubbed. Signing uses the real Learnosity SDK, which is local.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { inspect } from "node:util";
import LearnositySDK from "learnosity-sdk-nodejs";
import { hasSignedRequest } from "../lib/canary.js";
import { http as jsonHttp } from "../lib/canary-env.js";
import {
  HarnessRefused, SignedRequest, unseal, loadRawCredentials, loadSandboxKey, createRedactor, assertFactsOnly,
  createRawSigner, createDataApi, createRawSaver, createBrokerSigner, createBrowserDriver, createManifest,
  planAcceptance, planReplay, planScope, planCase, parseArgs, parseDuration, lrnTime, networkEntry,
  cacheVerdict, checkCaches, scanDocuments, signaturePaths, acceptanceCase, replayCase, draftsCase, sessionCase, PROBES,
  integrityCase, main, DEFAULT_AGES, DEFAULT_API_VERSION, REPLAY_MODES, qeWidgets, L0158_ACTIVITY,
  probeFacts, sessionVerdict, runProbe, qeRendered, qePreviewCase, parseExpires, PROBE_RESPONSE, planSession,
  separationCase, securityPacket, SEPARATION_TARGETS, itemBankCalls,
} from "../lib/at10-provider.js";

const KEY = "sandboxkey-ABCDEFGH-Zq9T";
const SECRET = "sandbox-secret-0123456789abcdef";
const ENV = { LRN_SANDBOX_KEY: KEY, LRN_SANDBOX_KEY_SUFFIX: "Zq9T", LRN_SANDBOX_SECRET: SECRET, LRN_SANDBOX_DOMAIN: "l0176.graffiticode.org" };
const SIG = /\$02\$[0-9a-f]{64}/;

// Everything the evidence and output must never contain.
const assertClean = (label, text) => {
  assert.ok(!SIG.test(text), `${label}: a signature leaked`);
  assert.ok(!text.includes(SECRET), `${label}: the secret leaked`);
  assert.ok(!text.includes(KEY), `${label}: the consumer key leaked`);
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* text output */ }
  if (parsed) assert.ok(!hasSignedRequest(parsed), `${label}: a signed request leaked`);
};

const memfs = () => {
  const files = new Map();
  return {
    files,
    readFile: async p => {
      if (!files.has(p)) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
      return files.get(p);
    },
    writeFile: async (p, s) => { files.set(p, String(s)); },
    rename: async (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    mkdir: async () => {},
  };
};

const forbidden = name => () => { throw new Error(`${name} must not be called`); };

// A stand-in for Playwright's chromium: records what the page was given and
// answers like the harness page would, dispatching on which window.__at10
// function the driver evaluates. `decide(api, request)` -> ready;
// `check({ pageId })` -> { outcome, value?, calls: [{ url, status }] } (the
// Learnosity requests the isValid probe causes); `qe` overrides the Question
// Editor's init / panel / action answers.
const fakePlaywright = ({ decide = () => true, errorEcho = false, check = null, qe = {} } = {}) => {
  const seen = { launched: 0, contexts: 0, pages: 0, inits: [], gotos: [], qe: [], checks: [], typed: [], qeActions: [] };
  const respond = (handlers, url, status, method = "POST") => handlers.response?.({ url: () => url, request: () => ({ method: () => method, postData: () => null }), status: () => status });
  const launch = async () => {
    seen.launched++;
    return {
      newContext: async () => {
        seen.contexts++;
        const contextId = seen.contexts;
        const handlers = {};
        return {
          on: (ev, cb) => { handlers[ev] = cb; },
          route: async () => {},
          newPage: async () => {
            const pageId = ++seen.pages;
            return {
              goto: async url => {
                seen.gotos.push(url);
                // The loader's bundle request, with a signature in its query
                // that the network log must drop.
                const req = { method: () => "POST", postData: () => `{"signature":"$02$${"a".repeat(64)}"}` };
                handlers.response?.({ url: () => `https://questions.learnosity.com/v2026.2.LTS/questionsapi.js?signature=$02$${"b".repeat(64)}`, request: () => req, status: () => 200 });
              },
              evaluate: async (fn, arg) => {
                const src = String(fn);
                if (src.includes("__at10.init(")) {
                  const [api, request] = arg;
                  seen.inits.push({ api, request, contextId, pageId });
                  const ready = decide(api, request);
                  return { ready, errors: errorEcho ? [{ code: "10001", message: `refused ${JSON.stringify(request).slice(0, 400)}` }] : [], version: { value: "v2.249.9", source: 1 } };
                }
                if (src.includes("__at10.qeInit(")) {
                  seen.qe.push(arg[0]);
                  return qe.init?.(arg[0]) ?? { ready: true, events: [{ name: "widget:ready", ms: 900 }, { name: "readyListener", ms: 1000 }], finishedBy: "widget:ready", errors: [], version: { value: null, source: null } };
                }
                if (src.includes("__at10.qePanel(")) return qe.panel ?? { panel: true, previewElements: 5, responseAreas: 1, stimulusShown: true, inputs: 2, validation: "correct", questionsApp: { available: true, questions: 1 } };
                if (src.includes("__at10.qeValidate(")) return { called: true };
                if (src.includes("__at10.qeAction(")) {
                  seen.qeActions.push({ action: arg[0], pageId });
                  const answer = qe.action?.(arg[0]) ?? { outcome: "error", error: { code: "10004", message: "Submit / save responses failed" }, errors: [], calls: [] };
                  for (const c of answer.calls ?? []) respond(handlers, c.url, c.status);
                  return answer;
                }
                if (src.includes("__at10.hasResponse(")) return { available: true, hasResponse: true };
                if (src.includes("__at10.check(")) {
                  seen.checks.push({ responseId: arg[0], pageId, contextId });
                  const answer = check?.({ pageId, contextId }) ?? { outcome: "success", value: "true", calls: [{ url: "https://questions.learnosity.com/v2026.2.LTS/math/score", status: 200 }] };
                  for (const c of answer.calls ?? []) respond(handlers, c.url, c.status);
                  return { outcome: answer.outcome, value: answer.value, errors: answer.errors ?? [], ...(answer.error ? { error: answer.error } : {}) };
                }
                if (src.includes("__at10.action(")) return { outcome: "success", errors: [] };
                throw new Error(`the fake page doesn't know ${src.slice(0, 80)}`);
              },
              locator: () => ({ first: () => ({ click: async () => {} }) }),
              keyboard: { type: async value => { seen.typed.push({ value, pageId }); } },
              waitForTimeout: async () => {},
              close: async () => {},
            };
          },
          close: async () => {},
        };
      },
      close: async () => {},
    };
  };
  return { launch, seen };
};

const fakeClock = (start = Date.parse("2026-10-16T12:00:00Z")) => {
  let t = start;
  return { now: () => t, sleep: async ms => { t += ms; }, advance: ms => { t += ms; } };
};

// --- Credentials -----------------------------------------------------------

test("the raw signer refuses any key that isn't the sandbox's, without printing it", () => {
  const other = "production-key-XYZ123";
  assert.throws(() => loadRawCredentials({ ...ENV, LRN_SANDBOX_KEY: other }), e => e instanceof HarnessRefused && /LRN_SANDBOX_KEY_SUFFIX/.test(e.message) && !e.message.includes(other));
  // Without the suffix in the environment, nothing is signed either.
  assert.throws(() => loadRawCredentials({ ...ENV, LRN_SANDBOX_KEY_SUFFIX: undefined }), e => e instanceof HarnessRefused && /LRN_SANDBOX_KEY_SUFFIX/.test(e.message));
  assert.throws(() => loadSandboxKey({ LRN_SANDBOX_KEY: other }), e => e instanceof HarnessRefused && !e.message.includes(other));
  assert.throws(() => loadRawCredentials({ LRN_SANDBOX_KEY: KEY }), e => /LRN_SANDBOX_SECRET, LRN_SANDBOX_DOMAIN/.test(e.message) && /lrn-sandbox\.env/.test(e.message));
  assert.equal(loadRawCredentials(ENV).key, KEY);
});

test("a wrong key stops the CLI before any network, in a dry run and a real one", async () => {
  for (const argv of [["integrity"], ["integrity", "--run", "--signer", "raw"], ["qe-preview", "--run"], ["--cleanup", "--run"]]) {
    const lines = [];
    const code = await main(argv, {
      env: { ...ENV, LRN_SANDBOX_KEY: "live-key-0000" },
      out: l => lines.push(l),
      err: l => lines.push(l),
      fs: memfs(),
      fetch: forbidden("fetch"),
      launchBrowser: forbidden("launchBrowser"),
      brokerEnv: forbidden("brokerEnv"),
      makeRawSdk: forbidden("makeRawSdk"),
      firestoreLister: forbidden("firestoreLister"),
    });
    assert.equal(code, 2, argv.join(" "));
    assert.match(lines.join("\n"), /not the development consumer/);
    assert.ok(!lines.join("\n").includes("live-key-0000"));
  }
});

test("secrets and signatures are redacted from errors", async () => {
  const redact = createRedactor([KEY, SECRET]);
  assert.equal(redact(`key ${KEY} secret ${SECRET} sig $02$${"c".repeat(64)}`), "key [redacted] secret [redacted] sig [signature]");
  const dataApi = createDataApi({
    sdk: new LearnositySDK(),
    credentials: loadRawCredentials(ENV),
    fetch: async () => ({ ok: false, status: 401, json: async () => ({ meta: { status: false, message: `bad consumer ${KEY} / ${SECRET}` } }) }),
  });
  const res = await dataApi.call("/itembank/items", "get", { references: ["x"] });
  assert.equal(res.ok, false);
  assertClean("data api reason", res.reason);
  assert.match(res.reason, /\[redacted\]/);
});

// --- Custody ------------------------------------------------------------------

test("a signed request prints, logs and serializes as a placeholder; only unseal reads it", async () => {
  const signer = createRawSigner({ sdk: new LearnositySDK(), credentials: loadRawCredentials(ENV) });
  const signed = await signer.sign("questions", { id: "x", questions: [{ type: "mcq", response_id: "r0" }] });
  for (const text of [JSON.stringify({ signed }), inspect(signed), String(signed), `${signed}`]) assertClean("sealed", text);
  const value = unseal(signed);
  assert.match(value.signature, SIG);
  value.questions = [];
  assert.equal(unseal(signed).questions.length, 1, "unseal hands out a copy");
  assert.throws(() => unseal({}), /not a signed request/);
  assert.throws(() => assertFactsOnly({ leaked: value }), /signed request/);
  assert.throws(() => assertFactsOnly({ note: `sig $02$${"d".repeat(64)}` }), /signature/);
  assert.throws(() => assertFactsOnly({ note: `secret ${SECRET}` }, [SECRET]), /credential/);
});

test("Questions requests sign only the security packet; Items requests sign the request", async () => {
  const signer = createRawSigner({ sdk: new LearnositySDK(), credentials: loadRawCredentials(ENV), now: () => Date.parse("2026-10-16T12:34:56Z") });
  const q = unseal(await signer.sign("questions", { id: "a", type: "local_practice", questions: [{ type: "mcq", response_id: "r" }] }));
  const q2 = unseal(await signer.sign("questions", { id: "a", type: "submit_practice", questions: [] }, { userId: q.user_id }));
  assert.equal(q.timestamp, "20261016-1234");
  assert.equal(q.signature, q2.signature, "the Questions signature doesn't cover the request");
  const i = unseal(await signer.sign("items", { id: "a", type: "local_practice", questions: [] }, { userId: "u" }));
  const i2 = unseal(await signer.sign("items", { id: "a", type: "submit_practice", questions: [] }, { userId: "u" }));
  assert.notEqual(i.security.signature, i2.security.signature, "the Items signature covers the request");
  const e = unseal(await signer.sign("questions", { id: "a", questions: [] }, { expires: Date.parse("2026-10-16T12:44:56Z") }));
  assert.equal(e.expires, "20261016-1244");
});

test("the network log keeps method, host, path and status, and drops queries and bodies", () => {
  const e = networkEntry(`https://questions.learnosity.com/v2026.2.LTS/x.js?signature=$02$${"e".repeat(64)}&k=${KEY}`, "POST", 200, s => s, `{"signature":"$02$${"f".repeat(64)}"}`);
  assert.deepEqual(Object.keys(e).sort(), ["host", "mentionsSignature", "method", "path", "requestBytes", "status"]);
  assert.equal(e.path, "/v2026.2.LTS/x.js");
  assert.equal(e.mentionsSignature, true);
  assertClean("entry", JSON.stringify(e));
  assert.equal(networkEntry("https://questions.learnosity.com/?v2026.2.LTS", "GET", 200).version, "v2026.2.LTS");
  assert.equal(networkEntry("https://example.org/q.js", "GET", 200), null);
});

// --- No request or signature in output or evidence ----------------------------

test("a full raw run writes facts only: no request, signature, key or secret in output or evidence", async () => {
  const fs = memfs();
  const pw = fakePlaywright({ decide: (api, r) => !r.domain, errorEcho: true });
  const clock = fakeClock();
  const lines = [];
  const code = await main(["integrity", "replay", "scope", "qe-preview", "--run", "--signer", "raw", "--replay-gap", "1s", "--out", "/ev/at10.json"], {
    env: ENV,
    out: l => lines.push(l),
    err: l => lines.push(l),
    now: clock.now,
    sleep: clock.sleep,
    fs,
    makeRawSdk: async () => new LearnositySDK(),
    // The Data API (provider build, the scope case's read-back): a sandbox stand-in.
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ meta: { status: true, versions: { requested: "v2025.2.LTS", mapped: "v2025.2.LTS", concrete: "v1.57.3" } }, data: [] }) }),
    launchBrowser: pw.launch,
    brokerEnv: forbidden("brokerEnv"),
    firestoreLister: forbidden("firestoreLister"),
  });
  assert.equal(code, 0, lines.join("\n"));
  // The page really got signed requests...
  assert.ok(pw.seen.inits.length > 10);
  assert.ok(pw.seen.inits.every(i => SIG.test(JSON.stringify(i.request))));
  // ...and the consumer key alone went to Question Editor, unsigned.
  assert.ok(pw.seen.qe.length >= 3 && pw.seen.qe.every(o => o.configuration.consumer_key === KEY && !JSON.stringify(o).includes("signature")));
  const evidence = fs.files.get("/ev/at10.json");
  assertClean("evidence", evidence);
  assertClean("output", lines.join("\n"));
  const ev = JSON.parse(evidence);
  assert.equal(ev.providerBuild.lts, DEFAULT_API_VERSION);
  assert.equal(ev.providerBuild.dataApi.concrete, "v1.57.3");
  const tampered = ev.cases.integrity.results.find(r => r.field === "domain");
  assert.equal(tampered.accepted, false);
  assert.ok(tampered.init.errors[0].message.includes("[redacted]"), "error text echoing the request is redacted");
  assert.equal(ev.cases.integrity.results.find(r => r.field === "type").accepted, true);
  assert.equal(ev.cases["qe-preview"].signed, false);
  assert.deepEqual(ev.cases["qe-preview"].results.map(r => r.id), ["qe-single-mcq", "qe-l0158-activity", "qe-preview-save"]);
  assert.equal(ev.cases.scope.results.find(r => r.id === "store-submit_practice").stored, false);
});

// --- Dry run ---------------------------------------------------------------------

test("a dry run plans every case and touches nothing", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = forbidden("global fetch");
  try {
    const fs = memfs();
    const lines = [];
    const code = await main(["all", "--signer", "raw", "--expires", "5m"], {
      env: ENV,
      out: l => lines.push(l),
      err: l => lines.push(l),
      fs,
      fetch: forbidden("fetch"),
      launchBrowser: forbidden("launchBrowser"),
      brokerEnv: forbidden("brokerEnv"),
      makeRawSdk: forbidden("makeRawSdk"),
      firestoreLister: forbidden("firestoreLister"),
      sleep: forbidden("sleep"),
      prompt: forbidden("prompt"),
    });
    assert.equal(code, 0);
    const text = lines.join("\n");
    assert.match(text, /DRY RUN/);
    for (const c of ["scope", "integrity", "acceptance", "session", "replay", "rotation", "drafts", "caches", "qe-preview"]) assert.match(text, new RegExp(`^${c} \\(`, "m"));
    assert.match(text, /expires-5m-inside/);
    assert.match(text, /draft-f/);
    assert.equal(fs.files.size, 0, "a dry run writes nothing");
    assertClean("dry run", text);
    // Without credentials it still plans, and says what's missing.
    const bare = [];
    assert.equal(await main(["drafts"], { env: {}, out: l => bare.push(l), err: l => bare.push(l), fs: memfs() }), 0);
    assert.match(bare.join("\n"), /not set \(secret needed\)/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("options are checked before anything runs", () => {
  assert.throws(() => parseArgs([]), /at least one case/);
  assert.throws(() => parseArgs(["nope"]), /unknown case/);
  assert.throws(() => parseArgs(["acceptance", "--expires", "5m"]), /--signer raw/);
  assert.throws(() => parseArgs(["acceptance", "--ages", "5 minutes"]), /not a duration/);
  assert.throws(() => parseArgs(["drafts", "--system"]), /system/);
  assert.throws(() => parseArgs(["scope", "--data-api-version", "latest"]), /named LTS/);
  assert.equal(parseArgs(["scope"]).apiVersion, "v2026.2.LTS");
  assert.equal(parseArgs(["scope", "--api-version", "v2025.2.LTS"]).apiVersion, "v2025.2.LTS");
  assert.equal(parseDuration("6h"), 6 * 3_600_000);
  assert.equal(lrnTime(Date.parse("2026-01-02T03:04:59Z")), "20260102-0304");
});

// --- Planning ------------------------------------------------------------------------

test("acceptance plans one fresh request per age, each with its own fresh control", () => {
  const plan = planAcceptance({ ages: DEFAULT_AGES, t0: 0 });
  assert.equal(plan.length, DEFAULT_AGES.length);
  assert.equal(new Set(plan.map(s => s.id)).size, plan.length);
  assert.ok(plan.every(s => s.freshRequest && /fresh/.test(s.control) && s.signAt === new Date(0).toISOString()));
  assert.deepEqual(plan.map(s => s.ageMs), [60_000, 300_000, 900_000, 1_800_000, 3_600_000, 21_600_000, 86_400_000]);
  const withExpires = planAcceptance({ ages: ["1m"], expires: ["10m"], t0: 0 });
  assert.deepEqual(withExpires.map(s => s.id), ["age-1m", "expires-10m-inside", "expires-10m-past"]);
  assert.ok(withExpires.find(s => s.id === "expires-10m-past").ageMs > 600_000);
});

test("replay modes are measured separately, each with its own request", () => {
  assert.deepEqual(planReplay().map(s => s.mode), REPLAY_MODES);
  assert.ok(planReplay().every(s => s.freshRequest && s.control));
  assert.deepEqual(planScope({ api: "questions" }).filter(s => s.id.startsWith("type-")).map(s => s.change.type), ["local_practice", "submit_practice"]);
  assert.ok(planScope({ api: "items" }).some(s => s.id === "type-feedback"));
  assert.equal(planCase("qe-preview").needs.key, true);
  assert.equal(planCase("qe-preview").needs.raw, false);
});

const caseCtx = (pw, clock, extra = {}) => ({
  runId: "t1",
  api: "questions",
  log: () => {},
  now: clock.now,
  sleep: clock.sleep,
  opts: {},
  ...extra,
});
const countingSigner = clock => {
  const signer = createRawSigner({ sdk: new LearnositySDK(), credentials: loadRawCredentials(ENV), now: clock.now });
  const signed = [];
  return {
    signed,
    signer: { ...signer, sign: async (...a) => { const s = await signer.sign(...a); signed.push({ id: s.meta.id, at: clock.now() }); return s; } },
  };
};

test("the acceptance case initialises each unused request once, at its age, beside a control signed then", async () => {
  const clock = fakeClock();
  const pw = fakePlaywright();
  const { signer, signed } = countingSigner(clock);
  const browser = await createBrowserDriver({ launch: pw.launch });
  const fs = memfs();
  const data = {};
  const ev = { data, save: async () => { assertFactsOnly(data, [KEY, SECRET]); fs.files.set("/ev", JSON.stringify(data)); } };
  const t0 = clock.now();
  const state = await acceptanceCase(caseCtx(pw, clock, { signer, browser, evidence: ev, opts: { ages: ["1m", "1h"] } }));
  assert.equal(state.steps.length, 2);
  assert.ok(state.steps.every(s => s.status === "done" && s.accepted === true && s.control.ready === true));
  // 2 test requests at t0, then one control at each init.
  assert.equal(signed.length, 4);
  assert.deepEqual(signed.slice(0, 2).map(s => s.at), [t0, t0]);
  assert.deepEqual(signed.slice(2).map(s => s.at - t0), [60_000, 3_600_000]);
  // Each test request opened exactly once.
  const testIds = new Set(state.steps.map(s => s.result.request));
  assert.equal(testIds.size, 2);
  assertClean("acceptance evidence", fs.files.get("/ev"));

  // Resumed: a finished step is kept, a pending one re-signed in a new batch.
  const prior = structuredClone(state);
  prior.steps[1].status = "planned";
  delete prior.steps[1].result;
  const resumed = await acceptanceCase(caseCtx(pw, clock, { signer, browser, evidence: { data: {}, save: async () => {} }, opts: { ages: ["1m", "1h"], resume: prior } }));
  assert.equal(resumed.batches.length, 2);
  assert.deepEqual(resumed.batches[1].steps, ["age-1h"]);
  assert.ok(resumed.steps.some(s => s.status.startsWith("lost")));
  assert.equal(resumed.steps.filter(s => s.status === "done").length, 2);
});

test("replay uses one fresh request per mode, initialised twice, and separate contexts where it should", async () => {
  const clock = fakeClock();
  const pw = fakePlaywright();
  const { signer } = countingSigner(clock);
  const browser = await createBrowserDriver({ launch: pw.launch });
  const out = await replayCase(caseCtx(pw, clock, { signer, browser, opts: { replayGap: "10s" } }));
  const ids = out.results.map(r => r.first.request);
  assert.equal(new Set(ids).size, 3, "a fresh request per mode");
  assert.ok(out.results.every(r => r.first.request === r.second.request && r.control.request !== r.first.request));
  // What the page saw: each signing has its own user_id. Three requests were
  // initialised twice (one per mode), every control once.
  const groups = new Map();
  for (const i of pw.seen.inits) groups.set(i.request.user_id, [...(groups.get(i.request.user_id) ?? []), i.contextId]);
  const twice = [...groups.values()].filter(g => g.length === 2);
  assert.equal(twice.length, 3);
  assert.equal([...groups.values()].filter(g => g.length === 1).length, 3, "one control per mode");
  assert.deepEqual(twice.map(g => new Set(g).size).sort(), [1, 2, 2], "same browser shares a context; the others use two");
  assert.equal(out.results.find(r => r.mode === "after-first-use").gap, "10s");
});

// The session case's signer as Broker: Broker's own expires, as the
// security packet carries it (YYYYMMDD-HHmm), and no expires taken.
const brokerLike = (clock, minutes = 10) => {
  const raw = createRawSigner({ sdk: new LearnositySDK(), credentials: loadRawCredentials(ENV), now: clock.now });
  const asked = [];
  return {
    asked,
    signer: {
      kind: "broker",
      sign: async (api, payload, o = {}) => {
        asked.push(o.expires ?? null);
        const s = await raw.sign(api, payload);
        return new SignedRequest(api, unseal(s), { signer: "broker", signedAt: new Date(clock.now()).toISOString(), expires: lrnTime(clock.now() + minutes * 60_000) });
      },
    },
  };
};
const LRN_CALL = "https://questions.learnosity.com/v2026.2.LTS/math/score";

test("the session probe runs just after init and again past expires + 60 s, in one page, then a fresh control", async () => {
  const clock = fakeClock();
  const t0 = clock.now();
  const expiresAt = t0 + 5 * 60_000;
  let testPage = null;
  // Learnosity refuses the tested session's call once its expires has passed.
  const pw = fakePlaywright({
    check: ({ pageId }) => {
      testPage ??= pageId;
      const refused = pageId === testPage && clock.now() > expiresAt;
      return refused ? { outcome: "error", error: { code: "10003", message: "Failed authentication" }, calls: [{ url: LRN_CALL, status: 401 }] } : { outcome: "success", value: "true", calls: [{ url: LRN_CALL, status: 200 }] };
    },
  });
  const { signer } = countingSigner(clock);
  const browser = await createBrowserDriver({ launch: pw.launch });
  const out = await sessionCase(caseCtx(pw, clock, { signer, browser, evidence: { data: {}, save: async () => {} }, opts: {} }));
  const [series] = out.series;
  assert.equal(out.probe, "isvalid");
  assert.equal(series.id, "session-expires-5m");
  assert.equal(series.question, "clozeformulaV2");
  assert.equal(series.expires, new Date(expiresAt).toISOString());
  assert.equal(series.response.entered, true);
  assert.deepEqual(series.probes.map(p => p.phase), ["before-expires", "after-expires"]);
  assert.equal(Date.parse(series.probes[0].at) - t0, 5000, "the first probe follows init by the settle time");
  assert.equal(Date.parse(series.probes[1].at), expiresAt + 60_000, "the second waits until expires + 60 s");
  // Both probes ran in the tested request's one page; the control in its own.
  const [first, second, ctl] = pw.seen.checks;
  assert.equal(first.pageId, second.pageId);
  assert.notEqual(ctl.contextId, first.contextId);
  assert.ok(pw.seen.typed.every(t => t.value === PROBE_RESPONSE));
  // The probe's log: method, host, path and status only.
  assert.deepEqual(series.probes[1].network.at(-1), { method: "POST", host: "questions.learnosity.com", path: "/v2026.2.LTS/math/score", status: 401 });
  assert.ok(series.probes.every(p => p.confirmed));
  assert.equal(series.control.probe.outcome, "success");
  assert.equal(series.verdict, "refused-after-expires");
  // What the page was signed: one clozeformulaV2 question, local_practice.
  const signedQ = pw.seen.inits[0].request;
  assert.equal(signedQ.type, "local_practice");
  assert.equal(signedQ.questions[0].type, "clozeformulaV2");
  assertClean("session evidence", JSON.stringify(out));
});

test("with Broker's signer the session waits for Broker's own expires, and asks it for none", async () => {
  const clock = fakeClock();
  const t0 = clock.now();
  const pw = fakePlaywright();
  const { signer, asked } = brokerLike(clock, 10);
  const browser = await createBrowserDriver({ launch: pw.launch });
  const out = await sessionCase(caseCtx(pw, clock, { signer, browser, evidence: { data: {}, save: async () => {} }, opts: {} }));
  const [series] = out.series;
  assert.ok(asked.every(e => e === null));
  assert.equal(series.expiresSource, "broker");
  assert.equal(Date.parse(series.probes[1].at), t0 + 11 * 60_000);
  assert.equal(series.verdict, "accepted-after-expires");
  assert.equal(parseExpires("20261016-2238"), Date.parse("2026-10-16T22:38:00Z"));
  assert.equal(parseExpires("2026-10-16T22:38:41.500Z"), Date.parse("2026-10-16T22:38:00Z"));
  assert.equal(parseExpires(null), null);
  assert.deepEqual(planSession({ signer: "broker" }).map(s => s.id), ["session-broker-expires"]);
  assert.deepEqual(planSession({ signer: "raw", expires: ["2m", "10m"] }).map(s => s.expiresMs), [120_000, 600_000]);
});

test("a probe that makes no server call is probe-unconfirmed, never an expiry result", async () => {
  const clock = fakeClock();
  // isValid answers locally: no request, or only a static asset.
  let n = 0;
  const pw = fakePlaywright({ check: () => ({ outcome: "success", value: "true", calls: n++ % 2 ? [{ url: "https://questions.learnosity.com/v2026.2.LTS/fonts/math.woff2", status: 200 }] : [] }) });
  const { signer } = countingSigner(clock);
  const browser = await createBrowserDriver({ launch: pw.launch });
  const out = await sessionCase(caseCtx(pw, clock, { signer, browser, evidence: { data: {}, save: async () => {} }, opts: {} }));
  const [series] = out.series;
  assert.ok(series.probes.every(p => p.confirmed === false && p.finding === "probe-unconfirmed" && p.outcome === "success"));
  assert.equal(series.verdict, "probe-unconfirmed");

  // The rule, directly: either side unconfirmed wins over any outcome.
  const ok = probeFacts("isvalid", { outcome: "success", network: [{ method: "POST", host: "questions.learnosity.com", path: "/x", status: 200, requestBytes: 9, mentionsSignature: true }] });
  const refused = probeFacts("isvalid", { outcome: "error", network: [{ method: "POST", host: "questions.learnosity.com", path: "/x", status: 403 }] });
  const local = probeFacts("isvalid", { outcome: "error", network: [] });
  assert.deepEqual(Object.keys(ok.network[0]).sort(), ["host", "method", "path", "status"]);
  assert.equal(local.finding, "probe-unconfirmed");
  assert.equal(sessionVerdict(ok, local), "probe-unconfirmed");
  assert.equal(sessionVerdict(local, refused), "probe-unconfirmed");
  assert.equal(sessionVerdict(ok, refused, ok), "refused-after-expires");
  assert.equal(sessionVerdict(ok, refused, refused), "refused-control-too");
  assert.equal(sessionVerdict(refused, refused), "failed-before-expires");
  assert.equal(sessionVerdict(ok, ok), "accepted-after-expires");
  // A harness failure (a closed page) is recorded, unconfirmed.
  const broken = await runProbe("isvalid", { check: async () => { throw new Error("Target page has been closed"); } }, { responseId: "r" });
  assert.equal(broken.outcome, "harness-error");
  assert.equal(broken.finding, "probe-unconfirmed");
  assert.deepEqual(Object.keys(PROBES).sort(), ["isvalid", "save", "submit"]);
});

test("Question Editor: the render is judged by readyListener, widget:ready and the preview panel", () => {
  const panel = { panel: true, stimulusShown: true, inputs: 2, questionsApp: { available: true, questions: 0 } };
  assert.equal(qeRendered({ ready: true, events: [{ name: "widget:ready" }], panel }).rendered, true);
  assert.equal(qeRendered({ ready: true, events: [{ name: "widgetedit:widget:ready" }], panel }).rendered, true);
  // A preview question instance stands in for the event.
  assert.equal(qeRendered({ ready: true, events: [], panel: { ...panel, questionsApp: { questions: 1 } } }).rendered, true);
  const noEvent = qeRendered({ ready: true, events: [{ name: "readyListener" }, { name: "preview:changed" }], panel });
  assert.equal(noEvent.rendered, false);
  assert.deepEqual(noEvent.missing, ["widget:ready or a question instance in questionsApp()"]);
  const empty = qeRendered({ ready: true, events: [{ name: "widget:ready" }], panel: { panel: true, stimulusShown: false, inputs: 0 } });
  assert.deepEqual(empty.missing, ["the stimulus or a response input in the panel"]);
  const notReady = qeRendered({ ready: false, events: [{ name: "widget:ready" }], panel: { ...panel, panel: false } });
  assert.deepEqual(notReady.missing, ["readyListener", "the preview panel element"]);
});

test("Question Editor: the save variant acts through the preview's session only once it renders", async () => {
  const save = { url: "https://questions.learnosity.com/v2026.2.LTS/responses/save", status: 403 };
  const pw = fakePlaywright({ qe: { action: name => ({ outcome: "error", error: { code: "10004", message: `${name} failed` }, errors: [], calls: [save] }) } });
  const browser = await createBrowserDriver({ launch: pw.launch });
  const ctx = { browser, consumerKey: KEY, opts: {} };
  const out = await qePreviewCase(ctx);
  assert.equal(out.rendered, out.of);
  const variant = out.results.find(r => r.id === "qe-preview-save");
  assert.deepEqual(variant.actions.map(a => a.action), ["save", "submit"]);
  const [q] = variant.questions;
  assert.equal(q.render.widgetReady, true);
  assert.equal(q.validate.called, true);
  assert.ok(q.actions.every(a => a.outcome === "error" && a.network.some(e => e.path.endsWith("/responses/save") && e.status === 403)));
  assert.ok(q.actions.every(a => a.storageLikeRequests.length === 1));
  assert.ok(out.results.filter(r => r.id !== "qe-preview-save").every(r => !r.actions && r.questions.every(x => x.actions.length === 0)));
  assert.equal(out.consumerKey.startsWith("...Zq9T"), true);
  assertClean("qe evidence", JSON.stringify(out));

  // Not rendered (no widget:ready, no preview question): nothing is attempted.
  const blank = fakePlaywright({
    qe: {
      init: () => ({ ready: true, events: [{ name: "readyListener", ms: 1000 }], finishedBy: "render-timeout", errors: [], version: { value: null, source: null } }),
      panel: { panel: true, previewElements: 0, stimulusShown: false, inputs: 0, validation: null, questionsApp: { available: true, questions: 0 } },
    },
  });
  const out2 = await qePreviewCase({ browser: await createBrowserDriver({ launch: blank.launch }), consumerKey: KEY, opts: {} });
  assert.equal(out2.rendered, 0);
  assert.equal(blank.seen.qeActions.length, 0);
  const q2 = out2.results.find(r => r.id === "qe-preview-save").questions[0];
  assert.equal(q2.finishedBy, "render-timeout");
  assert.ok(q2.actions.every(a => a.outcome.startsWith("not-attempted")));
  await assert.rejects(qePreviewCase({ browser, opts: {} }), /LRN_SANDBOX_KEY/);
});

test("integrity tampers each field after signing", async () => {
  const clock = fakeClock();
  const pw = fakePlaywright({ decide: () => true });
  const { signer } = countingSigner(clock);
  const browser = await createBrowserDriver({ launch: pw.launch });
  const out = await integrityCase(caseCtx(pw, clock, { signer, browser }));
  assert.deepEqual(out.results.map(r => r.field), ["questions", "type", "session_id", "domain", "user_id", "origin"]);
  const given = pw.seen.inits.map(i => i.request);
  assert.ok(given.some(r => r.questions.length === 2));
  assert.ok(given.some(r => r.type === "submit_practice"));
  assert.ok(given.some(r => r.user_id === "at10-tampered-user"));
  assert.ok(pw.seen.gotos.some(u => u.startsWith("https://at10-foreign.graffiticode.org/")));
  assert.ok(pw.seen.gotos.filter(u => !u.includes("foreign")).every(u => u.startsWith("https://l0176.graffiticode.org/__at10/")));
});

// --- Drafts: fixtures, the manifest and cleanup -----------------------------------------

// An in-memory item bank behind the Data API's wire format. Item and
// activity deletes are refused (so cleanup archives them); item references
// over 150 characters are refused (so case d's item step fails).
const fakeBank = ({ fs, manifestFile }) => {
  const store = { "/itembank/questions": new Map(), "/itembank/items": new Map(), "/itembank/activities": new Map() };
  const plural = { "/itembank/questions": "questions", "/itembank/items": "items", "/itembank/activities": "activities" };
  const calls = [];
  const fetch = async (url, { body }) => {
    const route = new URL(url).pathname.replace(/^\/v[^/]+/, "");
    const action = body.get("action");
    const request = JSON.parse(body.get("request"));
    assert.ok(SIG.test(body.get("security")), "Data API requests are signed");
    calls.push({ route, action });
    const ok = data => ({ ok: true, status: 200, json: async () => ({ meta: { status: true, versions: { concrete: "v1.57.3" } }, data }) });
    const no = message => ({ ok: false, status: 400, json: async () => ({ meta: { status: false, message } }) });
    const table = store[route];
    if (!table) return no("no such route");
    if (action === "get") return ok((request.references ?? []).filter(r => table.has(r)).map(r => structuredClone(table.get(r))));
    // As Learnosity's Data API: these routes take get and set only.
    if (action !== "set") return no(`Route not found for: ${route}`);
    const records = request[plural[route]];
    for (const rec of records) {
      if (rec.reference.length > 150) return no("reference too long");
      // Every record created is in the manifest before its create is sent,
      // except Broker's own v8 references (gc-…): Broker chooses them, so the
      // case records them as soon as the write returns.
      const manifest = JSON.parse(fs.files.get(manifestFile) ?? "{\"entries\":[]}");
      if (!rec.reference.startsWith("gc-")) assert.ok(manifest.entries.some(e => e.reference === rec.reference), `${rec.reference} was created before it was recorded`);
      table.set(rec.reference, structuredClone(rec));
    }
    return ok([]);
  };
  return { fetch, store, calls };
};

test("drafts records every fixture before creating it, reads back what changed, and tears everything down", async () => {
  const fs = memfs();
  const manifestFile = "/m/at10-fixtures.json";
  const bank = fakeBank({ fs, manifestFile });
  const dataApi = createDataApi({ sdk: new LearnositySDK(), credentials: loadRawCredentials(ENV), fetch: bank.fetch });
  const manifest = createManifest({ file: manifestFile, fs });
  const out = await draftsCase({ dataApi, saver: { kind: "raw", ...createRawSaver(dataApi) }, manifest, runId: "r1", signer: null, opts: {} });
  const r = out.results;
  assert.equal(r.a.unpublished, true);
  assert.equal(r.b.accepted, true);
  assert.equal(r.b.questionStored, true);
  assert.equal(r.c.publishedContentChanged, true, "a question write overwrites a published item's question");
  assert.equal(r.d.itemStepFailed, true);
  assert.equal(r.d.publishedContentChanged, true);
  assert.equal(r.e.path, "direct");
  assert.equal(r.e.itemStatusAfter, "unpublished");
  assert.equal(r.e.publishedItemUnchanged, false);
  assert.equal(r.f.itemUnpublished, true);
  // (e) really published its item before the second save.
  assert.equal(r.e.publishedBeforeSecondSave, true);
  // Torn down: items and the activity archived; questions left (no status, can't be deleted).
  assert.equal(r.cleanup.failed, 0);
  assert.ok(bank.store["/itembank/questions"].size > 0);
  assert.ok([...bank.store["/itembank/items"].values()].every(i => i.status === "archived"));
  assert.ok([...bank.store["/itembank/activities"].values()].every(i => i.status === "archived"));
  const m = JSON.parse(fs.files.get(manifestFile));
  assert.ok(m.entries.length >= 14 && m.entries.every(e => e.removed !== null));
  assertClean("drafts", JSON.stringify(out));
});

test("--cleanup removes what a crashed run left in the manifest, and keeps what it couldn't", async () => {
  const fs = memfs();
  const manifestFile = ".gc-deploy/provider/at10-fixtures.json";
  fs.files.set(manifestFile, JSON.stringify({
    entries: [
      { runId: "old", kind: "question", reference: "at10-old-q0", removed: null },
      { runId: "old", kind: "item", reference: "at10-old", removed: null },
      { runId: "old", kind: "activity", reference: "at10-old-act", removed: null },
      { runId: "older", kind: "item", reference: "at10-done", removed: "deleted" },
    ],
  }));
  const order = [];
  const fetch = async (url, { body }) => {
    const route = new URL(url).pathname;
    const action = body.get("action");
    order.push(`${action} ${route.split("/").pop()}`);
    const request = JSON.parse(body.get("request"));
    const data = action === "get" ? (request.references ?? []).map(reference => ({ reference, status: "published" })) : [];
    // Activities' archive is refused once, to show a record kept for a later run.
    const refuse = action === "set" && route.endsWith("/activities");
    return { ok: !refuse, status: refuse ? 403 : 200, json: async () => ({ meta: { status: !refuse, message: refuse ? `forbidden for ${KEY}` : undefined }, data }) };
  };
  const lines = [];
  const code = await main(["--cleanup", "--run"], { env: ENV, out: l => lines.push(l), err: l => lines.push(l), fs, fetch, makeRawSdk: async () => new LearnositySDK() });
  assert.equal(code, 1, "one record couldn't be retired");
  // Read back, then archived with set; the question is read and left.
  assert.deepEqual(order, ["get activities", "set activities", "get items", "set items", "get questions"]);
  const m = JSON.parse(fs.files.get(manifestFile));
  assert.deepEqual(m.entries.map(e => e.removed), ["left", "archived", null, "deleted"]);
  assertClean("cleanup output", lines.join("\n"));
  assert.match(lines.join("\n"), /at10-old-act: NOT removed/);
});

// --- Caches -----------------------------------------------------------------------------

test("Cache-Control: a response carrying a signed request must be no-store and nothing storable", () => {
  assert.equal(cacheVerdict({ cacheControl: "no-store", carriesSignedRequest: true }).ok, true);
  assert.equal(cacheVerdict({ cacheControl: "private, max-age=31536000, immutable", carriesSignedRequest: true }).ok, false);
  assert.equal(cacheVerdict({ cacheControl: "no-store, public", carriesSignedRequest: true }).ok, false);
  assert.equal(cacheVerdict({ cacheControl: null, carriesSignedRequest: true }).ok, false);
  assert.equal(cacheVerdict({ cacheControl: "public, max-age=60", carriesSignedRequest: false }).ok, true);
});

test("checkCaches reads each route's headers from a server and judges them", async () => {
  const signedBody = { request: { consumer_key: "k", timestamp: "20261016-1200", signature: `$02$${"9".repeat(64)}`, questions: [] } };
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url.split("?")[0]}`);
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/task") return res.end(JSON.stringify({ data: { id: "task-1" } }));
      if (req.url.startsWith("/data") && req.url.includes("connection=")) res.setHeader("Cache-Control", "no-store");
      else if (req.url.startsWith("/data")) res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      else res.setHeader("Cache-Control", "no-store");
      res.end(JSON.stringify({ data: signedBody }));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const apiUrl = `http://127.0.0.1:${server.address().port}`;
    const out = await checkCaches({ http: jsonHttp, apiUrl, userToken: "t", connectionId: "conn-1", parse: async () => ({}) });
    assert.deepEqual(seen, ["POST /task", "GET /data", "GET /data", "POST /compile", "POST /preview/sign"]);
    const by = Object.fromEntries(out.routes.map(r => [r.id, r]));
    assert.equal(by["data-system"].ok, false);
    assert.equal(by["data-system"].storable, true);
    assert.equal(by["data-connection"].ok, true);
    assert.equal(by["preview-sign"].carriesSignedRequest, true);
    assert.equal(out.ok, false);
    assertClean("caches", JSON.stringify(out));
  } finally {
    server.close();
  }
});

test("the document scan reports counts and paths only, across pages", async () => {
  const docs = {
    compiles: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, data: i === 3 ? { data: { request: { signature: `$02$${"1".repeat(64)}` } } } : { data: { ok: true } } })),
    artifacts: [{ id: "a1", data: { output: JSON.stringify({ security: { signature: `$02$${"2".repeat(64)}` } }) } }],
    "artifact-heads": [],
    publications: [{ id: "p1", data: { taskId: "t" } }],
  };
  const listPage = async (db, collection, after, limit) => {
    const all = docs[collection];
    const start = after ? all.findIndex(d => d.id === after) + 1 : 0;
    return all.slice(start, start + limit);
  };
  const out = await scanDocuments({ listPage, pageSize: 2 });
  const by = Object.fromEntries(out.collections.map(c => [c.collection, c]));
  assert.equal(by.compiles.scanned, 5);
  assert.deepEqual(by.compiles.hits, [{ doc: "compiles/c3", fields: ["data.request.signature"] }]);
  assert.equal(by.artifacts.withSignature, 1);
  assert.equal(out.ok, false);
  assertClean("scan", JSON.stringify(out));
  assert.deepEqual(signaturePaths({ a: [{ signature: "x" }] }), ["a[0].signature"]);
});

// --- The broker signer ----------------------------------------------------------------

test("the broker signer takes the canary's path and seals what Broker signs", async () => {
  const calls = [];
  let tokens = 0;
  const request = { consumer_key: "k", timestamp: "20261016-1200", user_id: "u", signature: `$02$${"7".repeat(64)}`, questions: [] };
  // The api returns an encoded chain id; Policy's admission takes the decoded task ids.
  const taskId = Buffer.from(JSON.stringify({ taskIds: ["raw-task-1"] })).toString("base64url");
  const fake = async ({ url, body }) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const data = {
      "/task": { id: taskId },
      "/v1/invocations": { invocationToken: "inv", contract: 2 },
      "/preflight": { manifest: { stage: "s0" } },
      "/v1/admissions": { admissionToken: "adm" },
      "/v1/snapshot": { sessionToken: "sess", allowed: ["init"] },
      "/v1/mint": { executionToken: "exec" },
      "/v1/execute": { status: "succeeded", result: { request } },
    }[path];
    if (path === "/v1/admissions") assert.deepEqual(body.taskIds, ["raw-task-1"]);
    if (path === "/v1/snapshot") assert.equal(body.admissionToken, "adm");
    if (path === "/v1/execute") assert.equal(body.op, "learnosity.sign-questions-preview");
    return { status: 200, json: { data } };
  };
  const signer = createBrokerSigner({
    http: fake,
    idToken: async (account, audience) => `id:${account}:${audience}`,
    accessToken: async () => { tokens++; return "user-token"; },
    parse: async () => ({}),
    config: { apiUrl: "https://api.test", policyUrl: "https://policy.test", brokerUrl: "https://broker.test", gatewayAccount: "api-run@x", compilerAccount: "l0176-run@x", connectionId: "conn-1", languageUrl: "https://l0176.test" },
  });
  const signed = await signer.sign("questions", { id: "x", questions: [] });
  assert.ok(signed instanceof SignedRequest);
  assert.deepEqual(calls, ["/task", "/v1/invocations", "/preflight", "/v1/admissions", "/v1/snapshot", "/v1/mint", "/v1/execute"]);
  assert.equal(unseal(signed).signature, request.signature);
  assertClean("broker sealed", JSON.stringify(signed));
  await assert.rejects(signer.sign("questions", {}, { expires: Date.now() }), /Broker sets its own expires/);
  // Each signing fetches its own user token: a long case's controls sign minutes later.
  const before = tokens;
  await signer.sign("questions", { id: "y", questions: [] });
  assert.equal(tokens, before + 1);
});

test("Question Editor gets each question without its response_id", () => {
  const widgets = qeWidgets(L0158_ACTIVITY);
  assert.equal(widgets.length, 2);
  assert.ok(widgets.every(w => !("response_id" in w) && typeof w.type === "string"));
});

// --- Service separation (plan rev 8) ---------------------------------------------

// A provider that accepts a request only when its signature isn't one of the
// Questions previews' (or, with `acceptAll`, always; with `controlsFail`, never).
const separationRig = async ({ acceptAll = false, controlsFail = false } = {}) => {
  const clock = fakeClock();
  const questionSigs = new Set();
  const { signer: raw } = countingSigner(clock);
  const signer = { ...raw, sign: async (...a) => { const s = await raw.sign(...a); questionSigs.add(unseal(s).signature); return s; } };
  const accepts = sig => (acceptAll || !questionSigs.has(sig)) && !(controlsFail && !questionSigs.has(sig));
  const pw = fakePlaywright({ decide: (api, req) => accepts(req?.security?.signature) });
  const browser = await createBrowserDriver({ launch: pw.launch });
  const dataCalls = [];
  const fetch = async (url, { body }) => {
    const security = JSON.parse(body.get("security"));
    dataCalls.push({ url, signature: security.signature, hasRequest: body.has("request"), action: body.get("action") });
    // Fixture writes and cleanup always succeed; only reads are judged.
    const ok = body.get("action") === "set" || (!questionSigs.has(security.signature) && body.get("request") && JSON.parse(body.get("request")).references) ? true : accepts(security.signature);
    return { ok: true, status: 200, json: async () => ({ meta: { status: ok, ...(ok ? {} : { message: `refused for ${KEY}` }) }, data: [] }) };
  };
  const sdk = new LearnositySDK();
  const creds = loadRawCredentials(ENV);
  const ctx = caseCtx(pw, clock, {
    signer,
    browser,
    fetch,
    consumerKey: KEY,
    manifest: createManifest({ file: "m.json", fs: memfs() }),
    dataApi: createDataApi({ sdk, credentials: creds, fetch }),
    rawInit: (service, body, action) => sdk.init(service, { consumer_key: creds.key, domain: creds.domain, user_id: "u", timestamp: lrnTime(clock.now()) }, creds.secret, structuredClone(body), action),
  });
  return { ctx, pw, dataCalls, questionSigs };
};

test("separation: the Questions preview's packet goes, unchanged, to every other service, each beside its control", async () => {
  const { ctx, pw, dataCalls, questionSigs } = await separationRig();
  const out = await separationCase(ctx);
  assert.deepEqual(out.results.map(r => [r.id, r.verdict]), SEPARATION_TARGETS.map(t => [t.id, "refused"]));
  assert.equal(out.separated, true);
  assert.match(out.conclusion, /every other service refused/);
  // The browser attempts carry the Questions packet's fields, plus the signed
  // domain, and nothing else, as their security.
  const attempts = pw.seen.inits.filter(i => questionSigs.has(i.request.security?.signature));
  assert.equal(attempts.length, 2);
  for (const a of attempts) {
    assert.deepEqual(Object.keys(a.request.security).sort(), ["consumer_key", "domain", "signature", "timestamp", "user_id"]);
    assert.equal(a.request.security.domain, "l0176.graffiticode.org");
  }
  assert.deepEqual(pw.seen.inits.map(i => i.api), ["items", "items", "author", "author"]);
  // Items renders the published fixture, in the attempt and the control alike.
  const fixtureRef = pw.seen.inits[0].request.request.items[0];
  assert.match(fixtureRef, /^at10-t1-sep$/);
  assert.equal(pw.seen.inits[1].request.request.items[0], fixtureRef);
  assert.ok(pw.seen.gotos.some(u => u.includes("api=author")));
  // The Data API attempts: get only, with and without a request.
  const dataAttempts = dataCalls.filter(c => questionSigs.has(c.signature));
  assert.deepEqual(dataAttempts.map(c => [c.action, c.hasRequest]), [["get", true], ["get", false]]);
  // The fixture is cleaned up.
  assert.ok(out.cleanup);
  assertClean("separation evidence", JSON.stringify(out));
});

test("separation: any service accepting the packet fails A3; a failed control makes it inconclusive", async () => {
  const failed = await separationCase((await separationRig({ acceptAll: true })).ctx);
  assert.equal(failed.separated, false);
  assert.deepEqual(failed.accepted, SEPARATION_TARGETS.map(t => t.id));
  assert.match(failed.conclusion, /^A3 FAILS/);
  const unclear = await separationCase((await separationRig({ controlsFail: true })).ctx);
  assert.ok(unclear.results.every(r => r.verdict === "inconclusive"));
  assert.match(unclear.conclusion, /^inconclusive/);
  // A provider message echoing the key never reaches the evidence.
  assertClean("refusal reasons", JSON.stringify(unclear));
});

test("separation needs the raw credential for its controls, and isn't allowed against the system consumer", async () => {
  const { ctx } = await separationRig();
  await assert.rejects(separationCase({ ...ctx, rawInit: null }), /raw sandbox credential/);
  assert.throws(() => parseArgs(["separation", "--system"]), /--system/);
  assert.equal(planCase("separation").needs.raw, true);
});

test("separation: the packet is the security fields, with the signed domain added when the request has none", () => {
  const req = { consumer_key: "k", user_id: "u", timestamp: "t", signature: "s", questions: [], type: "local_practice" };
  assert.deepEqual(securityPacket(req, "d.org"), { consumer_key: "k", user_id: "u", timestamp: "t", signature: "s", domain: "d.org" });
  assert.equal(securityPacket({ ...req, domain: "own.org" }, "d.org").domain, "own.org");
});

test("scope: item-bank calls are the Data or Author API, or an item-bank path", () => {
  const e = (host, path) => ({ method: "POST", host, path, status: 200 });
  assert.deepEqual(itemBankCalls([
    e("questions.learnosity.com", "/v2026.2.LTS/math/score"),
    e("questions.learnosity.com", "/v2026.2.LTS/session/save"),
    e("data.learnosity.com", "/v2025.2.LTS/itembank/items"),
    e("authorapi.learnosity.com", "/v2026.2.LTS/consumersettings"),
    e("items.learnosity.com", "/v2026.2.LTS/itembank/questions"),
  ]).map(x => x.host), ["data.learnosity.com", "authorapi.learnosity.com", "items.learnosity.com"]);
});

test("scope --no-store leaves out the step that stores a response", () => {
  const ids = steps => steps.map(s => s.id);
  assert.ok(ids(planCase("scope").steps).includes("store-submit_practice"));
  const opts = parseArgs(["scope", "--no-store"]);
  assert.equal(opts.store, false);
  assert.ok(!ids(planCase("scope", opts).steps).includes("store-submit_practice"));
  assert.ok(planCase("scope", opts).steps.every(s => !s.action));
});

// Registry v8 (B1): a Broker save writes under references of its own and
// returns them. The case reads those back, and tears them down too.
test("drafts reads back, and cleans up, the references a v8 save actually wrote", async () => {
  const fs = memfs();
  const manifestFile = "/m/at10-fixtures.json";
  const bank = fakeBank({ fs, manifestFile });
  const dataApi = createDataApi({ sdk: new LearnositySDK(), credentials: loadRawCredentials(ENV), fetch: bank.fetch });
  const manifest = createManifest({ file: manifestFile, fs });
  const raw = createRawSaver(dataApi);
  let n = 0;
  // Like Broker v8: every reference gets a per-save prefix, links included.
  const mapping = {
    kind: "broker",
    write: async ({ questionRecords, itemRecords }) => {
      const tag = `gc-${String(++n).padStart(16, "0")}-`;
      const map = r => `${tag}${r}`;
      return raw.write({
        questionRecords: questionRecords.map(q => ({ ...q, reference: map(q.reference) })),
        itemRecords: itemRecords.map(it => ({ ...it, reference: map(it.reference), definition: { widgets: it.definition.widgets.map(w => ({ reference: map(w.reference) })) }, questions: it.questions.map(w => ({ reference: map(w.reference) })) })),
      });
    },
  };
  const out = await draftsCase({ dataApi, saver: mapping, manifest, runId: "r2", signer: null, opts: {} });
  const r = out.results;
  assert.equal(r.a.reference, "mapped");
  assert.equal(r.a.unpublished, true);
  assert.equal(r.a.sentReferenceUntouched, true);
  assert.equal(r.b.reference, "mapped");
  assert.equal(r.b.questionStored, true);
  // B1: published content no longer changes.
  assert.equal(r.c.publishedContentChanged, false);
  assert.equal(r.f.itemUnpublished, false);
  assert.equal(r.e.publishedItemUnchanged, true);
  // Every mapped item was recorded and archived.
  const m = JSON.parse(fs.files.get(manifestFile));
  assert.ok(m.entries.some(e => e.reference.startsWith("gc-")));
  assert.ok([...bank.store["/itembank/items"].values()].every(i => i.status === "archived"));
  assert.equal(r.cleanup.failed, 0);
});
