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
import { buildRenderGrantVerifier, loggableHeaders, RENDER_GRANT_HEADER } from "./render-grant.js";

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

  it("never logs a credential's value", () => {
    expect(loggableHeaders({ Authorization: "Bearer t", [RENDER_GRANT_HEADER]: "g", Cookie: "c", host: "h" })).toEqual({ Authorization: "[redacted]", [RENDER_GRANT_HEADER]: "[redacted]", Cookie: "[redacted]", host: "h" });
  });
});
