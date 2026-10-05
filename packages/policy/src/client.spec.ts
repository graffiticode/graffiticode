import { jest } from "@jest/globals";
import { buildPolicyRequest, PolicyRefused } from "./index.js";

const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const idToken = async audience => `idt:${audience}`;
// Test doubles stand in for the platform fetch the client's type is inferred from.
const asFetch = f => f as unknown as typeof fetch;

describe("the Policy client", () => {
  it("sends both identity tokens, the user's token when there is one, and the body", async () => {
    const fetch = jest.fn(reply(200, { data: { ok: 1 } }));
    const request = buildPolicyRequest({ policyUrl: "https://policy", idToken, fetch: asFetch(fetch) });
    await expect(request("POST", "/v1/x", { authToken: "user", body: { a: 1 } })).resolves.toEqual({ status: 200, ok: true, body: { data: { ok: 1 } } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, { method: string, headers: Record<string, string>, body: string }];
    expect(url).toBe("https://policy/v1/x");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer user",
      "X-Serverless-Authorization": "Bearer idt:https://policy",
      "X-Caller-Identity": "idt:urn:graffiticode:policy"
    });
    expect(JSON.parse(init.body)).toEqual({ a: 1 });
  });

  it("sends no Authorization or body when there are none", async () => {
    const fetch = jest.fn(reply(200, {}));
    await buildPolicyRequest({ policyUrl: "https://policy", idToken, fetch: asFetch(fetch) })("DELETE", "/v1/x");
    const [, init] = fetch.mock.calls[0] as unknown as [string, { headers: Record<string, string>, body?: string }];
    expect(init.headers).not.toHaveProperty("Authorization");
    expect(init).not.toHaveProperty("body");
  });

  it("throws Policy's refusal with its reason, and returns any other status", async () => {
    const refused = buildPolicyRequest({ policyUrl: "https://policy", idToken, fetch: asFetch(reply(403, { error: { reason: "not-granted" } })) });
    const err = await refused("POST", "/v1/x").catch(e => e);
    expect(err).toBeInstanceOf(PolicyRefused);
    expect(err.reason).toBe("not-granted");
    const unexplained = buildPolicyRequest({ policyUrl: "https://policy", idToken, fetch: asFetch(reply(403, null)) });
    expect((await unexplained("POST", "/v1/x").catch(e => e)).reason).toBe("denied");
    const paused = buildPolicyRequest({ policyUrl: "https://policy", idToken, fetch: asFetch(reply(503, { error: { reason: "maintenance" } })) });
    await expect(paused("POST", "/v1/x")).resolves.toMatchObject({ status: 503, ok: false });
  });

  it("returns a null body for a response that isn't JSON", async () => {
    const fetch = async () => ({ status: 502, ok: false, json: async () => { throw new SyntaxError("not json"); } });
    await expect(buildPolicyRequest({ policyUrl: "https://policy", idToken, fetch: asFetch(fetch) })("GET", "/v1/x")).resolves.toEqual({ status: 502, ok: false, body: null });
  });
});
