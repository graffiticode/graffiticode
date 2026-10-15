import request from "supertest";
import { createHttpApp } from "@graffiticode/common/http";
import { createCallerIdentity } from "@graffiticode/common/caller";
import { signActAsGrant } from "@graffiticode/common/act-as";
import { buildInternalRouter } from "./internal.js";
import { buildActAsConfig, createPseudonymizer, parseActAsCallers } from "../act-as-config.js";
import { startAuthApp } from "../testing/app.js";

const CONSOLE = "console-run@graffiticode-app.iam.gserviceaccount.com";
const MCP = "mcp-run@graffiticode-app.iam.gserviceaccount.com";
const AUDIENCE = "urn:graffiticode:auth";
const SECRET = "g".repeat(32);
const NOW = 1_000_000;

// Same fake as policy's app.spec: "idt|<email>|<audience>" stands for a
// Google-signed ID token for <email>, valid for <audience> only.
const verifyIdToken = async (token, audience) => {
  const [kind, email, aud] = String(token).split("|");
  if (kind !== "idt" || aud !== audience) throw new Error("bad token");
  // eslint-disable-next-line camelcase
  return { iss: "https://accounts.google.com", email, email_verified: true, aud };
};
const idt = (email, aud = AUDIENCE) => `idt|${email}|${aud}`;

const grantFor = (over = {}) => signActAsGrant(SECRET, {
  purpose: "generation", uid: "alice", subject: "gen-1", notAfter: NOW + 60_000, ...over,
});
const body = (over = {}) => ({ purpose: "generation", uid: "alice", subject: "gen-1", grant: grantFor(), ...over });

describe("POST /internal/act-as", () => {
  let app;
  let audits;
  let minted;
  beforeEach(() => {
    audits = [];
    minted = [];
    const actAs = {
      identifyCaller: createCallerIdentity({
        verifyIdToken,
        audience: AUDIENCE,
        callers: parseActAsCallers(JSON.stringify({ [CONSOLE]: { role: "console" } })),
        requireServerlessMatch: false,
      }),
      grantSecret: SECRET,
      pseudonymize: createPseudonymizer({ secret: "p".repeat(16) }),
      audit: record => audits.push(record),
      now: () => NOW,
    };
    const authService = {
      createAccessToken: async ({ uid, additionalClaims }) => {
        minted.push({ uid, additionalClaims });
        return `access-token-for-${uid}`;
      },
    };
    app = createHttpApp(a => a.use("/internal", buildInternalRouter({ actAs, authService })));
  });

  const post = (b, identity = idt(CONSOLE)) => {
    const r = request(app).post("/internal/act-as");
    return (identity ? r.set("X-Caller-Identity", identity) : r).send(b);
  };

  it("issues a delegated 5-minute token to the console worker for its grant", async () => {
    const res = await post(body()).expect(200);
    expect(res.body.data).toEqual({ accessToken: "access-token-for-alice", expiresIn: 300 });
    expect(minted).toEqual([{ uid: "alice", additionalClaims: { act: { sub: CONSOLE, purpose: "generation", subject: "gen-1" } } }]);
    expect(audits).toEqual([expect.objectContaining({ event: "act-as", outcome: "allowed", caller: CONSOLE, purpose: "generation" })]);
    expect(audits[0].uid).toMatch(/^[0-9a-f]{24}$/);
    expect(JSON.stringify(audits)).not.toContain("alice");
  });

  it("refuses the shared internal API key alone", async () => {
    await request(app).post("/internal/act-as").set("X-Internal-API-Key", "anything").send(body()).expect(401);
    expect(minted).toEqual([]);
    expect(audits).toEqual([expect.objectContaining({ outcome: "denied", reason: "caller-rejected" })]);
  });

  it("refuses other service identities and other audiences", async () => {
    await post(body(), idt(MCP)).expect(403);
    await post(body(), idt("auth-run@graffiticode.iam.gserviceaccount.com")).expect(403);
    await post(body(), idt(CONSOLE, "urn:graffiticode:policy")).expect(401);
    await post(body(), "not-a-token").expect(401);
    expect(minted).toEqual([]);
    expect(audits.map(a => a.reason)).toEqual(["caller-rejected", "caller-rejected", "caller-rejected", "caller-rejected"]);
  });

  it("refuses forged, mismatched, expired and wrong-purpose grants", async () => {
    const cases = [
      [body({ grant: signActAsGrant("x".repeat(32), { purpose: "generation", uid: "alice", subject: "gen-1", notAfter: NOW + 60_000 }) }), "grant-bad-signature"],
      [body({ uid: "bob" }), "grant-uid-mismatch"],
      [body({ subject: "gen-2" }), "grant-subject-mismatch"],
      [body({ grant: grantFor({ notAfter: NOW }) }), "grant-expired"],
      [body({ purpose: "effect" }), "grant-wrong-purpose"],
      [body({ grant: grantFor({ purpose: "effect" }) }), "grant-wrong-purpose"],
    ];
    for (const [b] of cases) await post(b).expect(403);
    expect(minted).toEqual([]);
    expect(audits.map(a => a.reason)).toEqual(cases.map(([, reason]) => reason));
  });

  it("checks the caller before the request body", async () => {
    await post({}, null).expect(401);
    await post({}).expect(400);
    expect(audits.map(a => a.reason)).toEqual(["caller-rejected", "bad-request"]);
  });

  it("answers 503 until configured", async () => {
    const unconfigured = createHttpApp(a => a.use("/internal", buildInternalRouter({ actAs: null, authService: {} })));
    await request(unconfigured).post("/internal/act-as").set("X-Caller-Identity", idt(CONSOLE)).send(body()).expect(503);
  });
});

describe("act-as configuration", () => {
  it("is off unless every setting is present", () => {
    expect(buildActAsConfig({ ACT_AS_CALLERS: "{}" }, { OAuth2Client: class {} })).toBeNull();
  });

  it("rejects a short grant secret and non-service-account callers", () => {
    const env = { ACT_AS_CALLERS: JSON.stringify({ [CONSOLE]: { role: "console" } }), ACT_AS_GRANT_SECRET: "short", AUDIT_PSEUDONYM_SECRET: "p".repeat(16) };
    expect(() => buildActAsConfig(env, { OAuth2Client: class {} })).toThrow(/at least 32/);
    expect(() => parseActAsCallers(JSON.stringify({ "someone@example.com": {} }))).toThrow(/not a service account/);
  });
});

describe("a delegated access token", () => {
  let authApp;
  beforeEach(async () => { authApp = await startAuthApp(); });
  afterEach(async () => { await authApp.cleanUp(); });

  it("verifies at /oauth/verify like any access token, as the user", async () => {
    const token = await authApp.authService.createAccessToken({
      uid: "alice",
      additionalClaims: { act: { sub: CONSOLE, purpose: "generation", subject: "gen-1" } },
    });
    const verified = await authApp.client.verifyToken(token);
    expect(verified.uid).toBe("alice");
  });
});
