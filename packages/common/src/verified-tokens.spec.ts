import { cacheVerifications } from "./verified-tokens.js";

const jwt = (exp?: number) => `h.${Buffer.from(JSON.stringify(exp === undefined ? {} : { exp })).toString("base64url")}.s`;

describe("cacheVerifications", () => {
  let t: number;
  let calls: string[];
  const now = () => t;
  const ok = async (token: string) => { calls.push(token); return { uid: "u1" }; };
  beforeEach(() => { t = 1_000_000_000_000; calls = []; });

  it("asks auth once per token within the window, then again after it", async () => {
    const verify = cacheVerifications(ok, { ttlMs: 60_000, now });
    const token = jwt(t / 1000 + 3600);
    await expect(verify(token)).resolves.toEqual({ uid: "u1" });
    t += 59_000;
    await verify(token);
    expect(calls).toHaveLength(1);
    t += 2_000;
    await verify(token);
    expect(calls).toHaveLength(2);
  });

  it("never remembers a token past its own expiry", async () => {
    const verify = cacheVerifications(ok, { ttlMs: 60_000, now });
    const token = jwt(t / 1000 + 10);
    await verify(token);
    t += 11_000;
    await verify(token);
    expect(calls).toHaveLength(2);
  });

  it("never remembers a refusal: a failed token is asked again", async () => {
    let fail = true;
    const verify = cacheVerifications(async (token: string) => { calls.push(token); if (fail) throw new Error("refused"); return { uid: "u1" }; }, { now });
    const token = jwt(t / 1000 + 3600);
    await expect(verify(token)).rejects.toThrow("refused");
    fail = false;
    await expect(verify(token)).resolves.toEqual({ uid: "u1" });
    expect(calls).toHaveLength(2);
  });

  it("keeps each token apart, and stays within its size by dropping the oldest", async () => {
    const verify = cacheVerifications(ok, { now, max: 2 });
    const [a, b, c] = [1, 2, 3].map(n => jwt(t / 1000 + 3600 + n));
    await verify(a); await verify(b); await verify(c);
    await verify(b); await verify(c);
    expect(calls).toHaveLength(3);
    await verify(a);
    expect(calls).toHaveLength(4);
  });
});
