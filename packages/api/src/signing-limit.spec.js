// The per-client signing limit's bucket and client key (signing-limit.js).
import {
  buildSigningLimiter, buildClientKey, countSigningStages, parseSigningLimitConfig, SigningRateLimited, BUSY_MESSAGE
} from "./signing-limit.js";

const SECRET = "edge-secret-0123456789";
const reqWith = (headers = {}, remoteAddress = "10.9.8.7") => ({
  headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  socket: { remoteAddress },
});

describe("client key", () => {
  const key = buildClientKey({ edgeSecret: SECRET });

  it("trusts CF-Connecting-IP with our edge header and the right secret", () => {
    expect(key(reqWith({ "X-Graffiticode-Edge": SECRET, "CF-Connecting-IP": "203.0.113.5", "X-Forwarded-For": "172.70.1.1" }))).toBe("cf:203.0.113.5");
  });

  it("ignores CF-Connecting-IP with the wrong secret, keying on the front end's address", () => {
    expect(key(reqWith({ "X-Graffiticode-Edge": `${SECRET}x`, "CF-Connecting-IP": "203.0.113.5", "X-Forwarded-For": "172.70.1.1" }))).toBe("ip:172.70.1.1");
    expect(key(reqWith({ "X-Graffiticode-Edge": "", "CF-Connecting-IP": "203.0.113.5", "X-Forwarded-For": "172.70.1.1" }))).toBe("ip:172.70.1.1");
  });

  it("ignores a forged CF-Connecting-IP with no edge header", () => {
    expect(key(reqWith({ "CF-Connecting-IP": "203.0.113.5", "X-Forwarded-For": "198.51.100.7" }))).toBe("ip:198.51.100.7");
  });

  it("never trusts the edge header when no secret is configured", () => {
    const unset = buildClientKey({ edgeSecret: null });
    expect(unset(reqWith({ "X-Graffiticode-Edge": "", "CF-Connecting-IP": "203.0.113.5", "X-Forwarded-For": "198.51.100.7" }))).toBe("ip:198.51.100.7");
    expect(unset(reqWith({ "X-Graffiticode-Edge": "anything", "CF-Connecting-IP": "203.0.113.5", "X-Forwarded-For": "198.51.100.7" }))).toBe("ip:198.51.100.7");
    expect(parseSigningLimitConfig({ EDGE_AUTH_SECRET: "  " }).edgeSecret).toBe(null);
  });

  it("keys on the LAST X-Forwarded-For entry, the one Google's front end appended", () => {
    // Earlier entries are the client's own, so each forged one changes nothing.
    expect(key(reqWith({ "X-Forwarded-For": "1.1.1.1, 2.2.2.2, 198.51.100.7" }))).toBe("ip:198.51.100.7");
    expect(key(reqWith({ "X-Forwarded-For": "9.9.9.9, 198.51.100.7" }))).toBe("ip:198.51.100.7");
    expect(key(reqWith({ "X-Forwarded-For": "2001:db8::1" }))).toBe("ip:2001:db8::1");
  });

  it("keys a user the api verified by uid, ahead of any address", () => {
    const verified = (uid, headers) => ({ ...reqWith(headers), auth: { context: { uid } } });
    expect(key(verified("0xalice", { "X-Forwarded-For": "198.51.100.7" }))).toBe("uid:0xalice");
    expect(key(verified("0xalice", { "X-Graffiticode-Edge": SECRET, "CF-Connecting-IP": "203.0.113.5" }))).toBe("uid:0xalice");
    // No verified context (anonymous, or an invalid token treated as such): by address.
    expect(key({ ...reqWith({ "X-Forwarded-For": "198.51.100.7" }), auth: { context: null, token: "forged" } })).toBe("ip:198.51.100.7");
    expect(key({ ...reqWith({ "X-Forwarded-For": "198.51.100.7" }), auth: { context: { uid: "" } } })).toBe("ip:198.51.100.7");
  });

  it("prefixes each kind of key, so a uid can't collide with an address", () => {
    const asUid = key({ ...reqWith({}), auth: { context: { uid: "198.51.100.7" } } });
    const asIp = key(reqWith({ "X-Forwarded-For": "198.51.100.7" }));
    const asCf = key(reqWith({ "X-Graffiticode-Edge": SECRET, "CF-Connecting-IP": "198.51.100.7" }));
    expect(new Set([asUid, asIp, asCf]).size).toBe(3);
  });

  it("falls back to the socket address with no X-Forwarded-For, and never a client-chosen key", () => {
    expect(key(reqWith({}, "127.0.0.1"))).toBe("ip:127.0.0.1");
    expect(key(reqWith({ "X-Forwarded-For": "1.1.1.1, not-an-address" }))).toBe("ip:unknown");
  });
});

