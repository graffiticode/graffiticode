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

  it("should reject key rotation without the internal api key", async () => {
    const prev = process.env.INTERNAL_API_KEY;
    process.env.INTERNAL_API_KEY = "test-internal-key";
    try {
      const postJSON = bent(url, "POST", "json", 401);
      await postJSON("/certs", {});
    } finally {
      if (prev === undefined) delete process.env.INTERNAL_API_KEY;
      else process.env.INTERNAL_API_KEY = prev;
    }
  });
});
