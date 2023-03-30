import bent from "bent";
import { startAuthApp } from "../testing/app.js";

describe("routes/certs", () => {
  let getJSON;
  let cleanUp;
  beforeEach(async () => {
    const deps = await startAuthApp();
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
});
