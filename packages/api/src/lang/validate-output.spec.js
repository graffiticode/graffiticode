import { jest } from "@jest/globals";
import { buildValidateOutput } from "./validate-output.js";

const SCHEMA_07 = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "LTest",
  type: "object",
  required: ["interaction"],
  properties: { interaction: { type: "object" } }
};

const SCHEMA_2020 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "LTest",
  type: "object",
  required: ["interaction"],
  properties: { interaction: { $ref: "#/$defs/interaction" } },
  additionalProperties: false,
  $defs: {
    interaction: {
      type: "object",
      properties: { prompt: { type: "string" } },
      additionalProperties: false
    }
  }
};

describe("validateOutput", () => {
  let getBaseUrlForLanguage;
  let getAsset;
  let log;
  let env;
  const build = (opts = {}) => buildValidateOutput({ getBaseUrlForLanguage, getAsset, env, log, ...opts });

  beforeEach(() => {
    getBaseUrlForLanguage = jest.fn().mockResolvedValue("http://localhost:50999");
    getAsset = jest.fn().mockResolvedValue(JSON.stringify(SCHEMA_2020));
    log = jest.fn();
    env = { COMPILE_SCHEMA_CHECK: "emit" };
  });

  it("should return no errors for data that matches", async () => {
    const validateOutput = build();
    const obj = { data: { interaction: { prompt: "hi" } }, errors: [] };

    await expect(validateOutput("0999", obj)).resolves.toEqual([]);
    expect(getAsset).toHaveBeenCalledWith("L0999", "/schema.json", { uid: undefined });
  });

  it("should return internal errors for data that does not match (2020-12)", async () => {
    const validateOutput = build();
    const obj = { data: { interaction: { prompt: "hi", correct: true } }, errors: [] };

    const errors = await validateOutput("0999", obj, { id: "abc" });

    expect(errors).toEqual([
      expect.objectContaining({
        internal: true,
        kind: "schema",
        lang: "L0999",
        path: "/interaction",
        from: -1,
        to: -1,
        message: expect.stringContaining("L0999 compiler output does not match its schema.json: /interaction")
      })
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("id=abc"));
  });

  it("should read draft-07 schemas", async () => {
    getAsset.mockResolvedValue(JSON.stringify(SCHEMA_07));
    const validateOutput = build();

    await expect(validateOutput("0999", { data: {} })).resolves.toHaveLength(1);
  });

  it("should not check a compile that already has errors", async () => {
    const validateOutput = build();

    await expect(validateOutput("0999", { data: {}, errors: [{ message: "x" }] })).resolves.toEqual([]);
    expect(getAsset).not.toHaveBeenCalled();
  });

  it("should not check a result with no data envelope", async () => {
    const validateOutput = build();

    await expect(validateOutput("0999", { val: "hello" })).resolves.toEqual([]);
    expect(getAsset).not.toHaveBeenCalled();
  });

  it("should skip, and remember, a language with no schema.json", async () => {
    getAsset.mockResolvedValue(null);
    const validateOutput = build();

    await expect(validateOutput("0999", { data: {} })).resolves.toEqual([]);
    await expect(validateOutput("0999", { data: {} })).resolves.toEqual([]);
    expect(getAsset).toHaveBeenCalledTimes(1);
  });

  it("should skip when the schema cannot be fetched or parsed", async () => {
    getAsset.mockRejectedValueOnce(new Error("boom"));
    await expect(build()("0999", { data: {} })).resolves.toEqual([]);

    getAsset.mockResolvedValueOnce("not json");
    await expect(build()("0999", { data: {} })).resolves.toEqual([]);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("schema check skipped"));
  });

  it("should cache the schema per base URL and refetch after the TTL", async () => {
    let t = 0;
    const validateOutput = build({ now: () => t });
    const obj = { data: { interaction: {} } };

    await validateOutput("0999", obj);
    await validateOutput("0999", obj);
    expect(getAsset).toHaveBeenCalledTimes(1);

    // A user's override resolves a different language server, with its own schema.
    getBaseUrlForLanguage.mockResolvedValueOnce("http://override:50999");
    await validateOutput("0999", obj, { uid: "u1" });
    expect(getAsset).toHaveBeenCalledTimes(2);

    t = 10 * 60 * 1000;
    await validateOutput("0999", obj);
    expect(getAsset).toHaveBeenCalledTimes(3);
  });

  it("should log but return nothing in log mode, the default", async () => {
    env = {};
    const validateOutput = build();

    await expect(validateOutput("0999", { data: {} })).resolves.toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("schema mismatch"));
  });

  it("should do nothing when off", async () => {
    env = { COMPILE_SCHEMA_CHECK: "off" };
    const validateOutput = build();

    await expect(validateOutput("0999", { data: {} })).resolves.toEqual([]);
    expect(getAsset).not.toHaveBeenCalled();
  });
});
