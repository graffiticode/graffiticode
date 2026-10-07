// Chain admission in the compiler (capability plan W4, PR 4; spec ADMIT-01,
// ADMIT-03, API-01): the preflight scan and manifest, side-effect free; the
// execution binding check for every planned stage, functions or not; the
// session verified as policy's; and /preflight for the gateway only.
import { describe, test, expect, beforeEach } from "vitest";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { parser } from "@graffiticode/parser";
import {
  Compiler,
  Checker,
  Transformer,
  Renderer,
  lexicon,
  requiredProtectedFunctions,
  digestOf,
  bindingProblems,
  createProtectionClient,
  createGatewayVerifier,
  createPreflightHandler,
  ExecContext,
} from "@graffiticode/l0000";

const REVISION = { revision: "l9999-r1", imageDigest: `sha256:${"1".repeat(64)}` };
const lex = {
  ...lexicon,
  "save-it": { tk: 1, name: "SAVE_IT", cls: "function", length: 1, arity: 1 },
  "sign-it": { tk: 1, name: "SIGN_IT", cls: "function", length: 1, arity: 1 },
};
const PROTECTED = { SAVE_IT: { fn: "save-it", kind: "write" }, SIGN_IT: { fn: "sign-it", kind: "sign" } };
const parse = (src: string) => parser.parse(0, src, lex);

let transformed: string[];
class ToyTransformer extends Transformer {
  SAVE_IT(node, options, resume) {
    transformed.push("SAVE_IT");
    resume([], { saved: true });
  }
  SIGN_IT(node, options, resume) {
    transformed.push("SIGN_IT");
    resume([], { signed: true });
  }
}
beforeEach(() => { transformed = []; });

const compiler = (over: Record<string, any> = {}) => new Compiler({
  langID: "9999", Checker, Transformer: ToyTransformer, Renderer,
  protectedFunctions: PROTECTED, registryVersion: 6, revisionIdentity: () => REVISION, ...over,
});

describe("the preflight scan (ADMIT-01)", () => {
  test("names every explicit protected node, dead code included, and the implicit ones, once each", async () => {
    // A lambda that is never applied: its save is dead code, and still counts.
    const code = await parse("[sign-it 1 <x: save-it x>]..");
    expect(requiredProtectedFunctions(code, PROTECTED)).toEqual(["save-it", "sign-it"]);
    expect(requiredProtectedFunctions(await parse("1..").then(c => c), PROTECTED, [{ fn: "init", kind: "sign" }])).toEqual(["init"]);
    expect(requiredProtectedFunctions(await parse("[sign-it 1 sign-it 2]..").then(c => c), PROTECTED)).toEqual(["sign-it"]);
  });
});

describe("Compiler.preflight (API-01)", () => {
  test("reports the stage manifest: digests of the stored and normalized program and the options, and its revision", async () => {
    const code = await parse("save-it 1..");
    const normalized = { ...code, marker: "lowered" };
    const out: any = await compiler({ normalize: () => normalized }).preflight(code, { stage: "s1", options: { a: 1 } });
    expect(out.manifest).toEqual({
      stage: "s1", lang: "9999",
      sourceDigest: digestOf(code), programDigest: digestOf(normalized), optionsDigest: digestOf({ a: 1 }),
      revision: REVISION.revision, imageDigest: REVISION.imageDigest, registryVersion: 6, requiredFunctions: ["save-it"],
    });
  });

  test("is side-effect free: it never asks policy, mints, signs or transforms", async () => {
    const calls: string[] = [];
    const policy = { getSnapshot: async () => { calls.push("snapshot"); return { allowed: [] }; }, invoke: async () => { calls.push("invoke"); } };
    const out: any = await compiler({ policy }).preflight(await parse("save-it 1.. "), { stage: "s0" });
    expect(out.manifest.requiredFunctions).toEqual(["save-it"]);
    expect(calls).toEqual([]);
    expect(transformed).toEqual([]);
  });

  test("a language with no protected functions reports registry version 0 and needs none", async () => {
    const out: any = await new Compiler({ langID: "0000", Checker, Transformer, Renderer, revisionIdentity: () => REVISION }).preflight(await parse("1.."), { stage: "s0" });
    expect(out.manifest).toMatchObject({ lang: "0000", registryVersion: 0, requiredFunctions: [] });
  });

  test.each([
    ["undeclarable protected behaviour", { undeclarableProtected: true }, "undeclarable-protected"],
    ["no deployed identity", { revisionIdentity: () => ({ revision: null, imageDigest: null }) }, "preflight-unavailable"],
    ["protected functions without a registry version", { registryVersion: undefined }, "preflight-unavailable"],
  ])("refuses %s", async (_label, over, code) => {
    const out: any = await compiler(over).preflight(await parse("save-it 1.."), { stage: "s0" });
    expect(out.errors[0]).toMatchObject({ code });
    expect(out.manifest).toBeUndefined();
  });

  test("returns the checker's errors instead of a manifest", async () => {
    const out: any = await compiler({ normalize: () => { throw new Error("cannot lower"); } }).preflight(await parse("1.."), { stage: "s0" });
    expect(out.errors[0].message).toMatch(/cannot lower/);
  });
});

