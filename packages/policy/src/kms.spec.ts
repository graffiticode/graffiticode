import { p256 } from "@noble/curves/p256";
import { createKmsSigner, createLocalSigner, derToJose, issueToken, verifyToken } from "./index.js";

const SESSION_CLAIMS = { sub: "u", own: "u", conn: "conn-1", backend: "learnosity", lang: "0176", inv: "inv-1", stg: "s0", rv: 1, fns: ["init"] };

// A stand-in for Cloud KMS asymmetricSign: like KMS, it signs the SHA-256
// digest it is given (no further hashing) and returns a DER signature.
const fakeKms = privateKey => ({
  calls: [],
  async asymmetricSign({ name, digest }) {
    this.calls.push(name);
    return [{ signature: Buffer.from(p256.sign(digest.sha256, privateKey).toDERRawBytes()) }];
  }
});

const publicJwkFor = (privateKey, kid) => {
  const point = p256.ProjectivePoint.fromHex(p256.getPublicKey(privateKey, false));
  const coord = n => Buffer.from(n.toString(16).padStart(64, "0"), "hex").toString("base64url");
  return { kty: "EC", crv: "P-256", x: coord(point.x), y: coord(point.y), kid, alg: "ES256", use: "sig" };
};

describe("KMS signer", () => {
  it("produces ES256 tokens that verify against the KMS public key", async () => {
    const privateKey = p256.utils.randomPrivateKey();
    const kms = fakeKms(privateKey);
    const signer = createKmsSigner({ kms, keyVersionName: "projects/p/locations/l/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1", kid: "kms-1" });
    const token = await issueToken(signer, "session", SESSION_CLAIMS);
    const { claims, header } = await verifyToken({ keys: [publicJwkFor(privateKey, "kms-1")] }, "session", token);
    expect(header).toEqual({ alg: "ES256", kid: "kms-1", typ: "gc-session+jwt" });
    expect(claims).toMatchObject({ sub: "u", iss: "urn:graffiticode:policy", aud: "urn:graffiticode:policy" });
    expect(kms.calls).toHaveLength(1);
  });

  it("produces tokens that fail against another key", async () => {
    const signer = createKmsSigner({ kms: fakeKms(p256.utils.randomPrivateKey()), keyVersionName: "v", kid: "kms-1" });
    const token = await issueToken(signer, "session", SESSION_CLAIMS);
    await expect(verifyToken({ keys: [publicJwkFor(p256.utils.randomPrivateKey(), "kms-1")] }, "session", token)).rejects.toThrow();
  });

  it("converts DER signatures to 64-byte r||s, padding and trimming integers", () => {
    const r = Buffer.alloc(32, 0x11);
    const s = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(32, 0xff)]);
    const shortR = Buffer.alloc(31, 0x22);
    const der = (a, b) => Buffer.concat([
      Buffer.from([0x30, 4 + a.length + b.length, 0x02, a.length]), a, Buffer.from([0x02, b.length]), b
    ]);
    expect(derToJose(der(r, s))).toEqual(Buffer.concat([r, Buffer.alloc(32, 0xff)]));
    expect(derToJose(der(shortR, r))).toEqual(Buffer.concat([Buffer.from([0]), shortR, r]));
    expect(() => derToJose(Buffer.from([0x31, 0]))).toThrow();
  });

  // TOKEN-01: both signers build tokens from the one profile schema. With the
  // clock, token id and key id fixed, their headers and payloads are identical
  // byte for byte; only the (randomized) signatures differ.
  it("issues the same header and claims as the local signer for the same input", async () => {
    const privateKey = p256.utils.randomPrivateKey();
    const publicJwk = publicJwkFor(privateKey, "kid-1");
    const privateJwk = { ...publicJwk, d: Buffer.from(privateKey).toString("base64url") };
    const fixed = { kid: "kid-1", now: () => 1_800_000_000, newJti: () => "jti-1" };
    const kmsSigner = createKmsSigner({ kms: fakeKms(privateKey), keyVersionName: "v", ...fixed });
    const localSigner = await createLocalSigner({ privateJwk, ...fixed });
    const currentDate = new Date(1_800_000_010 * 1000);
    for (const [name, claims] of [
      ["session", SESSION_CLAIMS],
      ["invocation", { sub: "u", conn: "conn-1", inv: "inv-1", seq: 0, pub: "pub-1" }],
      ["execution", { sub: "u", own: "u", conn: "conn-1", backend: "learnosity", lang: "0176", fn: "init", op: "learnosity.sign-items-preview", sid: "s", opid: "o", argd: "d", rv: 1 }]
    ]) {
      const fromKms = await issueToken(kmsSigner, name, claims);
      const fromLocal = await issueToken(localSigner, name, claims);
      expect(fromKms.split(".").slice(0, 2)).toEqual(fromLocal.split(".").slice(0, 2));
      const a = await verifyToken({ keys: [publicJwk] }, name, fromKms, { currentDate });
      const b = await verifyToken({ keys: [publicJwk] }, name, fromLocal, { currentDate });
      expect(a).toEqual(b);
    }
  });

  it("refuses, like the local signer, claims its profile does not allow", async () => {
    const signer = createKmsSigner({ kms: fakeKms(p256.utils.randomPrivateKey()), keyVersionName: "v", kid: "kms-1" });
    await expect(issueToken(signer, "session", { sub: "u" })).rejects.toThrow(/own/);
    await expect(issueToken(signer, "session", { ...SESSION_CLAIMS, iat: 1 })).rejects.toThrow(/iat/);
  });
});
