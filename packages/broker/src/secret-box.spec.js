import { randomBytes } from "node:crypto";
import { createSecretBox } from "./index.js";

const KEY = randomBytes(32).toString("hex");

describe("secret box", () => {
  it("round-trips a secret for its connection", () => {
    const box = createSecretBox({ key: KEY });
    const sealed = box.seal("s3cret", "conn-1");
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("s3cret");
    expect(box.open(sealed, "conn-1")).toBe("s3cret");
  });

  it("does not open a ciphertext moved onto another connection", () => {
    const box = createSecretBox({ key: KEY });
    expect(() => box.open(box.seal("s3cret", "conn-1"), "conn-2")).toThrow();
  });

  it("does not open under another key, or once tampered", () => {
    const sealed = createSecretBox({ key: KEY }).seal("s3cret", "conn-1");
    expect(() => createSecretBox({ key: randomBytes(32).toString("hex") }).open(sealed, "conn-1")).toThrow();
    const [v, iv, ct, tag] = sealed.split(":");
    const flipped = Buffer.from(ct, "base64url");
    flipped[0] ^= 1;
    expect(() => createSecretBox({ key: KEY }).open([v, iv, flipped.toString("base64url"), tag].join(":"), "conn-1")).toThrow();
  });

  it("rejects a key of the wrong size", () => {
    expect(() => createSecretBox({ key: "abcd" })).toThrow();
  });
});
