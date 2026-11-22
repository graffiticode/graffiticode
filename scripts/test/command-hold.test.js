/* eslint-disable camelcase -- token-info's and the credential's fields are snake_case */
// scripts/command-hold.js's rules (C5d, docs/c5d-refusal-and-hold-plan.md
// decision 9, §4 "The identity"), offline: token-info, the credential, gcloud
// and Firestore are fakes, and the hold store is Policy's memory one.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryInvocationStore, createMemoryCommandStore, createMemoryHolds, commandIdFor, HOLD_MARGIN_MS } from "@graffiticode/policy";
import gax from "google-gax";
import firestore from "@google-cloud/firestore";
import { AUTH_SCOPES, C5D_INTENT_DIR, DEFAULT_INTENT_DIR, TOKENINFO_URL, HoldRefused, createAuthClient, parse, policyFirestore, runAct, verifyIdentity } from "../lib/command-hold.js";

const { GoogleAuth } = gax;
const { Firestore: RealFirestore, v1: FirestoreGapic } = firestore;

const OPERATOR = "owner@example.com";
const TOKEN = "ya29.secret-access-token-value";
const T0 = Date.parse("2026-11-20T19:55:14Z");
const GOOD_INFO = { azp: "764086051850-abc.apps.googleusercontent.com", aud: "764086051850-abc.apps.googleusercontent.com", scope: "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform", exp: "1795000000", expires_in: "3599", email: OPERATOR, email_verified: "true", access_type: "offline" };

// A pending command whose lease ended at T0, in Policy's memory stores. The
// auth client answers `tokens` in turn (then the last); token-info answers
// `infoFor(token)`. Every Firestore client built is recorded with its settings.
const world = async ({ info = GOOD_INFO, infoFor = null, tokens = [TOKEN], status = 200, account = OPERATOR, tokenError = null, fetchError = null } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "command-hold-"));
  const commandStore = createMemoryCommandStore({ invocationStore: createMemoryInvocationStore() });
  const { command } = await commandStore.allocate({ uid: "0xowner", connectionId: null, taskId: "task-1", inputDigest: "d".repeat(64), idempotencyKey: "k-1", lang: "0013", request: "{}", worker: "api-1", now: T0 - 60_000, scopes: 1 });
  const holds = createMemoryHolds({ commandStore, now: () => T0 + HOLD_MARGIN_MS + 1 });
  const calls = { fetch: [], tokens: 0, firestores: [], dbs: [], acts: [] };
  const auth = {
    getAccessToken: async () => {
      if (tokenError) throw tokenError;
      return tokens[Math.min(calls.tokens++, tokens.length - 1)];
    },
  };
  class Firestore {
    constructor(settings) {
      calls.firestores.push(settings);
      this.settings = settings;
    }
  }
  const deps = {
    root,
    fs,
    auth,
    Firestore,
    projectId: "graffiticode",
    createHolds: async db => {
      calls.dbs.push(db);
      return {
        applyHold: async r => {
          calls.acts.push(r);
          return holds.applyHold(r);
        },
        liftHold: async r => {
          calls.acts.push(r);
          return holds.liftHold(r);
        },
      };
    },
    fetch: async (url, init) => {
      calls.fetch.push({ url, init });
      if (fetchError) throw fetchError;
      const token = new URLSearchParams(init.body).get("access_token");
      return { ok: status === 200, status, json: async () => (infoFor ? infoFor(token) : info) };
    },
    gcloudAccount: async () => account,
    randomUUID: () => "11111111-2222-4333-8444-555555555555",
    now: () => T0 + 1,
  };
  return { root, deps, auth, calls, commandStore, holds, commandId: command.commandId };
};
const applyArgs = (commandId, extra = []) => ["apply", commandId, "--reason", "definite-refusal-unsettled", "--note", "staging gone; held until Step 34", "--decision", "docs/c5d-refusal-and-hold-plan.md", "--operator", OPERATOR, ...extra];
const files = async dir => {
  try {
    return await readdir(dir, { recursive: true });
  } catch {
    return [];
  }
};
const refused = async (promise, reason) => {
  await assert.rejects(promise, e => {
    assert.ok(e instanceof HoldRefused, e?.message);
    assert.equal(e.reason, reason);
    assert.ok(!String(e.message).includes(TOKEN), "a refusal never carries the token");
    return true;
  });
};

