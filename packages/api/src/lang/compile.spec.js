import { jest } from "@jest/globals";
import { buildCompile } from "./compile.js";

describe("compile", () => {
  it("should return language response", async () => {
    // Arrange
    const baseUrl = "http://ltest.artcompiler.com";
    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
    const getBaseUrlForLanguage = jest.fn().mockResolvedValue(baseUrl);
    const res = "response";
    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
    const call = jest.fn().mockResolvedValue(res);
    const bent = jest.fn().mockReturnValue(call);
    const compile = buildCompile({ getBaseUrlForLanguage, bent });
    const lang = "LTest";
    const req = "request";

    // Act
    const actual = await compile(lang, req);

    // Assert
    expect(getBaseUrlForLanguage).toHaveBeenCalledWith(lang, { uid: undefined });
    expect(bent).toHaveBeenCalledWith(baseUrl, "POST", "json", 200, 202);
    expect(call).toHaveBeenCalledWith("/compile", req);
    expect(actual).toBe(res);
  });

  it.skip("should throw error if call throws", async () => {
    // Arrange
    const baseUrl = "http://ltest.artcompiler.com";
    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
    const getBaseUrlForLanguage = jest.fn().mockResolvedValue(baseUrl);
    // @ts-expect-error TS-MIGRATE: test double or fixture does not match the type checkJs infers for the real dependency
    const call = jest.fn().mockRejectedValue(new Error("failed to compile"));
    const bent = jest.fn().mockReturnValue(call);
    const compile = buildCompile({ getBaseUrlForLanguage, bent });
    const lang = "LTest";
    const req = "request";

    // Act
    await expect(compile(lang, req)).rejects.toThrow("failed to compile");

    // Assert
    expect(getBaseUrlForLanguage).toHaveBeenCalledWith(lang, { uid: undefined });
    expect(bent).toHaveBeenCalledWith(baseUrl, "POST", "json", 200, 202);
    expect(call).toHaveBeenCalledWith("/compile", req);
  });

  const reset = () => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const setup = call => {
    const getBaseUrlForLanguage = /** @type {any} */ (jest.fn()).mockResolvedValue("https://l0184.example");
    const bent = jest.fn().mockReturnValue(call);
    return buildCompile({ getBaseUrlForLanguage, bent });
  };

  it("sends a call with no effects once more after a connection reset", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const call = /** @type {any} */ (jest.fn()).mockRejectedValueOnce(reset()).mockResolvedValueOnce({ data: 1, errors: [] });
    const compile = setup(call);
    await expect(compile("L0184", { model: {} }, { path: "/interpret", retryReset: true })).resolves.toEqual({ data: 1, errors: [] });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("retries a reset only once, and reports the answer lost", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const call = /** @type {any} */ (jest.fn()).mockRejectedValue(reset());
    const result = await setup(call)("L0184", { model: {} }, { path: "/interpret", retryReset: true });
    expect(result.responseLost).toBe(true);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("never retries a call that may act, or an error that isn't a reset", async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    const call = /** @type {any} */ (jest.fn()).mockRejectedValue(reset());
    expect((await setup(call)("L0176", { code: {} })).responseLost).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    const other = /** @type {any} */ (jest.fn()).mockRejectedValue(Object.assign(new Error("boom"), { statusCode: 500 }));
    expect((await setup(other)("L0184", { model: {} }, { path: "/interpret", retryReset: true })).responseLost).toBe(true);
    expect(other).toHaveBeenCalledTimes(1);
  });
});
