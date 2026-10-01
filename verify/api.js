// Candidate checks for the api service (deploy.json services.api.verify).
//
// Runs as the dedicated verification account (see verify/auth.js), whose
// access token comes from production auth (config.env.AUTH_URL), as real
// callers' do. Tasks use L0000's JSON literal, the same shape POST /compile
// builds for data, so the expected output does not depend on compiler
// releases. Each run posts one fresh task with a unique literal, so the
// compile is uncached; tasks are content-addressed, and posting is always
// authenticated so the task stays private to the verification account.
//
// Not covered here: compiles through a connection or a publication (the
// verification account holds none), and policy/broker allowed paths.

import { randomBytes } from "node:crypto";
import { accessTokenFor, VERIFY_UID } from "./auth.js";
import { check, expectError, request } from "./lib.js";

const literal = value => ({ 1: { elts: [JSON.stringify(value)], tag: "STR" }, 2: { elts: [1], tag: "JSON" }, root: 2 });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export default async ctx => {
  const { fetch, candidateUrl: base, config, cloud, log } = ctx;
  const token = await accessTokenFor({ fetch, cloud, base: new URL(config.env.AUTH_URL) });
  const auth = { Authorization: token };
  const value = { verify: `run-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`, uid: VERIFY_UID };

  // A fresh private task compiles, uncached.
  const posted = await request({ fetch, base, path: "/task", method: "POST", headers: auth, body: { task: { lang: "0000", code: literal(value) } } });
  const id = posted.json?.data?.id;
  check(posted.status === 200 && typeof id === "string" && id.length > 0, `POST /task: expected 200 with an id, got ${posted.status} ${posted.text.slice(0, 200)}`);
  const data = await request({ fetch, base, path: `/data?id=${encodeURIComponent(id)}`, headers: auth });
  check(data.status === 200 && same(data.json, { status: "success", data: { data: value, errors: [] } }),
    `GET /data (owner): expected the posted literal, got ${data.status} ${data.text.slice(0, 200)}`);
  log("  POST /task + GET /data: a fresh private task compiles for its owner");

  // Access control: the same private task is invisible to anonymous callers,
  // and the 404 is never cacheable (see setNoStoreCacheHeaders).
  const anonymous = await request({ fetch, base, path: `/data?id=${encodeURIComponent(id)}` });
  check(anonymous.status === 404 && same(anonymous.json, { status: "error", error: { code: 404, message: "" } }),
    `GET /data (anonymous, private task): expected 404 {code:404,message:""}, got ${anonymous.status} ${anonymous.text.slice(0, 200)}`);
  log("  GET /data: 404 for an anonymous caller on a private task");

  // POST /compile builds a pipeline (task + data task) and compiles it.
  const compiled = await request({ fetch, base, path: "/compile", method: "POST", headers: auth, body: { item: { id, data: { verifyInput: value.verify } } } });
  check(compiled.status === 200 && compiled.json?.status === "success" && compiled.json.id?.startsWith(`${id}+`) && same(compiled.json.data, { data: value, errors: [] }),
    `POST /compile: expected a ${id}+<data> pipeline compiling to the literal, got ${compiled.status} ${compiled.text.slice(0, 200)}`);
  log("  POST /compile: pipeline id built and compiled");

  // Input errors keep their contract.
  expectError("POST /task with source-string code",
    await request({ fetch, base, path: "/task", method: "POST", headers: auth, body: { task: { lang: "0000", code: "x" } } }),
    400, "task.code must be a pre-parsed object, not a source string");
  const malformed = await request({ fetch, base, path: "/data?id=not-an-id", headers: auth });
  check(malformed.status === 400 && malformed.json?.error?.code === 4001 && malformed.json.error.message?.startsWith("failed to decode firestore id not-an-id:"),
    `GET /data with a malformed id: expected 400 code 4001, got ${malformed.status} ${malformed.text.slice(0, 200)}`);
  log("  input errors: 400 for source-string code, 400/4001 for a malformed id");
};