test("applies a hold with the verified identity, writing the intent first, and the token nowhere", async () => {
  const w = await world();
  w.deps.createHolds = (open => async db => {
    const holds = await open(db);
    return {
      ...holds,
      applyHold: async r => {
        // The intent file exists before the first send.
        const intent = JSON.parse(await readFile(join(w.root, DEFAULT_INTENT_DIR, "11111111-2222-4333-8444-555555555555.intent.json"), "utf8"));
        assert.equal(intent.actId, "11111111-2222-4333-8444-555555555555");
        return holds.applyHold(r);
      },
    };
  })(w.deps.createHolds);
  const out = await runAct(parse(applyArgs(w.commandId)), w.deps);
  assert.deepEqual(out.appliedBy, { email: OPERATOR, verifiedVia: "tokeninfo", azp: GOOD_INFO.azp });
  assert.equal(out.result.replayed, false);
  assert.deepEqual(out.result.record.appliedBy, out.appliedBy);
  assert.equal(out.result.record.n, 1);
  assert.equal(w.commandStore.commands.get(w.commandId).hold.actId, "11111111-2222-4333-8444-555555555555");
  // Token-info was asked twice (before Firestore, and before the act), by
  // POST, with the token only in the body.
  assert.equal(w.calls.fetch.length, 2);
  for (const call of w.calls.fetch) {
    assert.equal(call.url, TOKENINFO_URL);
    assert.equal(call.init.method, "POST");
    assert.ok(!call.url.includes(TOKEN));
  }
  // The intent: the complete request, note and lift target included.
  const path = join(w.root, DEFAULT_INTENT_DIR, "11111111-2222-4333-8444-555555555555.intent.json");
  assert.equal(out.intentPath, path);
  const text = await readFile(path, "utf8");
  assert.deepEqual(JSON.parse(text), {
    schema: 1,
    actId: "11111111-2222-4333-8444-555555555555",
    commandId: w.commandId,
    act: "apply",
    reason: "definite-refusal-unsettled",
    note: "staging gone; held until Step 34",
    decision: "docs/c5d-refusal-and-hold-plan.md",
    decidedBy: "owner",
    lifts: null,
    operator: OPERATOR,
    createdAt: new Date(T0 + 1).toISOString(),
  });
  for (const written of [text, JSON.stringify(out), JSON.stringify([...w.commandStore.commands.values()]), JSON.stringify(w.calls.acts)]) {
    assert.ok(!written.includes(TOKEN), "the token is never written or answered");
  }
});

test("replays a retry from its intent file exactly, writing nothing", async () => {
  const w = await world();
  const first = await runAct(parse(applyArgs(w.commandId)), w.deps);
  const before = [JSON.stringify(w.commandStore.commands.get(w.commandId)), await readFile(first.intentPath, "utf8"), (await stat(first.intentPath)).mtimeMs, await files(w.root)];
  // A retry reuses the act id, never a new one.
  w.deps.randomUUID = () => assert.fail("a retry generates no act id");
  const again = await runAct(parse(["apply", "--intent", first.intentPath, "--operator", OPERATOR]), w.deps);
  assert.equal(again.result.replayed, true);
  assert.deepEqual(again.result.record, first.result.record);
  assert.deepEqual(w.calls.acts[1], w.calls.acts[0]);
  const after = [JSON.stringify(w.commandStore.commands.get(w.commandId)), await readFile(first.intentPath, "utf8"), (await stat(first.intentPath)).mtimeMs, await files(w.root)];
  assert.deepEqual(after, before);
});