// A planned compile: the policy client returns the binding it got from
// policy; the compiler compares it with its own manifest before anything runs.
describe("the execution binding check (ADMIT-03)", () => {
  const planned = (stage = "s1") => ({ uid: "u1", connectionId: "conn-1", userToken: "t", invocationToken: "inv", stage, admissionToken: "adm" });
  const run = (c: any, code: any, identity: any) =>
    new Promise<{ err: any[]; val: any }>(resolve => c.compile(code, {}, { a: 1 }, (err, val) => resolve({ err: err ?? [], val }), identity));
  const bindingFor = async (c: any, code: any, stage = "s1") => {
    const { manifest } = c.stageManifest(code, c.normalize(code), { stage, options: { a: 1 } });
    const { stage: _s, registryVersion: _r, ...bind } = manifest;
    return { manifest, bind: { ...bind, requiredFunctions: [...bind.requiredFunctions].sort() } };
  };

  test("runs only after policy's binding matches what the compiler is about to execute", async () => {
    const code = await parse("sign-it 1..");
    const asked: any[] = [];
    const c = compiler();
    const { bind } = await bindingFor(c, code);
    c.setPolicy({ getSnapshot: async args => { asked.push(args); return { allowed: ["sign-it"], bind }; }, invoke: async () => ({ status: "succeeded", result: {} }) });
    const { err } = await run(c, code, planned());
    expect(err).toEqual([]);
    expect(transformed).toEqual(["SIGN_IT"]);
    expect(asked[0].fns).toEqual(["sign-it"]);
    expect(asked[0].manifest).toMatchObject({ stage: "s1", programDigest: bind.programDigest });
  });

  test.each([
    ["another program", { programDigest: "f".repeat(64) }],
    ["other options", { optionsDigest: "f".repeat(64) }],
    ["another revision", { revision: "l9999-r2" }],
    ["another image", { imageDigest: `sha256:${"2".repeat(64)}` }],
    ["other functions", { requiredFunctions: ["save-it", "sign-it"] }],
  ])("refuses before the transformer when the binding names %s", async (_label, over) => {
    const code = await parse("sign-it 1..");
    const c = compiler();
    const { bind } = await bindingFor(c, code);
    c.setPolicy({ getSnapshot: async () => ({ allowed: ["sign-it"], bind: { ...bind, ...over } }) });
    const { err } = await run(c, code, planned());
    expect(err[0].message).toMatch(/not the one the admitted plan pins/);
    expect(transformed).toEqual([]);
  });

  test("binds a stage whose language has no protected functions too", async () => {
    const asked: any[] = [];
    const c = new Compiler({ langID: "0000", Checker, Transformer, Renderer, revisionIdentity: () => REVISION });
    const code = await parse("1..");
    const { bind } = await bindingFor(c, code, "s0");
    c.setPolicy({ getSnapshot: async args => { asked.push(args); return { allowed: [], bind }; } });
    const ok = await run(c, code, planned("s0"));
    expect(ok.err).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ fns: [], manifest: { lang: "0000", requiredFunctions: [] } });
    c.setPolicy({ getSnapshot: async () => ({ allowed: [], bind: { ...bind, revision: "l0000-other" } }) });
    expect((await run(c, code, planned("s0"))).err[0].message).toMatch(/not the one the admitted plan pins/);
  });

  test("fails closed without a policy client, when policy is unavailable, and without deployed identity", async () => {
    const code = await parse("sign-it 1..");
    expect((await run(compiler(), code, planned())).err[0].message).toMatch(/no permission service is configured/);
    const down = compiler();
    down.setPolicy({ getSnapshot: async () => { throw Object.assign(new Error("down"), { reason: "maintenance" }); } });
    expect((await run(down, code, planned())).err[0].message).toMatch(/unavailable.*maintenance/);
    const anonymous = compiler({ revisionIdentity: () => ({ revision: null, imageDigest: null }) });
    anonymous.setPolicy({ getSnapshot: async () => ({ allowed: [] }) });
    expect((await run(anonymous, code, planned())).err[0]).toMatchObject({ code: "preflight-unavailable" });
    expect(transformed).toEqual([]);
  });

  test("bindingProblems names each disagreeing field", () => {
    const manifest: any = { stage: "s1", lang: "9999", sourceDigest: "a", programDigest: "b", optionsDigest: "c", revision: "r", imageDigest: "i", registryVersion: 6, requiredFunctions: ["y", "x"] };
    expect(bindingProblems({ lang: "9999", sourceDigest: "a", programDigest: "b", optionsDigest: "c", revision: "r", imageDigest: "i", requiredFunctions: ["x", "y"] }, manifest)).toEqual([]);
    expect(bindingProblems({ lang: "9999", sourceDigest: "z", programDigest: "b", optionsDigest: "c", revision: "q", imageDigest: "i", requiredFunctions: ["x"] }, manifest)).toEqual(["sourceDigest", "revision", "requiredFunctions"]);
    expect(bindingProblems(undefined, manifest)).toEqual(["binding"]);
  });
});

