// C5 render grants (render-grant.js): a Policy render grant reads exactly its
// pinned chain through GET /form and GET /data, under its subject's task ACLs,
// and nothing else. Against the emulator, like the other route specs.
import { generateKeyPair, exportJWK } from "jose";
import { startAuthApp } from "@graffiticode/auth/testing";
import { createLocalSigner, issueToken } from "@graffiticode/policy";
import request from "supertest";
import { createApp } from "./app.js";
import { clearFirestore } from "./testing/firestore.js";
import { TASK1, DATA1, TASK2, DATA2 } from "./testing/fixture.js";
import { startLangApp } from "./testing/lang.js";
import { buildPolicyJwks, buildRenderGrantVerifier, JWKS_REFETCH_MS, JWKS_TTL_MS, loggableHeaders, RENDER_GRANT_HEADER, requireReadOnlyChain } from "./render-grant.js";

const OWNER = "1";
const OTHER = "2";

describe("render grants", () => {
  let langApp;
  let authApp;
  let app;
  let signer;
  let otherSigner;
  let jwks;

  beforeEach(async () => {
    await clearFirestore();
    langApp = await startLangApp();
    langApp.setData(TASK1.code, DATA1);
    langApp.setData(TASK2.code, DATA2);
    authApp = await startAuthApp();
    const pair = await generateKeyPair("ES256", { extractable: true });
    signer = await createLocalSigner({ privateJwk: await exportJWK(pair.privateKey), kid: "k1" });
    jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
    const other = await generateKeyPair("ES256", { extractable: true });
    otherSigner = await createLocalSigner({ privateJwk: await exportJWK(other.privateKey), kid: "k1" });
    app = createApp({ authUrl: authApp.url, renderGrantVerifier: buildRenderGrantVerifier({ jwks }) });
    process.env.BASE_URL_L0000 = langApp.url;
  });

  afterEach(async () => {
    await authApp.cleanUp();
    await langApp.cleanUp();
  });

  // A private task, created by its owner: only the owner (and its acls) may
  // read it.
  /** @param {any} [task] @param {string} [uid] */
  const privateTask = async (task = TASK1, uid = OWNER) => {
    const { accessToken } = await authApp.authService.generateTokens({ uid });
    const res = await request(app).post("/task").set("Authorization", accessToken).set("x-graffiticode-storage-type", "persistent").send({ task }).expect(200);
    return res.body.data.id;
  };
  const grantFor = (tsk, over = {}, by = signer) => issueToken(by, "render", { sub: OWNER, itm: "item-1", tsk, cmd: "cmd-1", fg: 1, stg: "s0", occ: "n0.0", cseq: 1, ...over });
  const withGrant = (req, grant) => req.set(RENDER_GRANT_HEADER, grant);

  it("reads exactly the pinned chain's data under the subject's ACLs, never stored", async () => {
    const id = await privateTask();
    const res = await withGrant(request(app).get("/data").query({ id }), await grantFor(id)).expect(200);
    expect(res.body).toMatchObject({ status: "success", data: DATA1 });
    expect(res.headers["cache-control"]).toBe("no-store");
    // The View sends an empty Authorization when it has no token.
    await withGrant(request(app).get("/data").set("Authorization", "").query({ id }), await grantFor(id)).expect(200);
  });

  it("preserves the task's ACLs: a subject without access reads nothing", async () => {
    const id = await privateTask();
    await withGrant(request(app).get("/data").query({ id }), await grantFor(id, { sub: OTHER })).expect(404);
    await withGrant(request(app).get("/form").query({ id }), await grantFor(id, { sub: OTHER })).expect(404);
  });

  it("is no-store even for a public task", async () => {
    const res = await request(app).post("/task").set("x-graffiticode-storage-type", "persistent").send({ task: TASK2 }).expect(200);
    const id = res.body.data.id;
    const read = await withGrant(request(app).get("/data").query({ id }), await grantFor(id)).expect(200);
    expect(read.headers["cache-control"]).toBe("no-store");
  });

  it("refuses another chain, an altered one, and extra ids", async () => {
    const id = await privateTask();
    const other = await privateTask(TASK2);
    const grant = await grantFor(id);
    for (const query of [{ id: other }, { id: `${id},${other}` }, { id: `${id}+${other}` }, { id: `${other}+${id}` }]) {
      const res = await withGrant(request(app).get("/data").query(query), grant).expect(403);
      expect(res.body.error.message).toBe("grant-scope-mismatch");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    await withGrant(request(app).get("/data").query(`id=${id}&id=${other}`), grant).expect(400);
  });

  it("refuses connection, publication, refresh and any other parameter", async () => {
    const id = await privateTask();
    const grant = await grantFor(id);
    for (const extra of [{ connection: "conn-1" }, { publication: "pub-1" }, { refresh: "1" }, { origin: "https://x" }, { access_token: "t" }]) {
      await withGrant(request(app).get("/data").query({ id, ...extra }), grant).expect(400);
      await withGrant(request(app).get("/form").query({ id, ...extra }), grant).expect(400);
    }
  });

  it("never stands beside a user's credential", async () => {
    const id = await privateTask();
    const { accessToken } = await authApp.authService.generateTokens({ uid: OWNER });
    const res = await withGrant(request(app).get("/data").set("Authorization", accessToken).query({ id }), await grantFor(id)).expect(400);
    expect(res.body.error.message).toBe("mixed-credentials");
  });

  it("is refused on every other route, every write among them", async () => {
    const id = await privateTask();
    const grant = await grantFor(id);
    await withGrant(request(app).post("/compile").send({ id, data: {} }), grant).expect(403);
    await withGrant(request(app).post("/task").send({ task: TASK1 }), grant).expect(403);
    await withGrant(request(app).get("/task").query({ id }), grant).expect(403);
    await withGrant(request(app).get("/tasks").query({ id }), grant).expect(403);
    await withGrant(request(app).post("/data").query({ id }), grant).expect(403);
    await withGrant(request(app).post("/command").send({ id }), grant).expect(403);
    await withGrant(request(app).post("/preview/sign").send({}), grant).expect(403);
  });

  it("accepts only a valid render grant from Policy's keys", async () => {
    const id = await privateTask();
    const session = await issueToken(signer, "session", { sub: OWNER, lang: "0013", inv: "i", stg: "s0", rv: 1, fns: [], cv: 3, pld: "p" });
    for (const grant of [await grantFor(id, {}, otherSigner), session, "not-a-jwt"]) {
      const res = await withGrant(request(app).get("/data").query({ id }), grant).expect(401);
      expect(res.body.error.message).toBe("bad-render-grant");
    }
  });

  it("redirects /form to the view with no token anywhere, under the subject's ACLs, never stored", async () => {
    const id = await privateTask();
    const grant = await grantFor(id);
    const redirect = await withGrant(request(app).get("/form").query({ id, lang: "0000" }), grant).expect(302);
    expect(redirect.headers["cache-control"]).toBe("no-store");
    const location = new URL(redirect.headers.location);
    expect(location.searchParams.has("access_token")).toBe(false);
    expect(redirect.headers.location).not.toContain(grant);
    const data = new URL(location.searchParams.get("url"));
    expect(data.pathname).toBe("/data");
    expect([...data.searchParams.keys()].sort()).toEqual(["id"]);
  });

  it("is unavailable, not refused, without Policy's keys", async () => {
    const id = await privateTask();
    const unconfigured = createApp({ authUrl: authApp.url, renderGrantVerifier: buildRenderGrantVerifier({}) });
    await withGrant(request(unconfigured).get("/data").query({ id }), await grantFor(id)).expect(503);
  });

  // The owner's review of #408: a grant's read is read-only. A chain with a
  // stage that could act outside Policy (L0013's direct uploader) is refused
  // before anything compiles.
  it("refuses a chain with a stage that could upload, before anything compiles", async () => {
    const id = await privateTask({ lang: "0013", code: TASK1.code });
    const grant = await grantFor(id);
    const before = langApp.received().length;
    for (const path of ["/data", "/form"]) {
      const res = await withGrant(request(app).get(path).query({ id }), grant).expect(403);
      expect(res.body.error.message).toBe("render-not-read-only");
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    expect(langApp.received().length).toBe(before);
  });

  // Registry 9: the refusal follows the registry's `writesOutsideCommands`,
  // for every stage of the chain.
  it("checks every stage against the registry's writes outside command control", () => {
    for (const chain of [[[{ lang: "0013" }]], [[{ lang: "0000" }, { lang: "L0013" }]], [[{ lang: "0176" }], [{ lang: "13" }]]]) {
      expect(() => requireReadOnlyChain(chain)).toThrow("render-not-read-only");
    }
    for (const chain of [[[{ lang: "0176" }]], [[{ lang: "0000" }, { lang: "0176" }]], [[{ lang: "0185" }]], []]) {
      expect(() => requireReadOnlyChain(chain)).not.toThrow();
    }
  });

  it("still renders an L0176 preview under a grant, compiled with no user token", async () => {
    process.env.BASE_URL_L0176 = langApp.url;
    try {
      const task = { lang: "0176", code: TASK1.code };
      langApp.setData(task.code, DATA1);
      const id = await privateTask(task);
      const before = langApp.received().length;
      const res = await withGrant(request(app).get("/data").query({ id }), await grantFor(id)).expect(200);
      expect(res.body.data).toEqual(DATA1);
      expect(res.headers["cache-control"]).toBe("no-store");
      const sent = langApp.received().slice(before);
      expect(sent.length).toBeGreaterThan(0);
      for (const { headers, body } of sent) {
        expect(JSON.stringify({ headers, body })).not.toMatch(/access_token|Bearer ey/);
      }
    } finally {
      delete process.env.BASE_URL_L0176;
    }
  });

  // The owner's review of #408: Policy's JWKS route is private. Its keys are
  // fetched with this service's ID token, and a key-service failure is
  // temporary.
  describe("Policy's keys", () => {
    const POLICY = "https://policy.example";
    const keysServer = ({ fail = false } = {}) => {
      const asked = [];
      const fetch = async (url, { headers }) => {
        asked.push({ url, authorization: headers.Authorization });
        if (fail || headers.Authorization !== `Bearer id-for-${POLICY}`) return { ok: false, status: 403, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => jwks };
      };
      return { asked, fetch };
    };

    it("are fetched with an ID token for Policy, and verify a grant", async () => {
      const id = await privateTask();
      const server = keysServer();
      const keyed = createApp({ authUrl: authApp.url, renderGrantVerifier: buildRenderGrantVerifier({ jwks: buildPolicyJwks({ policyUrl: POLICY, idToken: async aud => `id-for-${aud}`, fetch: server.fetch }) }) });
      await withGrant(request(keyed).get("/data").query({ id }), await grantFor(id)).expect(200);
      await withGrant(request(keyed).get("/data").query({ id }), await grantFor(id)).expect(200);
      expect(server.asked).toEqual([{ url: `${POLICY}/v1/jwks`, authorization: `Bearer id-for-${POLICY}` }]);
    });

    it("answer 503 when they can't be fetched: refused, unreachable, or no ID token", async () => {
      const id = await privateTask();
      for (const verifier of [
        buildPolicyJwks({ policyUrl: POLICY, idToken: async aud => `id-for-${aud}`, fetch: keysServer({ fail: true }).fetch }),
        buildPolicyJwks({ policyUrl: POLICY, idToken: async () => "not-policy's", fetch: keysServer().fetch }),
        buildPolicyJwks({ policyUrl: POLICY, idToken: async aud => `id-for-${aud}`, fetch: async () => { throw new Error("unreachable"); } }),
        buildPolicyJwks({ policyUrl: POLICY, idToken: async () => { throw new Error("no metadata server"); }, fetch: keysServer().fetch }),
      ]) {
        const keyed = createApp({ authUrl: authApp.url, renderGrantVerifier: buildRenderGrantVerifier({ jwks: verifier }) });
        const res = await withGrant(request(keyed).get("/data").query({ id }), await grantFor(id)).expect(503);
        expect(res.body.error.message).toBe("render-grants-unavailable");
      }
    });

    it("are held for a while, fetched again for an unknown key at most every 30 s, and never used stale", async () => {
      let now = 0;
      const server = keysServer();
      let fail = false;
      const fetch = async (url, init) => (fail ? { ok: false, status: 500, json: async () => ({}) } : server.fetch(url, init));
      const keys = buildPolicyJwks({ policyUrl: POLICY, idToken: async aud => `id-for-${aud}`, fetch, now: () => now });
      const verify = buildRenderGrantVerifier({ jwks: keys });
      const id = "task-x";
      await verify(await grantFor(id));
      // An unknown kid: refused, without a fetch inside the cooldown.
      const stranger = await createLocalSigner({ privateJwk: await exportJWK((await generateKeyPair("ES256", { extractable: true })).privateKey), kid: "k9" });
      await expect(verify(await grantFor(id, {}, stranger))).rejects.toMatchObject({ status: 401 });
      expect(server.asked).toHaveLength(1);
      now += JWKS_REFETCH_MS;
      await expect(verify(await grantFor(id, {}, stranger))).rejects.toMatchObject({ status: 401 });
      expect(server.asked).toHaveLength(2);
      // Past their time, keys that can't be fetched again are not used.
      now += JWKS_TTL_MS;
      fail = true;
      await expect(verify(await grantFor(id))).rejects.toMatchObject({ status: 503 });
    });
  });

  // The owner's second review of #408: a key rotation seen by two requests at
  // once. The first starts the refresh; the second waits for it rather than
  // deciding on the keys being replaced; a failed refresh is both's 503.
  it("shares one refresh between concurrent requests, and its failure", async () => {
    const POLICY = "https://policy.example";
    const rotated = await generateKeyPair("ES256", { extractable: true });
    const rotatedSigner = await createLocalSigner({ privateJwk: await exportJWK(rotated.privateKey), kid: "k2" });
    const rotatedJwks = { keys: [...jwks.keys, { ...(await exportJWK(rotated.publicKey)), kid: "k2", alg: "ES256", use: "sig" }] };
    let now = 0;
    let served = jwks;
    // Each refresh after the first waits at a gate the test opens.
    const gate = () => {
      let open = () => {};
      const shut = new Promise(resolve => { open = () => resolve(undefined); });
      return { shut, open };
    };
    let current = gate();
    const release = () => current.open();
    let fail = false;
    const fetches = [];
    const fetch = async () => {
      fetches.push(now);
      if (fetches.length > 1) await current.shut;
      if (fail) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => served };
    };
    const verify = buildRenderGrantVerifier({ jwks: buildPolicyJwks({ policyUrl: POLICY, idToken: async aud => `id-for-${aud}`, fetch, now: () => now }) });
    await verify(await grantFor("t"));
    // Policy rotates; two grants under the new key arrive together.
    served = rotatedJwks;
    now += JWKS_REFETCH_MS;
    const [r1, r2] = [await grantFor("t", {}, rotatedSigner), await grantFor("t", {}, rotatedSigner)];
    const both = Promise.all([verify(r1), verify(r2)]);
    await new Promise(resolve => setImmediate(resolve));
    release();
    const claims = await both;
    expect(claims.map(c => c.tsk)).toEqual(["t", "t"]);
    expect(fetches).toHaveLength(2);
    // A refresh that fails is every waiter's 503.
    now += JWKS_TTL_MS;
    fail = true;
    current = gate();
    const [g1, g2] = [await grantFor("t"), await grantFor("t")];
    const failing = Promise.allSettled([verify(g1), verify(g2)]);
    await new Promise(resolve => setImmediate(resolve));
    release();
    const outcomes = await failing;
    expect(outcomes.map(o => o.status === "rejected" && o.reason.status)).toEqual([503, 503]);
    expect(fetches).toHaveLength(3);
  });

  it("never logs a credential's value", () => {
    expect(loggableHeaders({ Authorization: "Bearer t", [RENDER_GRANT_HEADER]: "g", Cookie: "c", host: "h" })).toEqual({ Authorization: "[redacted]", [RENDER_GRANT_HEADER]: "[redacted]", Cookie: "[redacted]", host: "h" });
  });
});