test("sends a retry whose first send never committed, as the same act", async () => {
  const w = await world();
  const open = w.deps.createHolds;
  w.deps.createHolds = async () => ({ applyHold: async () => { throw new Error("unavailable"); } });
  await assert.rejects(runAct(parse(applyArgs(w.commandId)), w.deps), /unavailable/);
  const intentPath = join(w.root, DEFAULT_INTENT_DIR, "11111111-2222-4333-8444-555555555555.intent.json");
  w.deps.createHolds = open;
  const out = await runAct(parse(["apply", w.commandId, "--intent", intentPath, "--operator", OPERATOR]), w.deps);
  assert.equal(out.result.replayed, false);
  assert.equal(out.result.record.actId, "11111111-2222-4333-8444-555555555555");
});

test("lifts the hold it names, recording the lift target in its intent, and keeps C5d's intents at C5d's location", async () => {
  const w = await world();
  const applied = await runAct(parse(applyArgs(w.commandId, ["--intent-dir", C5D_INTENT_DIR])), w.deps);
  assert.equal(applied.intentPath, join(w.root, "docs/evidence/c5d/hold/11111111-2222-4333-8444-555555555555.intent.json"));
  w.deps.randomUUID = () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const lifted = await runAct(parse(["lift", w.commandId, "--lifts", applied.intent.actId, "--reason", "owner-lifted", "--note", "lifted", "--decision", "#999", "--operator", OPERATOR]), w.deps);
  assert.equal(lifted.result.record.n, 2);
  assert.equal(lifted.result.record.lifts, applied.intent.actId);
  assert.equal(JSON.parse(await readFile(lifted.intentPath, "utf8")).lifts, applied.intent.actId);
  assert.equal(w.commandStore.commands.get(w.commandId).hold, undefined);
});

test("writes an intent file once", async () => {
  const w = await world();
  await runAct(parse(applyArgs(w.commandId)), w.deps);
  // The same act id again (a generator that repeats) is refused before any send.
  await refused(runAct(parse(applyArgs(w.commandId)), w.deps), "intent-exists");
  assert.equal(w.calls.acts.length, 1);
});

// Every identity refusal comes before any Firestore call, and writes no intent.
const refusesBefore = async (name, over, reason, args = null) => {
  test(`refuses before any Firestore call: ${name}`, async () => {
    const w = await world(over);
    await refused(runAct(parse(args ? args(w.commandId) : applyArgs(w.commandId)), w.deps), reason);
    assert.deepEqual(w.calls.firestores, []);
    assert.deepEqual(w.calls.acts, []);
    assert.deepEqual(await files(join(w.root, "docs")), []);
    assert.equal(w.commandStore.commands.get(w.commandId).hold, undefined);
  });
};
const without = field => {
  const { [field]: _gone, ...rest } = GOOD_INFO;
  return rest;
};
for (const field of ["email", "email_verified", "azp", "expires_in"]) {
  refusesBefore(`token-info gives no ${field}`, { info: without(field) }, "tokeninfo-field-missing");
  refusesBefore(`token-info gives an empty ${field}`, { info: { ...GOOD_INFO, [field]: "" } }, "tokeninfo-field-missing");
}
refusesBefore("the email differs from --operator", { info: { ...GOOD_INFO, email: "someone@example.com" }, account: "someone@example.com" }, "operator-mismatch");
refusesBefore("the email differs from the gcloud account", { account: "other@example.com" }, "gcloud-account-mismatch");
refusesBefore("gcloud names no account", { account: "" }, "gcloud-account-mismatch");
refusesBefore("email_verified is not true", { info: { ...GOOD_INFO, email_verified: "false" } }, "email-unverified");
refusesBefore("the email is a service account's", { info: { ...GOOD_INFO, email: "policy-run@graffiticode.iam.gserviceaccount.com" }, account: "policy-run@graffiticode.iam.gserviceaccount.com" }, "service-account",
  id => applyArgs(id).map(a => (a === OPERATOR ? "policy-run@graffiticode.iam.gserviceaccount.com" : a)));
