import { jest } from "@jest/globals";
import { buildAllocateInvocation, inputDigest, InvocationRefused } from "./invocations.js";

const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

describe("invocations", () => {
  const idToken = async audience => `idt:${audience}`;

  it("asks policy for an invocation as the gateway, on behalf of the user", async () => {
    const fetch = jest.fn(reply(200, { data: { invocationToken: "a.b.c" } }));
    const allocate = buildAllocateInvocation({ policyUrl: "https://policy", idToken, fetch });

    await expect(allocate({ authToken: "user", connectionId: "conn-1", taskId: "t1", options: {}, idempotencyKey: "job-1" }))
      .resolves.toEqual({ invocationToken: "a.b.c" });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://policy/v1/invocations");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer user",
      "X-Serverless-Authorization": "Bearer idt:https://policy",
      "X-Caller-Identity": "idt:urn:graffiticode:policy"
    });
    expect(JSON.parse(init.body)).toEqual({ connectionId: "conn-1", taskId: "t1", inputDigest: inputDigest({}), idempotencyKey: "job-1" });
  });

  it("reports a policy refusal with its reason", async () => {
    const allocate = buildAllocateInvocation({
      policyUrl: "https://policy", idToken, fetch: reply(403, { error: { reason: "idempotency-key-reused" } })
    });
    const err = await allocate({ authToken: "u", connectionId: "c", taskId: "t" }).catch(e => e);
    expect(err).toBeInstanceOf(InvocationRefused);
    expect(err.reason).toBe("idempotency-key-reused");
  });

  it("digests input independently of key order", () => {
    expect(inputDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(inputDigest({ b: { d: 3, c: 2 }, a: 1 }));
    expect(inputDigest(undefined)).toBe(inputDigest({}));
    expect(inputDigest({ a: 1 })).not.toBe(inputDigest({ a: 2 }));
  });
});