// The client: the admission and manifest go to policy with the snapshot, and
// the binding is believed only from a session policy signed.
describe("the protection client under a plan", () => {
  const POLICY = "https://policy.example";
  let keys: { privateKey: any; jwk: any }[];
  let jwksServed: any[];
  let sessionReply: () => Promise<string>;
  const sent: any[] = [];
  const signSession = async (key, claims, header: Record<string, unknown> = {}) =>
    new SignJWT({ fns: ["sign-it"], bind: { revision: "r" }, ...claims })
      .setProtectedHeader({ alg: "ES256", typ: "gc-session+jwt", kid: key.jwk.kid, ...header })
      .setIssuer("urn:graffiticode:policy").setAudience("urn:graffiticode:policy").setIssuedAt().setExpirationTime("15m")
      .sign(key.privateKey);
  const newKey = async (kid: string) => {
    const pair = await generateKeyPair("ES256", { extractable: true });
    return { privateKey: pair.privateKey, jwk: { ...(await exportJWK(pair.publicKey)), kid, alg: "ES256", use: "sig" } };
  };
  const fakeFetch = async (url: string, init: any) => {
    if (url === `${POLICY}/v1/jwks`) {
      jwksServed.push(url);
      return new Response(JSON.stringify({ keys: keys.map(k => k.jwk) }), { status: 200 });
    }
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ status: "success", data: { allowed: ["sign-it"], sessionToken: await sessionReply() } }), { status: 200 });
  };
  const client = () => createProtectionClient({ policyUrl: POLICY, idToken: async a => `id-${a}`, fetch: fakeFetch as any });
  const exec = (over = {}) => new ExecContext({ uid: "u1", connectionId: "conn-1", userToken: "t", invocationToken: "inv", stage: "s1", admissionToken: "adm", ...over });

  beforeEach(async () => {
    keys = [await newKey("k1")];
    jwksServed = [];
    sent.length = 0;
    sessionReply = () => signSession(keys[0], {});
  });

  test("sends the admission token and manifest, and returns the binding of a verified session", async () => {
    const e = exec();
    const out = await client().getSnapshot({ exec: e, langID: "9999", fns: ["sign-it"], manifest: { stage: "s1" } as any });
    expect(sent[0].body).toMatchObject({ admissionToken: "adm", manifest: { stage: "s1" }, stage: "s1", invocationToken: "inv" });
    expect(out).toEqual({ allowed: ["sign-it"], bind: { revision: "r" } });
    expect(e.sessionToken).toBeTruthy();
  });

  test("refuses a session that doesn't verify as policy's, and loads a rotated key", async () => {
    const stranger = await newKey("k1");
    sessionReply = () => signSession(stranger, {});
    await expect(client().getSnapshot({ exec: exec(), langID: "9999", fns: [], manifest: {} as any })).rejects.toMatchObject({ reason: "bad-session" });
    sessionReply = () => signSession(keys[0], {}, { typ: "gc-exec+jwt" });
    await expect(client().getSnapshot({ exec: exec(), langID: "9999", fns: [], manifest: {} as any })).rejects.toMatchObject({ reason: "bad-session" });
    // A key policy rotated in after the client loaded its keys.
    sessionReply = () => signSession(keys[0], {});
    const c = client();
    await c.getSnapshot({ exec: exec(), langID: "9999", fns: [], manifest: {} as any });
    keys.push(await newKey("k2"));
    sessionReply = () => signSession(keys[1], {});
    await expect(c.getSnapshot({ exec: exec(), langID: "9999", fns: [], manifest: {} as any })).resolves.toMatchObject({ bind: { revision: "r" } });
    expect(jwksServed.length).toBeGreaterThanOrEqual(2);
  });

  test("an unplanned snapshot sends neither, and needs no keys", async () => {
    await client().getSnapshot({ exec: exec({ admissionToken: null }), langID: "9999", fns: [] });
    expect(sent[0].body.admissionToken).toBeUndefined();
    expect(sent[0].body.manifest).toBeUndefined();
    expect(jwksServed).toEqual([]);
  });
});