refusesBefore("token-info answers an error", { status: 400, info: { error: "invalid_token", error_description: "Invalid Value" } }, "tokeninfo-failed");
refusesBefore("token-info answers 200 with an error", { info: { error_description: "Invalid Value" } }, "tokeninfo-failed");
refusesBefore("token-info can't be reached", { fetchError: new TypeError("fetch failed") }, "tokeninfo-failed");
refusesBefore("the token is about to expire", { info: { ...GOOD_INFO, expires_in: "59" } }, "token-expiring");
refusesBefore("the credential gives no token", { tokenError: new Error("no ADC") }, "credential-failed");

test("refuses a retry whose intent names another operator, before any Firestore call", async () => {
  const w = await world();
  const first = await runAct(parse(applyArgs(w.commandId)), w.deps);
  const other = await world({ info: { ...GOOD_INFO, email: "second@example.com" }, account: "second@example.com" });
  await refused(runAct(parse(["apply", "--intent", first.intentPath, "--operator", "second@example.com"]), other.deps), "intent-operator-mismatch");
  assert.deepEqual(other.calls.firestores, []);
});

test("refuses a retry that names another act or command than its intent", async () => {
  const w = await world();
  const first = await runAct(parse(applyArgs(w.commandId)), w.deps);
  await refused(runAct(parse(["lift", "--intent", first.intentPath, "--operator", OPERATOR]), w.deps), "intent-mismatch");
  await refused(runAct(parse(["apply", commandIdFor("0xother", "k"), "--intent", first.intentPath, "--operator", OPERATOR]), w.deps), "intent-mismatch");
  assert.equal(w.calls.fetch.length, 2);
});

test("parses only complete acts; a retry's act is its intent file's", () => {
  const id = commandIdFor("0xowner", "k-1");
  assert.equal(parse(applyArgs(id)).command, "apply");
  assert.throws(() => parse(["apply", id, "--reason", "Bad Reason", "--note", "n", "--decision", "d", "--operator", OPERATOR]), HoldRefused);
  assert.throws(() => parse(["apply", id, "--reason", "r", "--decision", "d", "--operator", OPERATOR]), /--note/);
  assert.throws(() => parse(["apply", id, "--reason", "r", "--note", "n", "--decision", "d"]), /--operator/);
  assert.throws(() => parse(["apply", id, "--reason", "r", "--note", "x".repeat(501), "--decision", "d", "--operator", OPERATOR]), /--note/);
  assert.throws(() => parse(["lift", id, "--reason", "r", "--note", "n", "--decision", "d", "--operator", OPERATOR]), /--lifts/);
  assert.throws(() => parse([...applyArgs(id), "--lifts", "11111111-2222-4333-8444-555555555555"]), /lift only/);
  assert.throws(() => parse(["apply", "--intent", "f.json", "--operator", OPERATOR, "--note", "other"]), /intent file/);
  assert.throws(() => parse(["apply", "c:nothex", "--intent", "f.json", "--operator", OPERATOR]), HoldRefused);
  assert.throws(() => parse(["hold", id]), HoldRefused);
  assert.equal(parse(["status", id]).commandId, id);
});

test("verifyIdentity accepts exactly the matching user, case aside, and records only email, verifiedVia and azp", () => {
  const appliedBy = verifyIdentity({ tokenInfo: { ...GOOD_INFO, email: "Owner@Example.com" }, operator: OPERATOR, intentOperator: OPERATOR, gcloudAccount: "owner@example.com\n" });
  assert.deepEqual(appliedBy, { email: "Owner@Example.com", verifiedVia: "tokeninfo", azp: GOOD_INFO.azp });
  assert.throws(() => verifyIdentity({ tokenInfo: { ...GOOD_INFO, email_verified: false }, operator: OPERATOR, intentOperator: OPERATOR, gcloudAccount: OPERATOR }), /not verified/);
  assert.throws(() => verifyIdentity({ tokenInfo: null, operator: OPERATOR, intentOperator: OPERATOR, gcloudAccount: OPERATOR }), /email scope/);
});

