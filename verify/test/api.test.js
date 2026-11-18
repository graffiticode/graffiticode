// The api verifier's credentials (the owner's review of #416): a private
// candidate (api-c5a-gate) is reached only with the CLI's invocation header,
// which goes on every candidate request, the application-anonymous probe
// included, and never to AUTH_URL; the user's own token stays in
// Authorization. A public candidate gets no invocation header at all.
import test from "node:test";
import assert from "node:assert/strict";
import verify from "../api.js";

const base = new URL("https://candidate---api-c5a-gate.example.run.app");
const AUTH = "https://auth.example.run.app";
const INVOCATION = "Bearer fake-google-id-token";

// A candidate that answers only with the invocation header when it is
// private, and an auth service that must never see it.
const service = ({ private: isPrivate }) => {
  const calls = [];
  let value;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetch = async (url, init) => {
    const u = new URL(url);
    const headers = new Headers(init.headers);
    const user = headers.get("authorization");
    calls.push({ origin: u.origin, path: u.pathname, invocation: headers.get("x-serverless-authorization"), user });
    if (u.origin === AUTH) {
      if (u.pathname === "/authenticate/api-key") return json(200, { status: "success", data: { accessToken: "fake.user.jwt", firebaseCustomToken: "fake-custom-token" } });
      throw new Error(`unexpected auth path ${u.pathname}`);
    }
    assert.equal(u.origin, base.origin);
    if (isPrivate && headers.get("x-serverless-authorization") !== INVOCATION) return new Response("Cloud Run: Forbidden", { status: 403 });
    if (u.pathname === "/task") {
      const body = JSON.parse(init.body);
      if (typeof body.task.code === "string") return json(400, { status: "error", error: { message: "task.code must be a pre-parsed object, not a source string" } });
      value = JSON.parse(body.task.code[1].elts[0]);
      return json(200, { data: { id: "task-1" } });
    }
    if (u.pathname === "/data") {
      if (u.searchParams.get("id") === "not-an-id") return json(400, { error: { code: 4001, message: "failed to decode firestore id not-an-id: x" } });
      if (!user) return json(404, { status: "error", error: { code: 404, message: "", category: "malformed" } });
      return json(200, { status: "success", data: { data: value, errors: [] } });
    }
    if (u.pathname === "/compile") return json(200, { status: "success", id: "task-1+input", data: { data: value, errors: [] } });
    throw new Error(`unexpected path ${u.pathname}`);
  };
  return { fetch, calls };
};
const run = async ({ isPrivate }) => {
  const { fetch, calls } = service({ private: isPrivate });
  await verify({
    candidateUrl: base,
    headers: isPrivate ? { "X-Serverless-Authorization": INVOCATION } : {},
    config: { env: { AUTH_URL: AUTH } },
    cloud: async () => "fake-verify-api-key",
    fetch,
    log: () => {},
  });
  return calls;
};

test("a private candidate gets the invocation header on every request, and auth never does", async () => {
  const calls = await run({ isPrivate: true });
  const candidate = calls.filter(c => c.origin === base.origin);
  assert.ok(candidate.length >= 5);
  assert.ok(candidate.every(c => c.invocation === INVOCATION), JSON.stringify(candidate));
  assert.ok(calls.filter(c => c.origin === AUTH).every(c => c.invocation === null));
  // The user's token stays separate: on the signed-in requests, never on the
  // application-anonymous probe.
  const anonymous = candidate.filter(c => c.path === "/data" && c.user === null);
  assert.equal(anonymous.length, 1);
  assert.ok(candidate.filter(c => c.user !== null).every(c => c.user === "fake.user.jwt"));
});

test("a public candidate gets no invocation header", async () => {
  const calls = await run({ isPrivate: false });
  assert.ok(calls.every(c => c.invocation === null));
});

test("an Authorization in the CLI's headers never becomes the anonymous probe's credential", async () => {
  const { fetch, calls } = service({ private: true });
  await verify({ candidateUrl: base, headers: { "X-Serverless-Authorization": INVOCATION, Authorization: "Bearer not-a-user" }, config: { env: { AUTH_URL: AUTH } }, cloud: async () => "k", fetch, log: () => {} });
  const candidate = calls.filter(c => c.origin === base.origin);
  assert.ok(candidate.every(c => c.user === null || c.user === "fake.user.jwt"));
});