describe("signing stages", () => {
  it("counts every L0176 stage, however its lang is written", () => {
    expect(countSigningStages([{ lang: "0176" }, { lang: "L0176" }, { lang: "0000" }, { lang: "176" }])).toBe(3);
    expect(countSigningStages([{ lang: "0158" }])).toBe(0);
    expect(countSigningStages(null)).toBe(0);
  });
});

describe("token bucket", () => {
  let t;
  let records;
  const limiter = (over = {}) => buildSigningLimiter({ ratePerMinute: 10, burst: 10, now: () => t, audit: r => { records.push(r); }, ...over });
  const req = reqWith({ "X-Forwarded-For": "198.51.100.7" });
  const other = reqWith({ "X-Forwarded-For": "198.51.100.8" });
  beforeEach(() => {
    t = 1_000_000;
    records = [];
  });

  it("allows the burst, then refuses with Retry-After, charging nothing on refusal", async () => {
    const l = limiter();
    for (let i = 0; i < 10; i++) await l.charge(req, 1);
    const err = await l.charge(req, 1).catch(e => e);
    expect(err).toBeInstanceOf(SigningRateLimited);
    expect(err.statusCode).toBe(429);
    expect(err.reason).toBe("rate-limited");
    expect(err.message).toBe(BUSY_MESSAGE);
    expect(err.retryAfter).toBe(6);
    expect(records).toEqual([{ event: "system-signing-limit", outcome: "denied", reason: "rate-limited", category: "unavailable", lang: "0176" }]);
    // 6 s refills one stage.
    t += 6000;
    await l.charge(req, 1);
    await expect(l.charge(req, 1)).rejects.toBeInstanceOf(SigningRateLimited);
  });

  it("charges a batch all or nothing", async () => {
    const l = limiter();
    await l.charge(req, 7);
    await expect(l.charge(req, 4)).rejects.toBeInstanceOf(SigningRateLimited);
    // The refused 4 took nothing: 3 remain.
    await l.charge(req, 3);
    await expect(l.charge(req, 1)).rejects.toBeInstanceOf(SigningRateLimited);
  });

  it("refuses a request with more stages than the burst", async () => {
    const err = await limiter().charge(req, 11).catch(e => e);
    expect(err).toBeInstanceOf(SigningRateLimited);
    expect(err.message).toMatch(/11 signing stages/);
  });

  it("keeps each client's bucket apart", async () => {
    const l = limiter();
    await l.charge(req, 10);
    await expect(l.charge(req, 1)).rejects.toBeInstanceOf(SigningRateLimited);
    await l.charge(other, 10);
  });

  it("charges nothing for zero stages", async () => {
    const l = limiter({ burst: 1 });
    for (let i = 0; i < 5; i++) await l.charge(req, 0);
    await l.charge(req, 1);
    expect(records).toEqual([]);
  });

  it("refills no further than the burst", async () => {
    const l = limiter();
    await l.charge(req, 1);
    t += 60 * 60 * 1000;
    await l.charge(req, 10);
    await expect(l.charge(req, 1)).rejects.toBeInstanceOf(SigningRateLimited);
  });

  it("holds a bounded number of clients", async () => {
    const l = limiter({ maxClients: 3 });
    for (let i = 0; i < 10; i++) await l.charge(reqWith({ "X-Forwarded-For": `198.51.100.${i}` }), 1);
    expect(l.size()).toBeLessThanOrEqual(3);
  });

  it("reads its numbers from the environment, 10 and 10 by default", () => {
    expect(parseSigningLimitConfig({})).toEqual({ ratePerMinute: 10, burst: 10, edgeSecret: null });
    expect(parseSigningLimitConfig({ SYSTEM_SIGNING_STAGES_PER_CLIENT_PER_MINUTE: "30", SYSTEM_SIGNING_STAGES_BURST: "5", EDGE_AUTH_SECRET: `${SECRET}\n` }))
      .toEqual({ ratePerMinute: 30, burst: 5, edgeSecret: SECRET });
    expect(() => parseSigningLimitConfig({ SYSTEM_SIGNING_STAGES_BURST: "0" })).toThrow(/SYSTEM_SIGNING_STAGES_BURST/);
  });
});