// The owner's requirement: the identity verified is the identity that
// writes. One auth client gives the verified token and is the Firestore
// client's own.
test("opens Policy's database with exactly the auth client whose token was verified", async () => {
  const w = await world();
  await runAct(parse(applyArgs(w.commandId)), w.deps);
  assert.equal(w.calls.firestores.length, 1);
  const [settings] = w.calls.firestores;
  assert.ok(settings.auth === w.auth, "the Firestore client's auth is the verified client itself");
  assert.equal(settings.databaseId, "policy");
  assert.equal(settings.projectId, "graffiticode");
  assert.ok(w.calls.dbs[0].settings === settings, "the holds run over that client");
  // Both verified tokens came from that client.
  assert.equal(w.calls.tokens, 2);
});

test("never builds a Firestore client without the auth client", async () => {
  const w = await world();
  assert.throws(() => policyFirestore({ Firestore: w.deps.Firestore, projectId: "graffiticode", auth: undefined }), e => e.reason === "no-auth-client");
  assert.throws(() => policyFirestore({ Firestore: w.deps.Firestore, projectId: "graffiticode", auth: {} }), e => e.reason === "no-auth-client");
  await refused(runAct(parse(applyArgs(w.commandId)), { ...w.deps, auth: null }), "no-auth-client");
  assert.deepEqual(w.calls.firestores, []);
  await runAct(parse(applyArgs(w.commandId)), w.deps);
  assert.ok(w.calls.firestores.length > 0 && w.calls.firestores.every(s => s.auth === w.auth));
  // The entry point builds no client from ambient credentials: no
  // firebase-admin app, and Policy's database only through policyFirestore.
  const cli = await readFile(new URL("../command-hold.js", import.meta.url), "utf8");
  assert.doesNotMatch(cli, /from "firebase-admin/);
  assert.doesNotMatch(cli, /new Firestore\(|getFirestore\(/);
  assert.match(cli, /policyFirestore\(\{ Firestore, projectId: opts\.project, auth \}\)/);
  assert.match(cli, /createAuthClient\(\{ GoogleAuth, projectId: opts\.project \}\)/);
});

test("the installed libraries hand the auth client to Firestore's transport (offline)", () => {
  const auth = createAuthClient({ GoogleAuth, projectId: "graffiticode" });
  assert.ok(auth instanceof GoogleAuth);
  const db = policyFirestore({ Firestore: RealFirestore, projectId: "graffiticode", auth });
  assert.equal(db.databaseId, "policy");
  // @google-cloud/firestore passes its settings to the GAPIC client, whose
  // google-gax GrpcClient takes `auth` as its GoogleAuth.
  const gapic = new FirestoreGapic({ ...db._settings, fallback: false });
  assert.ok(gapic.auth === auth, "the transport's auth is the verified client");
  assert.deepEqual([...AUTH_SCOPES].sort(), ["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/userinfo.email"]);
  return gapic.close();
});

test("refuses before any write when the client's token is no longer the verified identity", async () => {
  const other = "ya29.another-principal-token";
  const w = await world({ tokens: [TOKEN, other], infoFor: t => (t === TOKEN ? GOOD_INFO : { ...GOOD_INFO, email: "intruder@example.com" }) });
  await refused(runAct(parse(applyArgs(w.commandId)), w.deps), "identity-changed");
  assert.deepEqual(w.calls.acts, []);
  assert.deepEqual(await files(join(w.root, "docs")), []);
  assert.equal(w.commandStore.commands.get(w.commandId).hold, undefined);
  // The re-check is complete: a same-email token about to expire is refused too.
  const expiring = await world({ tokens: [TOKEN, other], infoFor: t => (t === TOKEN ? GOOD_INFO : { ...GOOD_INFO, expires_in: "30" }) });
  await refused(runAct(parse(applyArgs(expiring.commandId)), expiring.deps), "token-expiring");
  assert.deepEqual(expiring.calls.acts, []);
  // A refresh to a new token of the same principal is the same identity.
  const refreshed = await world({ tokens: [TOKEN, other] });
  assert.equal((await runAct(parse(applyArgs(refreshed.commandId)), refreshed.deps)).result.replayed, false);
});
