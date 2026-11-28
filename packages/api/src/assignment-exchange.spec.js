// C4's assignment exchange and freeze in an interpreted stage (assignment-exchange.js, wired
// through data.js), against the Firestore emulator's assignment store. The language is a
// fake L0182: its program lists survey occurrences, and it asks for, or is served, each one
// as the real dialect does. Every test writes under its own random collection prefix; nothing
// is cleared or deleted.

import { jest } from "@jest/globals";
import { createHash, randomUUID } from "node:crypto";
import { canonicalDigest } from "@graffiticode/common/canonical";
import { admin } from "./storage/firebase.js";
import { buildAssignmentStore, identityKey } from "./assignments.js";
import { MAX_ATTEMPTS, MAX_CALLS, answeredIdentities } from "./assignment-exchange.js";
import { buildDataApi } from "./data.js";
import { getInterpreterLanguages } from "./interpret.js";
import { buildMemoryStageResultStorer } from "./storage/stage-results.js";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error("assignment-exchange.spec.js: FIRESTORE_EMULATOR_HOST is not set; run it under the Firestore emulator");
}

const db = admin.firestore();
const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");

/** @type {(uid: string) => any} */
const user = uid => ({ kind: "user", uid, installation: "graffiticode" });
/** @type {(workspace: string) => any} */
const freePlan = workspace => ({ kind: "freePlan", uid: "trial", workspace, installation: "graffiticode" });
const P = user("p");
const WS_A = freePlan("ws-a");
const WS_B = freePlan("ws-b");
const context = principal => () => Promise.resolve({ principal });

const version = (instance, body = instance) => {
  const content = JSON.stringify({ style: "ranked-choice", options: [body] });
  return { instance, digest: sha256(content), content };
};
const CATALOG = { "civic-priorities": [1, 2, 3].map(n => version(`civic-priorities-${n}`)) };

// The fake L0182. A program is { surveys: [{ id, session | sessionFrom, answer }] }; a survey
// whose session is another's instance (`sessionFrom: i`) waits for it, as a suspended one does.
const interpretL0182 = (program, table, catalog = CATALOG) => {
  const requests = [];
  const shown = [];
  for (const [i, s] of program.surveys.entries()) {
    // A derived session names its link too, so a chain never revisits an identity.
    const from = s.sessionFrom === undefined ? undefined : shown[s.sessionFrom];
    const session = s.sessionFrom === undefined ? s.session : from && `${from.survey.instance}/${i}`;
    if (session === undefined) {
      shown.push(undefined);
      continue;
    }
    const key = identityKey(s.id, session);
    const entry = table?.[key];
    if (!entry) {
      if (!requests.some(r => r.key === key)) {
        requests.push({ identity: { survey: s.id, session }, key, ordinal: i, candidates: catalog[s.id] ?? [] });
      }
      shown.push(undefined);
      continue;
    }
    const record = { survey: { id: s.id, sessionId: session, instance: entry.instance } };
    if (s.answer) record.response = { choices: [entry.instance] };
    shown.push(record);
  }
  if (requests.length) return { needsAssignment: requests, revision: "r1" };
  return { data: shown.length === 1 ? shown[0] : shown, errors: [], revision: "r1" };
};

/** @type {any} */
const DECLARATIONS = {
  "0182": { interpreter: "interpreter", cacheCaps: { evaluate: "private", present: "private" }, getOrCreate: true },
  "0900": { interpreter: "interpreter", cacheCaps: { evaluate: "immutable", present: "immutable" } },
};
const ON = { INTERPRETER_L0182: "on", INTERPRETER_L0900: "on" };

const encodeId = taskIds => Buffer.from(JSON.stringify({ taskIds }), "utf8").toString("base64url");
const memoryTasks = () => {
  const tasks = new Map();
  return {
    async create({ task }) {
      const key = canonicalDigest(task).slice(0, 16);
      tasks.set(key, { lang: task.lang, code: task.code });
      return encodeId([key]);
    },
    async get({ id }) {
      return id.split(/[ +]/g)
        .flatMap(part => JSON.parse(Buffer.from(part, "base64url").toString("utf8")).taskIds)
        .map(key => tasks.get(key));
    },
  };
};
const memoryCompiles = () => ({ async get() { return undefined; }, async create({ id }) { return id; } });

