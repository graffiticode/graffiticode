import { jest } from "@jest/globals";
import { buildAllocateInvocation, inputDigest, InvocationRefused } from "./invocations.js";

const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

describe("invocations", () => {
  const idToken = async audience => `idt:${audience}`;

  it("asks for a marked invocation when chain admission is wanted, and reports its marker (W4)", async () => {
    const INVOCATION = { invocationToken: "a.b.c", invocationId: "inv-1", seq: 1, ownerUid: "owner" };
    // A test double: jest's mock doesn't carry fetch's type.
    const fetch = /** @type {any} */ (jest.fn(reply(200, { data: { ...INVOCATION, reused: false, contract: 2 } })));
    const allocate = buildAllocateInvocation({ policyUrl: "https://policy", idToken, fetch });
    await expect(allocate({ authToken: "user", connectionId: "conn-1", taskId: "t1", options: {}, idempotencyKey: "job-1", admission: true }))
      .resolves.toEqual({ ...INVOCATION, contract: 2 });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ admission: true });
  });

  it("asks policy for an invocation as the gateway, on behalf of the user", async () => {
    const INVOCATION = { invocationToken: "a.b.c", invocationId: "inv-1", seq: 3, ownerUid: "owner" };
    const fetch = jest.fn(reply(200, { data: { ...INVOCATION, reused: false } }));
    // @ts-expect-error TS-MIGRATE: jest mock typed as an untyped function
    const allocate = buildAllocateInvocation({ policyUrl: "https://policy", idToken, fetch });

    // An older Policy sends no marker: the invocation is contract 1 (W4).
    await expect(allocate({ authToken: "user", connectionId: "conn-1", taskId: "t1", options: {}, idempotencyKey: "job-1" }))
      .resolves.toEqual({ ...INVOCATION, contract: 1 });

    // @ts-expect-error TS-MIGRATE: jest mock typed as an untyped function
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://policy/v1/invocations");
    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
    expect(init.headers).toMatchObject({
      Authorization: "Bearer user",
      "X-Serverless-Authorization": "Bearer idt:https://policy",
      "X-Caller-Identity": "idt:urn:graffiticode:policy"
    });
    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
    expect(JSON.parse(init.body)).toEqual({ connectionId: "conn-1", taskId: "t1", inputDigest: inputDigest({}), idempotencyKey: "job-1" });
  });

  it("reports a policy refusal with its reason", async () => {
    const allocate = buildAllocateInvocation({
      // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
      policyUrl: "https://policy", idToken, fetch: reply(403, { error: { reason: "idempotency-key-reused" } })
    });
    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
    const err = await allocate({ authToken: "u", connectionId: "c", taskId: "t" }).catch(e => e);
    expect(err).toBeInstanceOf(InvocationRefused);
    expect(err.reason).toBe("idempotency-key-reused");
  });

  // The client and its refusal moved to @graffiticode/policy (W2 PR 4): api's
  // name for the class must stay the same class, or its handlers' instanceof
  // checks (read.js, data.js, routes/publications.js) would miss refusals.
  it("re-exports the shared client's refusal class and client unchanged", async () => {
    const shared = await import("@graffiticode/policy/client");
    const { buildPolicyRequest } = await import("./invocations.js");
    expect(InvocationRefused).toBe(shared.PolicyRefused);
    expect(buildPolicyRequest).toBe(shared.buildPolicyRequest);
  });

  it("digests input independently of key order", () => {
    expect(inputDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(inputDigest({ b: { d: 3, c: 2 }, a: 1 }));
    expect(inputDigest(undefined)).toBe(inputDigest({}));
    expect(inputDigest({ a: 1 })).not.toBe(inputDigest({ a: 2 }));
  });
});
