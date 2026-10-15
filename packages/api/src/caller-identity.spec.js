// The api's identity on compiles to L0176 (caller-identity.js).
import { jest } from "@jest/globals";
import { buildCallerIdentity } from "./caller-identity.js";
import { buildCompile } from "./comp.js";

describe("caller identity", () => {
  it("mints an ID token for L0176, audience urn:graffiticode:0176", async () => {
    const audiences = [];
    const identity = buildCallerIdentity({ idToken: async aud => { audiences.push(aud); return `tok(${aud})`; } });
    await expect(identity("0176")).resolves.toEqual({ "X-Caller-Identity": "tok(urn:graffiticode:0176)" });
    await expect(identity("L0176")).resolves.toEqual({ "X-Caller-Identity": "tok(urn:graffiticode:0176)" });
    expect(audiences).toEqual(["urn:graffiticode:0176", "urn:graffiticode:0176"]);
  });

  it("gives other languages nothing, and mints nothing for them", async () => {
    const idToken = jest.fn(async () => "tok");
    const identity = buildCallerIdentity({ idToken });
    await expect(identity("0000")).resolves.toBe(null);
    await expect(identity("0158")).resolves.toBe(null);
    expect(idToken).not.toHaveBeenCalled();
  });

  it("is fail-safe: a failed, empty or stalled mint sends the compile without it, and logs", async () => {
    const log = jest.fn();
    await expect(buildCallerIdentity({ idToken: async () => { throw new Error("metadata down"); }, log })("0176")).resolves.toBe(null);
    await expect(buildCallerIdentity({ idToken: async () => "", log })("0176")).resolves.toBe(null);
    await expect(buildCallerIdentity({ idToken: () => new Promise(() => {}), timeoutMs: 20, log })("0176")).resolves.toBe(null);
    expect(log).toHaveBeenCalledTimes(3);
    expect(String(log.mock.calls[0][0])).toMatch(/caller identity for L0176 not minted/);
    await expect(buildCallerIdentity({ idToken: null })("0176")).resolves.toBe(null);
  });

  it("rides with the compile through comp.js, beside the request", async () => {
    const langCompile = /** @type {any} */ (jest.fn(async () => ({ data: {} })));
    const compile = buildCompile({ langCompile, callerIdentity: buildCallerIdentity({ idToken: async () => "tok" }) });
    await compile({ lang: "0176", code: { root: 1 } });
    await compile({ lang: "0000", code: { root: 1 } });
    expect(langCompile.mock.calls[0][2]).toEqual({ uid: null, headers: { "X-Caller-Identity": "tok" } });
    expect(langCompile.mock.calls[1][2]).toEqual({ uid: null });
  });
});
