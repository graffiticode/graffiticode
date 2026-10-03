import { buildLearnosityDataApi } from "./learnosity.js";
import { ProviderRejected } from "./operations.js";

const respond = (status, body) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => (typeof body === "string" ? JSON.parse(body) : body)
});
const call = (fetch, timeoutMs = 1000) => buildLearnosityDataApi({ baseUrl: "https://data.example", fetch })({ route: "/itembank/items", request: {}, timeoutMs });

describe("Learnosity Data API client", () => {
  it("returns a recognized success", async () => {
    await expect(call(respond(200, { meta: { status: true } }))).resolves.toEqual({ meta: { status: true } });
  });

  it("treats a recognized Learnosity rejection as definite", async () => {
    await expect(call(respond(400, { meta: { status: false } }))).rejects.toBeInstanceOf(ProviderRejected);
    await expect(call(respond(200, { meta: { status: false } }))).rejects.toBeInstanceOf(ProviderRejected);
  });

  it("never treats an ambiguous response as success or rejection", async () => {
    const ambiguous = [
      respond(200, "not json"),
      respond(200, {}),
      respond(200, { meta: {} }),
      respond(503, { meta: { status: false } }),
      respond(499, "not json"),
      respond(400, "not json"),
      respond(404, {}),
      respond(400, { meta: { status: true } }),
      async () => { throw new Error("socket hang up"); }
    ];
    for (const fetch of ambiguous) {
      const err = await call(fetch).catch(e => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ProviderRejected);
    }
  });

  it("abandons a request after its timeout, as uncertain", async () => {
    const hang = async (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason));
    });
    const err = await call(hang, 20).catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).toMatch(/TimeoutError/);
    expect(err).not.toBeInstanceOf(ProviderRejected);
  });

  it("refuses to call the provider without a timeout", async () => {
    // @ts-expect-error a test double for fetch
    const api = buildLearnosityDataApi({ baseUrl: "https://data.example", fetch: respond(200, { meta: { status: true } }) });
    // @ts-expect-error deliberately missing
    await expect(api({ route: "/itembank/items", request: {} })).rejects.toThrow(/timeout/);
    await expect(api({ route: "/itembank/items", request: {}, timeoutMs: 0 })).rejects.toThrow(/timeout/);
  });
});
