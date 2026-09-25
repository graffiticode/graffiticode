import bent from "bent";
import { startAuthApp } from "../testing/app.js";

describe("routes/certs", () => {
  let url;
  let getJSON;
  let cleanUp;
  beforeEach(async () => {
    const deps = await startAuthApp();
    url = deps.url;
    getJSON = bent(deps.url, "GET", "json");
    cleanUp = deps.cleanUp;
  });

  afterEach(async () => {
    await cleanUp();
  });

  it("should return public keys", async () => {
    const body = await getJSON("/certs");

    expect(body).toHaveProperty("keys");
  });

  const withInternalKey = async fn => {
    const prev = process.env.INTERNAL_API_KEY;
    process.env.INTERNAL_API_KEY = "test-internal-key";
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.INTERNAL_API_KEY;
      else process.env.INTERNAL_API_KEY = prev;
    }
  };

  it("should refuse key rotation without the internal api key", async () => {
    await withInternalKey(async () => {
      const postJSON = bent(url, "POST", "json", 403);
      await postJSON("/certs", {});
    });
  });

  it("should refuse key rotation with a wrong internal api key", async () => {
    await withInternalKey(async () => {
      const postJSON = bent(url, "POST", "json", 403);
      await postJSON("/certs", {}, { "X-Internal-API-Key": "wrong" });
    });
  });

  it("should rotate the key with the internal api key", async () => {
    await withInternalKey(async () => {
      const before = await getJSON("/certs");
      const postJSON = bent(url, "POST", "json", 200);
      await postJSON("/certs", {}, { "X-Internal-API-Key": "test-internal-key" });
      const after = await getJSON("/certs");
      expect(after.keys.length).toBeGreaterThan(before.keys.length);
    });
  });
});