/** @param {any} [options] */
const setup = async ({ answers = {}, interpretReply = null, wrapStore = null, withStore = true, env = ON } = {}) => {
  const store = buildAssignmentStore({ db, prefix: `x-${randomUUID().slice(0, 8)}-`, pick: () => 0 });
  await store.setCutover({ from: "backfill", to: "reconciling" });
  await store.setCutover({ from: "reconciling", to: "done" });
  const calls = [];
  const stages = [];
  /** @type {any} */
  const interpreter = {
    model: jest.fn(async ({ lang, code }) => ({
      model: { lang, kind: "plan", digest: canonicalDigest({ lang, code }), program: code },
      errors: [],
      revision: "r1",
    })),
    interpret: jest.fn(async ({ lang, model, input, mode, assignments }) => {
      calls.push({ lang, assignments: assignments ? { ...assignments } : undefined });
      if (lang !== "0182") return { data: { by: lang, from: input }, errors: [], revision: "r1" };
      return interpretReply ? interpretReply(model.program, assignments) : interpretL0182(model.program, assignments);
    }),
  };
  const stageResults = buildMemoryStageResultStorer();
  jest.spyOn(stageResults, "get");
  jest.spyOn(stageResults, "put");
  const respondentAuthority = jest.fn(async (/** @type {any} */ sessions) => {
    const out = Object.create(null);
    for (const s of sessions) if (Object.hasOwn(answers, s)) out[s] = answers[s];
    return out;
  });
  const assignments = withStore ? (wrapStore ? wrapStore(store) : store) : null;
  /** @type {any} */
  const dataApi = buildDataApi(/** @type {any} */ ({
    compile: jest.fn(async () => ({ data: {}, errors: [] })),
    interpreter,
    stageResults,
    getInterpreterLanguages: () => getInterpreterLanguages(env, DECLARATIONS),
    declarations: DECLARATIONS,
    onStage: record => stages.push(record),
    assignments,
    respondentAuthority,
  }));
  const taskStorer = memoryTasks();
  const compileStorer = memoryCompiles();
  const run = async (program, more = {}) => {
    const id = await taskStorer.create({ task: { lang: "0182", code: program } });
    return dataApi.get({ taskStorer, compileStorer, id, auth: more.uid ? { uid: more.uid } : null, ...more });
  };
  const record = async (survey, session) => (await store.refs("production").record(identityKey(survey, session)).get()).data();
  return { store, interpreter, calls, stages, stageResults, respondentAuthority, run, record, taskStorer, dataApi, compileStorer };
};
const survey = (session, answer = false) => ({ id: "civic-priorities", session, answer });

describe("C4 exchange: wiring", () => {
  it("runs the exchange for a getOrCreate stage: two calls, a record, and no stage cache", async () => {
    const t = await setup();
    const out = await t.run({ surveys: [survey("s")] });
    expect(out.errors ?? []).toEqual([]);
    expect(out.data.survey).toEqual({ id: "civic-priorities", sessionId: "s", instance: "civic-priorities-1" });
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0].assignments).toEqual({});
    expect(Object.keys(t.calls[1].assignments)).toEqual([identityKey("civic-priorities", "s")]);
    expect(await t.record("civic-priorities", "s")).toMatchObject({ state: "assigned", instance: "civic-priorities-1" });
    expect(t.stageResults.get).not.toHaveBeenCalled();
    expect(t.stageResults.put).not.toHaveBeenCalled();
    expect(t.stages[0]).toMatchObject({ cache: "skip", assignment: { calls: 2, submission: null } });
    expect(t.stages[0].own.cacheClass).toBe("private");
  });

  it("leaves every other stage as it was: no table is sent, and the stage cache is used", async () => {
    const t = await setup();
    const id = await t.taskStorer.create({ task: { lang: "0900", code: { name: "x" } } });
    await t.dataApi.get({ taskStorer: t.taskStorer, compileStorer: t.compileStorer, id });
    expect(t.calls).toEqual([{ lang: "0900", assignments: undefined }]);
    expect(t.stageResults.put).toHaveBeenCalled();
  });

  it("without the interpreter flag, a getOrCreate language runs as today, with no exchange", async () => {
    const t = await setup({ env: { INTERPRETER_L0900: "on" } });
    await t.run({ surveys: [survey("s")] });
    expect(t.interpreter.interpret).not.toHaveBeenCalled();
  });

  it("a getOrCreate stage with no store fails closed", async () => {
    const t = await setup({ withStore: false });
    const out = await t.run({ surveys: [survey("s")] });
    expect(out.data).toBeNull();
    expect(out.errors[0]).toMatchObject({ code: "assignment-unavailable", category: "unavailable" });
  });
});

