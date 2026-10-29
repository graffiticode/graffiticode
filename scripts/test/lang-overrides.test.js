import test from "node:test";
import assert from "node:assert/strict";
import { bindingKey, parse, readBindings, uidProblem, urlProblem, withBinding, withoutBinding, writeBindings } from "../lib/lang-overrides.js";

const UID = "24493e1c7a7f1ad57e3c478087c74c2dacb0cba1";
const VERIFY = "a35c2c8948de39fd03bb60d9d44259612dc56470";
const refused = { [VERIFY]: "deploy-check account" };
const RUST = "https://l0184r-abc123-uc.a.run.app";

// Just enough Firestore: documents with set() and delete().
const fakeDb = () => {
  const docs = new Map();
  return {
    docs,
    doc: path => ({
      get: async () => ({ exists: docs.has(path), data: () => structuredClone(docs.get(path)) }),
      set: async data => { docs.set(path, structuredClone(data)); },
      delete: async () => { docs.delete(path); },
    }),
  };
};

test("a language key is the API's: L and four digits", () => {
  assert.equal(bindingKey("0184"), "L0184");
  assert.equal(bindingKey("L184"), "L0184");
  assert.equal(bindingKey("l0184"), "L0184");
  assert.throws(() => bindingKey("abc"), /not a language id/);
  assert.throws(() => bindingKey("12345"), /not a language id/);
});

test("a binding is the language's own Rust service, or a tag on it, over https", () => {
  assert.equal(urlProblem("0184", RUST), null);
  assert.equal(urlProblem("0184", "https://cand-1---l0184r-abc123-uc.a.run.app"), null);
  assert.match(urlProblem("0184", "https://l0184-abc123-uc.a.run.app"), /isn't l0184r's Cloud Run URL/);
  assert.match(urlProblem("0184", "https://l0185r-abc123-uc.a.run.app"), /isn't l0184r's/);
  assert.match(urlProblem("0184", "https://l0184r-abc.example.com"), /isn't l0184r's/);
  assert.match(urlProblem("0184", "http://l0184r-abc123-uc.a.run.app"), /not https/);
  assert.match(urlProblem("0184", `${RUST}/compile`), /no path/);
  assert.match(urlProblem("0184", "not a url"), /not a URL/);
  assert.equal(urlProblem("0184", "https://elsewhere.example.com", { anyUrl: true }), null);
  assert.match(urlProblem("0184", "http://elsewhere.example.com", { anyUrl: true }), /not https/);
});

test("the deploy-check account is never overridden, and a uid must look like one", () => {
  assert.equal(uidProblem(UID, { refused }), null);
  assert.match(uidProblem(VERIFY, { refused }), /deploy-check account/);
  assert.match(uidProblem("a/b", { refused }), /not a uid/);
  assert.match(uidProblem(undefined, { refused }), /not a uid/);
});

test("parse checks the command, the uid and the language", () => {
  assert.deepEqual(parse(["set", "--uid", UID, "--lang", "184", "--plan"], { refused }), {
    command: "set", project: "graffiticode", plan: true, anyUrl: false, uid: UID, lang: "L0184", url: null,
  });
  assert.equal(parse(["status"], { refused }).uid, null);
  assert.throws(() => parse(["set", "--uid", UID], { refused }), /set needs --lang/);
  assert.throws(() => parse(["clear", "--uid", VERIFY], { refused }), /deploy-check account/);
  assert.throws(() => parse(["grant", "--uid", UID], { refused }), /usage/);
  assert.throws(() => parse(["set", "--uid", UID, "--lang"], { refused }), /--lang needs a value/);
  assert.throws(() => parse(["set", "--uid", UID, "--lang", "0184", "--force"], { refused }), /unknown option --force/);
});

test("set adds or replaces one binding and keeps the others; clear removes one, or all", () => {
  const before = { L0176: "https://l0176r-x-uc.a.run.app" };
  assert.deepEqual(withBinding(before, "L0184", RUST), { L0176: before.L0176, L0184: RUST });
  assert.deepEqual(withBinding({ L0184: "https://old" }, "L0184", RUST), { L0184: RUST });
  assert.deepEqual(withoutBinding({ ...before, L0184: RUST }, "L0184"), before);
  assert.deepEqual(withoutBinding({ ...before, L0184: RUST }, null), {});
  assert.deepEqual(withoutBinding(undefined, "L0184"), {});
});

test("writing no bindings deletes the document, and --plan writes nothing", async () => {
  const db = fakeDb();
  assert.deepEqual(await writeBindings(db, UID, { L0184: RUST }, { plan: true }), { uid: UID, bindings: { L0184: RUST } });
  assert.equal(db.docs.size, 0);
  await writeBindings(db, UID, { L0184: RUST });
  assert.deepEqual(await readBindings(db, UID), { L0184: RUST });
  assert.deepEqual(await writeBindings(db, UID, {}), { uid: UID, deleted: true });
  assert.equal(db.docs.size, 0);
  assert.deepEqual(await readBindings(db, UID), {});
});
