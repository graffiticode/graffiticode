// Contract v3's token claims (docs/c5-l0013-commands-plan.md decision 6): a
// connection is optional only under v3, a session's connection claims travel
// together, and an execution or replay token selects exactly one scope. Every
// v1/v2 token keeps exactly the claims it always required.
import { generateKeyPair, exportJWK, SignJWT, importJWK } from "jose";
import { createLocalSigner, issueToken, verifyToken, ISSUER, ALG, PROFILES } from "./tokens.js";

let signer;
let jwks;
let rawSign;
beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = await exportJWK(pair.privateKey);
  signer = await createLocalSigner({ privateJwk, kid: "k1" });
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "ES256", use: "sig" }] };
  // Signs any claims with a profile's typ and audience, bypassing issuance's
  // checks, to prove verification enforces the rules on its own.
  const key = await importJWK(privateJwk, ALG);
  rawSign = async (name, claims) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ ...claims, iss: ISSUER, aud: PROFILES[name].audience, iat: now, exp: now + 30, jti: "j1" })
      .setProtectedHeader({ alg: ALG, kid: "k1", typ: PROFILES[name].typ })
      .sign(key);
  };
});

const CONN = { own: "u1", conn: "conn-1", backend: "learnosity" };
const ITEM = { scp: { kind: "item", id: "item-1" } };
const EXEC = { sub: "u1", lang: "0013", fn: "snap", op: "gcs.put-thumbnail", sid: "s1", opid: "inv/s0/o1", argd: "a".repeat(64), rv: 9, prv: "user" };
const SESSION = { sub: "u1", lang: "0013", inv: "inv-1", stg: "s0", rv: 9, fns: ["snap"] };

const issued = (name, claims) => issueToken(signer, name, claims);
const roundTrip = async (name, claims) => (await verifyToken(jwks, name, await issued(name, claims))).claims;
const refusedAtVerify = async (name, claims, pattern) => {
  await expect(verifyToken(jwks, name, await rawSign(name, claims))).rejects.toThrow(pattern);
};

describe("contract v1/v2 tokens are unchanged", () => {
  it("still requires the connection everywhere it did", async () => {
    await expect(issued("invocation", { sub: "u1", inv: "inv-1", seq: 1, cv: 2 })).rejects.toThrow(/conn/);
    await expect(issued("invocation", { sub: "u1", inv: "inv-1", seq: 1 })).rejects.toThrow(/conn/);
    await expect(issued("admission", { sub: "u1", inv: "inv-1", pld: "p", cv: 2 })).rejects.toThrow(/conn/);
    await expect(issued("session", { ...SESSION, cv: 2 })).rejects.toThrow(/conn/);
    await expect(issued("session", { ...SESSION })).rejects.toThrow(/conn/);
    await expect(issued("execution", { ...EXEC, cv: 2 })).rejects.toThrow(/exactly one scope/);
    await expect(issued("replay", { ...EXEC, cv: 2 })).rejects.toThrow(/exactly one scope/);
  });

  it("accepts them as before", async () => {
    await expect(roundTrip("invocation", { sub: "u1", conn: "conn-1", inv: "inv-1", seq: 1, cv: 2 })).resolves.toMatchObject({ conn: "conn-1" });
    await expect(roundTrip("session", { ...SESSION, ...CONN, cv: 2 })).resolves.toMatchObject(CONN);
    await expect(roundTrip("execution", { ...EXEC, ...CONN, cv: 2 })).resolves.toMatchObject(CONN);
    await expect(roundTrip("execution", { ...EXEC, ...CONN })).resolves.toMatchObject(CONN);
  });

  it("refuses a session or execution token with only some of its connection's claims", async () => {
    for (const drop of ["own", "conn", "backend"]) {
      const partial = { ...CONN };
      delete partial[drop];
      await expect(issued("session", { ...SESSION, ...partial, cv: 2 })).rejects.toThrow(/go together/);
      await expect(issued("execution", { ...EXEC, ...partial, cv: 2 })).rejects.toThrow(/go together/);
      await refusedAtVerify("execution", { ...EXEC, ...partial, cv: 3 }, /go together/);
    }
  });
});

describe("contract v3 tokens", () => {
  it("let a plan's invocation, admission and session have no connection", async () => {
    await expect(roundTrip("invocation", { sub: "u1", inv: "inv-1", seq: 1, cv: 3 })).resolves.not.toHaveProperty("conn");
    await expect(roundTrip("admission", { sub: "u1", inv: "inv-1", pld: "p", cv: 3 })).resolves.not.toHaveProperty("conn");
    await expect(roundTrip("session", { ...SESSION, cv: 3 })).resolves.not.toHaveProperty("conn");
    // A v3 plan with a connection scope still carries it (mixed chains).
    await expect(roundTrip("admission", { sub: "u1", conn: "conn-1", inv: "inv-1", pld: "p", cv: 3 })).resolves.toMatchObject({ conn: "conn-1" });
    await expect(roundTrip("session", { ...SESSION, ...CONN, cv: 3 })).resolves.toMatchObject(CONN);
  });

  it("select exactly one scope in an execution or replay token", async () => {
    for (const name of ["execution", "replay"]) {
      await expect(roundTrip(name, { ...EXEC, ...ITEM, cv: 3 })).resolves.toMatchObject(ITEM);
      await expect(roundTrip(name, { ...EXEC, ...CONN, cv: 3 })).resolves.toMatchObject(CONN);
      // Both, or neither, is refused at issuance and at verification.
      await expect(issued(name, { ...EXEC, ...CONN, ...ITEM, cv: 3 })).rejects.toThrow(/exactly one scope/);
      await expect(issued(name, { ...EXEC, cv: 3 })).rejects.toThrow(/exactly one scope/);
      await refusedAtVerify(name, { ...EXEC, ...CONN, ...ITEM, cv: 3 }, /exactly one scope/);
      await refusedAtVerify(name, { ...EXEC, cv: 3 }, /exactly one scope/);
    }
  });

  it("allow an item scope only under v3, and only as a well-formed item", async () => {
    await expect(issued("execution", { ...EXEC, ...ITEM, cv: 2 })).rejects.toThrow(/conn/);
    await expect(issued("execution", { ...EXEC, ...ITEM })).rejects.toThrow(/conn/);
    await refusedAtVerify("execution", { ...EXEC, ...ITEM, cv: 2 }, /conn/);
    for (const scp of [{ kind: "connection", id: "conn-1" }, { kind: "item", id: "" }, { kind: "item" }, { kind: "item", id: "x", extra: 1 }, { kind: "item", id: 7 }]) {
      await expect(issued("execution", { ...EXEC, scp, cv: 3 })).rejects.toThrow(/scp/);
    }
    await expect(issued("execution", { ...EXEC, scp: "item:x", cv: 3 })).rejects.toThrow(/scp/);
  });

  it("refuses a connectionless plan token that isn't v3, at verification too", async () => {
    await refusedAtVerify("invocation", { sub: "u1", inv: "inv-1", seq: 1, cv: 2 }, /conn/);
    await refusedAtVerify("admission", { sub: "u1", inv: "inv-1", pld: "p", cv: 2 }, /conn/);
    await refusedAtVerify("session", { ...SESSION, cv: 2 }, /conn/);
  });
});