describe("C4 exchange: progress and the call ceiling", () => {
  it("a dependency chain takes one call per link", async () => {
    const t = await setup();
    const surveys = [survey("root"), ...[0, 1, 2].map(i => ({ id: "civic-priorities", sessionFrom: i }))];
    const out = await t.run({ surveys });
    expect(out.errors ?? []).toEqual([]);
    expect(t.calls).toHaveLength(5);
  });

  it(`a chain deeper than ${MAX_CALLS} calls fails with assignment-depth`, async () => {
    const t = await setup();
    const surveys = [survey("root"), ...Array.from({ length: MAX_CALLS }, (_, i) => ({ id: "civic-priorities", sessionFrom: i }))];
    const out = await t.run({ surveys });
    expect(out.data).toBeNull();
    expect(out.errors[0].code).toBe("assignment-depth");
    expect(t.calls).toHaveLength(MAX_CALLS);
  });

  it("a language that asks again for what it was given fails with assignment-stalled", async () => {
    const request = { identity: { survey: "civic-priorities", session: "s" }, key: identityKey("civic-priorities", "s"), ordinal: 0, candidates: CATALOG["civic-priorities"] };
    const t = await setup({ interpretReply: () => ({ needsAssignment: [request], revision: "r1" }) });
    const out = await t.run({ surveys: [survey("s")] });
    expect(out.errors[0].code).toBe("assignment-stalled");
    expect(t.calls).toHaveLength(2);
    const empty = await setup({ interpretReply: () => ({ needsAssignment: [], revision: "r1" }) });
    expect((await empty.run({ surveys: [survey("s")] })).errors[0].code).toBe("assignment-stalled");
  });

  it("a store refusal fails the stage with its code: a quarantined task", async () => {
    const t = await setup();
    const program = { surveys: [survey("q")] };
    const id = await t.taskStorer.create({ task: { lang: "0182", code: program } });
    const taskId = JSON.parse(Buffer.from(id, "base64url").toString("utf8")).taskIds[0];
    await t.store.refs("production").quarantine(taskId).set({ taskId, reasons: ["computed-session"] });
    const out = await t.dataApi.get({ taskStorer: t.taskStorer, compileStorer: t.compileStorer, id });
    expect(out.errors[0]).toMatchObject({ code: "assignment-under-review", category: "conflict" });
  });
});

describe("C4 exchange: freezing before success", () => {
  it("the respondent's response is frozen before the result returns", async () => {
    const t = await setup({ answers: { s: { principal: WS_A } } });
    const out = await t.run({ surveys: [survey("s", true)] }, { caller: context(WS_A) });
    expect(out.errors ?? []).toEqual([]);
    expect(out.data.response).toBeDefined();
    expect((await t.record("civic-priorities", "s")).frozen).toMatchObject({ principal: WS_A, revision: 0, basis: "derived" });
    expect(await t.store.retained(CATALOG["civic-priorities"][0].digest)).toBe(CATALOG["civic-priorities"][0].content);
    expect(t.stages[0].assignment.submission).toBe("frozen");
  });

  it("another principal's response is served as a read, and nothing is frozen", async () => {
    const t = await setup({ answers: { s: { principal: WS_A } } });
    const out = await t.run({ surveys: [survey("s", true)] }, { caller: context(WS_B) });
    expect(out.errors ?? []).toEqual([]);
    expect((await t.record("civic-priorities", "s")).frozen).toBeUndefined();
    expect(t.stages[0].assignment.submission).toBe("read");
  });

  it("an anonymous response is a read, and the caller context isn't needed for one without a response", async () => {
    const t = await setup({ answers: { s: { principal: WS_A } } });
    await t.run({ surveys: [survey("s", true)] });
    expect((await t.record("civic-priorities", "s")).frozen).toBeUndefined();
    expect(t.stages[0].assignment.submission).toBe("read");
    const caller = jest.fn(() => Promise.reject(new Error("never built")));
    const quiet = await setup();
    const out = await quiet.run({ surveys: [survey("t")] }, { caller });
    expect(out.errors ?? []).toEqual([]);
    expect(caller).not.toHaveBeenCalled();
  });

  it("a mixed-ownership response freezes only the caller's identities", async () => {
    const t = await setup({ answers: { mine: { principal: WS_A }, theirs: { principal: WS_B } } });
    const out = await t.run({ surveys: [survey("mine", true), survey("theirs", true)] }, { caller: context(WS_A) });
    expect(out.errors ?? []).toEqual([]);
    expect((await t.record("civic-priorities", "mine")).frozen.principal).toEqual(WS_A);
    expect((await t.record("civic-priorities", "theirs")).frozen).toBeUndefined();
  });

  it("a bound session is decided by its binding", async () => {
    const t = await setup({ answers: { s: { principal: WS_A } } });
    await t.store.refs("production").binding("s").set({ session: "s", active: { principal: P, revision: 1, opId: "op-1", destination: "d" }, prepared: null });
    await t.run({ surveys: [survey("s", true)] }, { caller: context(WS_A) });
    expect((await t.record("civic-priorities", "s")).frozen).toBeUndefined();
    await t.run({ surveys: [survey("s", true)] }, { caller: context(P) });
    expect((await t.record("civic-priorities", "s")).frozen).toMatchObject({ principal: P, revision: 1, basis: "binding" });
  });
});

