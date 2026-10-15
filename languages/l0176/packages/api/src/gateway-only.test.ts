// SPDX-License-Identifier: MIT
// Gateway-only system preview signing (plan system-preview-rate-limit), through
// the real server: a compile with no connection is signed on the system path
// only when its `X-Caller-Identity` verifies as the api's (the verifier
// /preflight uses, with local keys standing in for Google's), or the server
// runs with SYSTEM_PREVIEW_DIRECT=1. Policy and Broker are faked at the
// compiler's client boundary, as in the core's brokered.test.ts.
import { describe, test, expect, beforeAll, beforeEach } from "vitest";
import { generateKeyPairSync, createSign } from "crypto";
import type { KeyObject } from "crypto";
import request from "supertest";
import { parser } from "@graffiticode/parser";
import { createGatewayVerifier } from "@graffiticode/l0000";
import { compiler, lexicon } from "@graffiticode/l0176";
import { createApp, systemPreviewDirect } from "./app.js";

const API = "api-run@graffiticode.iam.gserviceaccount.com";
const AUDIENCE = "urn:graffiticode:0176";
const google = generateKeyPairSync("rsa", { modulusLength: 2048 });
const stranger = generateKeyPairSync("rsa", { modulusLength: 2048 });

// A Google-shaped ID token (RS256), signed with `key`.
function idToken(claims: Record<string, unknown> = {}, key: KeyObject = google.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${enc({ alg: "RS256", typ: "JWT", kid: "k1" })}.${enc({
    iss: "https://accounts.google.com",
    aud: AUDIENCE,
    email: API,
    email_verified: true,
    iat: now - 10,
    exp: now + 600,
    ...claims,
  })}`;
  const sig = createSign("RSA-SHA256").update(body).sign(key).toString("base64url");
  return `${body}.${sig}`;
}

let previewSessions: number;
let invocations: any[];
let sessionsUsed: (string | null)[];

const fakeClient = {
  async getSnapshot(args: any) {
    args.exec.setSessionToken("connection-session");
    return { allowed: args.fns };
  },
  async invoke(exec: any, call: any) {
    invocations.push(call);
    sessionsUsed.push(exec.sessionToken);
    return { status: "succeeded", result: { request: { signature: "$02$signed", op: call.op } } };
  },
  async getPreviewSession() {
    previewSessions += 1;
    return { allowed: ["init"], sessionToken: "system-session" };
  },
};

// `init data {}..` with the activity inline: what the api's /preview/sign sends.
const INIT_DATA_CODE = {
  3: { tag: "RECORD", elts: [] },
  6: { tag: "DATA", elts: [3] },
  8: { tag: "INIT", elts: [6] },
  10: { tag: "EXPRS", elts: [8] },
  11: { tag: "PROG", elts: [10] },
  root: 11,
};
const ACTIVITY = { type: "questions", data: { id: "a", name: "n", session_id: "s", questions: [{ response_id: "r-0", type: "mcq" }] } };
let ITEM_CODE: any;

const verifyCaller = createGatewayVerifier({ lang: "0176", gateways: [API], getKey: google.publicKey as any });
const gated = createApp({ verifyCaller });
const direct = createApp({ verifyCaller, systemPreviewDirect: true });

const post = (app: any, body: any, token?: string) => {
  const req = request(app).post("/compile").set("Content-Type", "application/json");
  if (token !== undefined) req.set("X-Caller-Identity", token);
  return req.send(body);
};

beforeAll(async () => {
  (compiler as any).setPolicyClient(fakeClient);
  ITEM_CODE = await parser.parse(176, 'set-var "lrn-id" "t" items [item [questions [mcq []] {}]] {}..', lexicon);
});

beforeEach(() => {
  previewSessions = 0;
  invocations = [];
  sessionsUsed = [];
});

describe("gateway-only, on by default", () => {
  test("a verified api identity signs `init data {}`", async () => {
    const res = await post(gated, { code: INIT_DATA_CODE, data: ACTIVITY }, idToken());
    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
    expect(res.body.data).toEqual({ signature: "$02$signed", op: "learnosity.sign-questions-preview" });
    expect(previewSessions).toBe(1);
    expect(sessionsUsed).toEqual(["system-session"]);
  });

  test("a verified api identity signs a program's render too", async () => {
    const res = await post(gated, { code: ITEM_CODE, data: {} }, `Bearer ${idToken()}`);
    expect(res.body.data.request).toEqual({ signature: "$02$signed", op: "learnosity.sign-questions-preview" });
    expect(res.body.data.signing).toBeUndefined();
  });

  const now = Math.floor(Date.now() / 1000);
  test.each([
    ["missing", undefined],
    ["empty", ""],
    ["not a token", "not-a-jwt"],
    ["forged (another key)", idToken({}, stranger.privateKey)],
    ["expired", idToken({ iat: now - 7200, exp: now - 3600 })],
    ["for another audience", idToken({ aud: "urn:graffiticode:0158" })],
    ["for the policy audience", idToken({ aud: "urn:graffiticode:policy" })],
    ["from another account", idToken({ email: "l0176-run@graffiticode.iam.gserviceaccount.com" })],
    ["with an unverified email", idToken({ email_verified: false })],
    ["from another issuer", idToken({ iss: "https://evil.example" })],
  ])("a %s identity gets the activity back unsigned, `gateway-only`", async (_, token) => {
    for (const [code, data] of [[INIT_DATA_CODE, ACTIVITY], [ITEM_CODE, {}]]) {
      const res = await post(gated, { code, data }, token);
      expect(res.status).toBe(200);
      expect(res.body.errors).toEqual([]);
      expect(res.body.data.request).toBeUndefined();
      expect(res.body.data.type).toBe("questions");
      expect(res.body.data.signing).toEqual({ unsigned: "gateway-only", message: expect.stringMatching(/only through the Graffiticode api/) });
    }
    if (token === undefined) {
      const res = await post(gated, { code: INIT_DATA_CODE, data: ACTIVITY });
      expect(res.body.data).toEqual({ ...ACTIVITY, signing: expect.objectContaining({ unsigned: "gateway-only" }) });
    }
    expect(previewSessions).toBe(0);
    expect(invocations).toEqual([]);
  });

  test("no body field grants it", async () => {
    const res = await post(gated, {
      code: INIT_DATA_CODE,
      data: ACTIVITY,
      systemPreview: true,
      identity: { systemPreview: true },
      "X-Caller-Identity": idToken(),
      callerIdentity: idToken(),
    });
    expect(res.body.data.signing).toMatchObject({ unsigned: "gateway-only" });
    expect(previewSessions).toBe(0);
  });

  test("a connection compile is unaffected, with or without the identity", async () => {
    for (const token of [undefined, idToken(), "forged"]) {
      sessionsUsed = [];
      const res = await post(gated, { code: ITEM_CODE, data: {}, connectionId: "conn-1", invocationToken: "inv", stage: "s0" }, token);
      expect(res.status).toBe(200);
      expect(res.body.errors).toEqual([]);
      expect(res.body.data.request).toEqual({ signature: "$02$signed", op: "learnosity.sign-questions-preview" });
      expect(sessionsUsed).toEqual(["connection-session"]);
    }
    expect(previewSessions).toBe(0);
  });

  test("a server with no gateways configured signs no direct preview", async () => {
    const none = createGatewayVerifier({ lang: "0176", gateways: [], getKey: google.publicKey as any });
    const res = await post(createApp({ verifyCaller: none }), { code: INIT_DATA_CODE, data: ACTIVITY }, idToken());
    expect(res.body.data.signing).toMatchObject({ unsigned: "gateway-only" });
  });
});

describe("SYSTEM_PREVIEW_DIRECT=1", () => {
  test.each([
    ["missing", undefined],
    ["forged", idToken({}, stranger.privateKey)],
    ["verified", idToken()],
  ])("signs as before gateway-only, with a %s identity", async (_, token) => {
    const res = await post(direct, { code: INIT_DATA_CODE, data: ACTIVITY }, token);
    expect(res.body.errors).toEqual([]);
    expect(res.body.data).toEqual({ signature: "$02$signed", op: "learnosity.sign-questions-preview" });
    expect(previewSessions).toBe(1);
  });

  test.each([
    ["1", true],
    [undefined, false],
    ["", false],
    ["0", false],
    ["true", false],
    ["yes", false],
    [" 1", false],
    ["1 ", false],
  ])("is on for exactly \"1\" (%s)", (value, on) => {
    expect(systemPreviewDirect(value === undefined ? {} : { SYSTEM_PREVIEW_DIRECT: value })).toBe(on);
  });
});
