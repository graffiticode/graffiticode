// The verified caller context and respondent-authority client for C4 (respondent.js).

import { jest } from "@jest/globals";
import { buildCallerContext, buildRespondentAuthority, parseRespondentConfig } from "./respondent.js";
import { buildInterpreter } from "./comp.js";

const FRONTEND = "console@graffiticode.iam.gserviceaccount.com";
/** @param {Record<string, string>} [headers] */
const req = (headers = {}) => ({ get: name => headers[name] });
// Google's claim names, built without a non-camel-case identifier.
const claimsOf = (email, verified) => Object.fromEntries([["email", email], ["email_verified", verified]]);
const verifier = (claims = claimsOf(FRONTEND, true)) => jest.fn(async () => claims);

describe("buildCallerContext", () => {
  const build = (/** @type {any} */ over = {}) =>
    buildCallerContext({ verifyIdToken: verifier(), frontends: [FRONTEND], freePlanUid: "trial", log: () => {}, ...over });

  it("an anonymous caller has no principal; a signed-in one is a user principal", async () => {
    expect(await build()(req(), null)).toEqual({ principal: null, frontend: null });
    expect((await build()(req(), { uid: "u1" })).principal).toEqual({ kind: "user", uid: "u1", installation: "graffiticode" });
  });

  it("the shared trial uid is a free-plan principal, with a workspace only from a verified frontend", async () => {
    const attested = await build()(req({ "X-Caller-Identity": "tok", "X-Attested-Workspace": "ws-a" }), { uid: "trial" });
    expect(attested.principal).toEqual({ kind: "freePlan", uid: "trial", workspace: "ws-a", installation: "graffiticode" });
    // A workspace header with no frontend identity is ignored: unattested, never a user.
    const bare = await build()(req({ "X-Attested-Workspace": "ws-a" }), { uid: "trial" });
    expect(bare.principal).toEqual({ kind: "freePlan", uid: "trial", installation: "graffiticode" });
  });

  it("a supplied identity that doesn't verify is refused, not treated as absent", async () => {
    const bad = build({ verifyIdToken: jest.fn(async () => { throw new Error("Wrong recipient"); }) });
    await expect(bad(req({ "X-Caller-Identity": "tok" }), { uid: "u1" })).rejects.toMatchObject({ statusCode: 401, reason: "frontend-identity-invalid" });
    const unverified = build({ verifyIdToken: verifier(claimsOf(FRONTEND, false)) });
    await expect(unverified(req({ "X-Caller-Identity": "tok" }), { uid: "u1" })).rejects.toMatchObject({ reason: "frontend-identity-invalid" });
    const none = build({ verifyIdToken: null });
    await expect(none(req({ "X-Caller-Identity": "tok" }), { uid: "u1" })).rejects.toMatchObject({ reason: "frontend-identity-invalid" });
  });

  it("an unregistered frontend is refused, and an unreachable verifier is temporary", async () => {
    const stranger = build({ verifyIdToken: verifier(claimsOf("other@x.iam.gserviceaccount.com", true)) });
    await expect(stranger(req({ "X-Caller-Identity": "tok" }), { uid: "u1" })).rejects.toMatchObject({ statusCode: 403, reason: "frontend-not-registered" });
    const offline = build({ verifyIdToken: jest.fn(async () => { throw new Error("fetch failed"); }) });
    await expect(offline(req({ "X-Caller-Identity": "tok" }), { uid: "u1" })).rejects.toMatchObject({ statusCode: 503, reason: "frontend-identity-unavailable" });
  });

  it("the context is immutable", async () => {
    const context = await build()(req(), { uid: "u1" });
    expect(Object.isFrozen(context) && Object.isFrozen(context.principal)).toBe(true);
  });
});

describe("buildRespondentAuthority", () => {
  const ok = body => ({ ok: true, json: async () => body });

  it("answers nothing when unconfigured, so the store fails closed", async () => {
    expect(Object.keys(await buildRespondentAuthority()(["s"]))).toEqual([]);
  });

  it("maps each session's answer, and leaves out a failed or malformed one", async () => {
    const fetch = /** @type {any} */ (jest.fn(async (/** @type {any} */ _url, /** @type {any} */ { body }) => {
      const { session } = JSON.parse(body);
      if (session === "a") return ok({ bound: false, principal: { kind: "user", uid: "p", installation: "graffiticode" } });
      if (session === "b") return ok({ unknown: true });
      if (session === "c") return ok({ ambiguous: true });
      if (session === "d") return { ok: false, status: 503, json: async () => ({}) };
      return ok({ nonsense: 1 });
    }));
    const authority = buildRespondentAuthority({ url: "https://console/x", audience: "aud", idToken: async () => "tok", fetch, log: () => {} });
    const answers = await authority(["a", "b", "c", "d", "e", "__proto__"]);
    expect(answers.a).toEqual({ principal: { kind: "user", uid: "p", installation: "graffiticode" } });
    expect(answers.b).toEqual({ unknown: true });
    expect(answers.c).toEqual({ ambiguous: true });
    expect(Object.hasOwn(answers, "d")).toBe(false);
    expect(Object.hasOwn(answers, "e")).toBe(false);
    expect(Object.hasOwn(answers, "__proto__")).toBe(false);
    expect(fetch.mock.calls[0][1].headers["X-Caller-Identity"]).toBe("tok");
  });
});

describe("parseRespondentConfig", () => {
  it("reads lists and defaults", () => {
    expect(parseRespondentConfig({ L0182_ATTESTING_FRONTENDS: "a@x, b@x", L0182_CANARY_SESSIONS: "c1" })).toMatchObject({
      frontends: ["a@x", "b@x"], audience: "urn:graffiticode:api", freePlanUid: null, canarySessions: ["c1"],
    });
  });
});

describe("the interpreter client sends a table only when given one", () => {
  it("adds `assignments` to /interpret only for an exchange", async () => {
    const langCompile = /** @type {any} */ (jest.fn(async () => ({})));
    const interpreter = buildInterpreter({ langCompile });
    await interpreter.interpret({ lang: "0182", model: {}, input: {}, mode: "present" });
    await interpreter.interpret({ lang: "0182", model: {}, input: {}, mode: "present", assignments: { k: { absent: true } } });
    expect(langCompile.mock.calls[0][1]).not.toHaveProperty("assignments");
    expect(langCompile.mock.calls[1][1]).toMatchObject({ assignments: { k: { absent: true } } });
  });
});