describe("C4 exchange: failing closed", () => {
  it("unavailable respondent authority fails the stage and serves nothing", async () => {
    const t = await setup({ answers: {} });
    const out = await t.run({ surveys: [survey("s", true)] }, { caller: context(WS_A) });
    expect(out.data).toBeNull();
    expect(out.errors[0]).toMatchObject({ code: "respondent-authority-unavailable", category: "unavailable" });
    expect((await t.record("civic-priorities", "s")).frozen).toBeUndefined();
  });

  it("an unattested free-plan caller can't submit, and its response isn't served", async () => {
    const t = await setup({ answers: { s: { principal: WS_A } } });
    const out = await t.run({ surveys: [survey("s", true)] }, { caller: context({ kind: "freePlan", uid: "trial", installation: "graffiticode" }) });
    expect(out.errors[0].code).toBe("respondent-unattested");
  });

  it("a caller identity that doesn't verify fails the stage rather than reading as absent", async () => {
    const t = await setup({ answers: { s: { principal: WS_A } } });
    const bad = Object.assign(new Error("invalid caller identity"), { reason: "frontend-identity-invalid" });
    const out = await t.run({ surveys: [survey("s", true)] }, { caller: () => Promise.reject(bad) });
    expect(out.errors[0]).toMatchObject({ code: "frontend-identity-invalid", category: "authentication" });
  });
});

describe("C4 exchange: contention", () => {
  // A store whose record moves under the stage `times` times before its freeze.
  const moving = times => store => {
    let left = times;
    return {
      resolve: args => store.resolve(args),
      submit: async args => {
        if (left-- > 0) {
          const u = args.used[0];
          const rest = CATALOG["civic-priorities"].filter(c => c.instance !== u.instance);
          await store.resolve({ requests: [{ identity: { survey: u.survey, session: u.session }, key: u.key, ordinal: 0, candidates: rest }], taskId: "mover" });
        }
        return store.submit(args);
      },
    };
  };

  it("a record that changes before the freeze reruns the stage, which then freezes what it served", async () => {
    const t = await setup({ answers: { s: { principal: WS_A } }, wrapStore: moving(1) });
    const out = await t.run({ surveys: [survey("s", true)] }, { caller: context(WS_A) });
    expect(out.errors ?? []).toEqual([]);
    const record = await t.record("civic-priorities", "s");
    expect(record.frozen.principal).toEqual(WS_A);
    expect(out.data.survey.instance).toBe(record.instance);
    expect(t.calls).toHaveLength(4); // the exchange's two calls, then the rerun's two
  });

  it(`a record that keeps changing fails with assignment-contended after ${MAX_ATTEMPTS} attempts, unserved`, async () => {
    const t = await setup({ answers: { s: { principal: WS_A } }, wrapStore: moving(MAX_ATTEMPTS) });
    const out = await t.run({ surveys: [survey("s", true)] }, { caller: context(WS_A) });
    expect(out.data).toBeNull();
    expect(out.errors[0]).toMatchObject({ code: "assignment-contended", category: "unavailable" });
    expect((await t.record("civic-priorities", "s")).frozen).toBeUndefined();
  });

  it("two concurrent first runs of one identity share one record", async () => {
    const t = await setup();
    const outs = await Promise.all([1, 2, 3].map(() => t.run({ surveys: [survey("c")] })));
    expect(new Set(outs.map(o => o.data.survey.instance)).size).toBe(1);
  }, 30000);
});

describe("C4 exchange: answered identities", () => {
  it("counts only served identities with a response, at the served version", () => {
    const served = new Map([[identityKey("a", "s"), { survey: "a", session: "s", instance: "a-1", digest: "d", content: "c" }]]);
    const data = [
      { survey: { id: "a", sessionId: "s", instance: "a-1" }, response: {} },
      { survey: { id: "a", sessionId: "s", instance: "a-2" }, response: {} }, // another version: not this run's
      { survey: { id: "b", sessionId: "s", instance: "b-1" }, response: {} }, // never served
      { survey: { id: "a", sessionId: "t", instance: "a-1" } }, // no response
    ];
    expect(answeredIdentities(data, served)).toEqual([{ key: identityKey("a", "s"), survey: "a", session: "s", instance: "a-1", digest: "d", content: "c" }]);
  });
});
