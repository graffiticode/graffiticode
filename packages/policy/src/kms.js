// A token signer backed by Cloud KMS (EC_SIGN_P256_SHA256). The private key
// never leaves KMS; only the policy service account may use it to sign. KMS
// returns a DER-encoded ECDSA signature, and JWS ES256 needs the raw 64-byte
// r||s form, so it is converted here.
//
// `kms` is a KeyManagementServiceClient (or anything with the same
// asymmetricSign shape); `keyVersionName` is the full CryptoKeyVersion path.

import { createHash, randomUUID } from "node:crypto";
import { tokenParts } from "./tokens.js";

const b64url = buf => Buffer.from(buf).toString("base64url");

// DER: 30 len 02 lenR R 02 lenS S  ->  R||S, each left-padded to 32 bytes.
export const derToJose = der => {
  const buf = Buffer.from(der);
  let offset = 2;
  if (buf[0] !== 0x30) throw new Error("not a DER sequence");
  if (buf[1] & 0x80) offset = 2 + (buf[1] & 0x7f);
  const readInt = () => {
    if (buf[offset] !== 0x02) throw new Error("not a DER integer");
    const len = buf[offset + 1];
    let int = buf.subarray(offset + 2, offset + 2 + len);
    offset += 2 + len;
    while (int.length > 32 && int[0] === 0) int = int.subarray(1);
    if (int.length > 32) throw new Error("integer too long for P-256");
    return Buffer.concat([Buffer.alloc(32 - int.length), int]);
  };
  const r = readInt();
  const s = readInt();
  return Buffer.concat([r, s]);
};

// Header and payload come from the shared token profiles (tokens.js), as the
// local signer's do; `now` and `newJti` are injectable for comparing signers.
const nowSeconds = () => Math.floor(Date.now() / 1000);

export const createKmsSigner = ({ kms, keyVersionName, kid, now = nowSeconds, newJti = () => String(randomUUID()) }) => ({
  kid,
  sign: async (claims, profile) => {
    const { header, payload } = tokenParts({ claims, profile, kid, now: now(), jti: newJti() });
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const digest = createHash("sha256").update(signingInput).digest();
    const [response] = await kms.asymmetricSign({ name: keyVersionName, digest: { sha256: digest } });
    return `${signingInput}.${b64url(derToJose(response.signature))}`;
  },
});