// /preflight: the gateway's Google ID token, for exactly this language.
describe("/preflight, for the gateway only (decision 1)", () => {
  const GATEWAY = "api-run@graffiticode.iam.gserviceaccount.com";
  let google: any;
  let getKey: any;
  const idToken = async ({ aud = "urn:graffiticode:9999", ...claims }: Record<string, unknown>, key = google.privateKey, kid = "g1") =>
    new SignJWT({ email: GATEWAY, email_verified: true, ...claims })
      .setProtectedHeader({ alg: "RS256", kid })
      .setIssuer("https://accounts.google.com").setAudience(aud as string).setIssuedAt().setExpirationTime("1h")
      .sign(key);
  beforeEach(async () => {
    google = await generateKeyPair("RS256", { extractable: true });
    getKey = createLocalJWKSet({ keys: [{ ...(await exportJWK(google.publicKey)), kid: "g1", alg: "RS256" }] });
  });
  const handler = () => createPreflightHandler({ compiler: compiler(), verifyCaller: createGatewayVerifier({ lang: "9999", gateways: [GATEWAY], getKey }) });
  const call = async (headers: Record<string, unknown>, body: any = { stage: "s1", lang: "9999", code: null }) => {
    body = body.code === null ? { ...body, code: await parse("save-it 1..") } : body;
    return handler()({ headers, body });
  };

  test("answers the gateway with the manifest", async () => {
    const out: any = await call({ "x-caller-identity": await idToken({}) });
    expect(out.status).toBe(200);
    expect(out.body.data.manifest).toMatchObject({ stage: "s1", lang: "9999", requiredFunctions: ["save-it"] });
  });

  test.each([
    ["an anonymous caller", async () => ({}), 401],
    ["another service account", async () => ({ "x-caller-identity": await idToken({ email: "l0176-run@graffiticode.iam.gserviceaccount.com" }) }), 403],
    ["an unverified email", async () => ({ "x-caller-identity": await idToken({ email_verified: false }) }), 403],
    ["another language's audience", async () => ({ "x-caller-identity": await idToken({ aud: "urn:graffiticode:0176" }) }), 401],
    ["a token signed by someone else", async () => ({ "x-caller-identity": await idToken({}, (await generateKeyPair("RS256")).privateKey) }), 401],
    ["an unsigned token", async () => ({ "x-caller-identity": `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify({ email: GATEWAY, email_verified: true, aud: "urn:graffiticode:9999", iss: "https://accounts.google.com" })).toString("base64url")}.` }), 401],
    ["a forged identity header carrying a different header's token", async () => ({ authorization: `Bearer ${await idToken({})}` }), 401],
  ])("refuses %s", async (_label, headers, status) => {
    const out: any = await call(await headers());
    expect(out.status).toBe(status);
    expect(out.body.data).toBeNull();
  });

  test("refuses a malformed request or another language's program", async () => {
    const h = { "x-caller-identity": await idToken({}) };
    expect((await call(h, { stage: "first", code: {} })).status).toBe(400);
    expect((await call(h, { stage: "s1", lang: "0176", code: null })).status).toBe(400);
  });
});
