import { p256 } from "@noble/curves/p256";
import { createKmsSigner, derToJose, issueToken, verifyToken } from "./index.js";

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
    const token = await issueToken(signer, "session", { sub: "u" });
    const { claims, header } = await verifyToken({ keys: [publicJwkFor(privateKey, "kms-1")] }, "session", token);
    expect(header).toEqual({ alg: "ES256", kid: "kms-1", typ: "gc-session+jwt" });
    expect(claims).toMatchObject({ sub: "u", iss: "urn:graffiticode:policy", aud: "urn:graffiticode:policy" });
    expect(kms.calls).toHaveLength(1);
  });

  it("produces tokens that fail against another key", async () => {
    const signer = createKmsSigner({ kms: fakeKms(p256.utils.randomPrivateKey()), keyVersionName: "v", kid: "kms-1" });
    const token = await issueToken(signer, "session", { sub: "u" });
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
});
