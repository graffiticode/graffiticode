import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import langOverrides from "./lang-override.js";

describe("routes/lang-overrides", () => {
  let app;
  let langOverrideStorer;
  const mountWithAuth = (uid) => {
    app = express();
    // Stand in for the auth middleware: attach req.auth with the given uid.
    app.use((req, _res, next) => { req.auth = { uid }; next(); });
    app.use("/lang-overrides", langOverrides({ langOverrideStorer }));
  };

  beforeEach(() => {
    langOverrideStorer = { get: jest.fn() };
  });

  it("should return the caller's overridden lang keys (uppercased)", async () => {
    langOverrideStorer.get.mockResolvedValue({
      bindings: { L0175: "https://x.run.app", l0137: "https://y.run.app" }
    });
    mountWithAuth("user-1");

    const res = await request(app).get("/lang-overrides").expect(200);

    expect(langOverrideStorer.get).toHaveBeenCalledWith({ uid: "user-1" });
    expect(res.body).toMatchObject({ status: "success" });
    expect(new Set(res.body.data.langs)).toEqual(new Set(["L0175", "L0137"]));
  });

  it("should return an empty list when the user has no override doc", async () => {
    langOverrideStorer.get.mockResolvedValue(undefined);
    mountWithAuth("user-1");

    const res = await request(app).get("/lang-overrides").expect(200);
    expect(res.body.data.langs).toEqual([]);
  });

  it("should return an empty list and skip the lookup when anonymous", async () => {
    mountWithAuth(undefined);

    const res = await request(app).get("/lang-overrides").expect(200);
    expect(langOverrideStorer.get).not.toHaveBeenCalled();
    expect(res.body.data.langs).toEqual([]);
  });
});
