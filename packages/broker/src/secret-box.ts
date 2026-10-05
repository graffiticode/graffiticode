// Connection secrets at rest: AES-256-GCM under the broker-only key
// (BROKER_SECRET_KEY, Secret Manager; readable by the broker service account
// alone). This is deliberately NOT the shared compiler keyring: compilers
// must never be able to decrypt a connection secret.
//
// Format: v1:<iv b64url>:<ciphertext b64url>:<tag b64url>. The connection id
// is bound as associated data, so a ciphertext copied onto another connection
// does not decrypt.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const keyFrom = hexOrB64 => {
  const key = /^[0-9a-f]{64}$/i.test(hexOrB64) ? Buffer.from(hexOrB64, "hex") : Buffer.from(hexOrB64, "base64");
  if (key.length !== 32) throw new Error("BROKER_SECRET_KEY must be 32 bytes");
  return key;
};

export const createSecretBox = ({ key }) => {
  const k = keyFrom(key);
  return {
    seal(plaintext, connectionId) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", k, iv);
      cipher.setAAD(Buffer.from(connectionId));
      const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
      return ["v1", iv, ct, cipher.getAuthTag()].map(p => (typeof p === "string" ? p : p.toString("base64url"))).join(":");
    },
    open(sealed, connectionId) {
      const [v, iv, ct, tag] = String(sealed).split(":");
      if (v !== "v1" || !iv || !ct || !tag) throw new Error("unrecognized sealed secret");
      const decipher = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(connectionId));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
    },
  };
};
