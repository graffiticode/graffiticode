import { jest } from "@jest/globals";
import { buildGetBaseUrlForLanguage } from "./base-url.js";
import { isNonEmptyString } from "../util.js";

describe("baseUrl", () => {
  it("should throw if lang is not a string", async () => {
    // Arrange
    const getLanguageBaseUrl = buildGetBaseUrlForLanguage({ isNonEmptyString });

    // Act
    await expect(getLanguageBaseUrl()).rejects.toThrow(new Error("lang must be a non empty string"));

    // Assert
  });

  it("should return default when no config or env", async () => {
    // Arrange
    const env = {};
    const config = { protocol: "https" };
    const getConfig = jest.fn().mockReturnValue(config);
    const getCompilerHost = jest.fn().mockReturnValue("ltest.artcompiler.com");
    const getCompilerPort = jest.fn().mockReturnValue("443");
    const getLanguageBaseUrl = buildGetBaseUrlForLanguage({
      isNonEmptyString,
      env,
      getConfig,
      getCompilerHost,
      getCompilerPort
    });
    const lang = "LTest";

    // Act
    const baseUrl = await getLanguageBaseUrl(lang);

    // Assert
    expect(baseUrl).toBe("https://ltest.artcompiler.com:443");
  });

  it("should return env override", async () => {
    // Arrange
    const envBaseUrl = "http://localhost:5000";
    const env = { BASE_URL_L1: envBaseUrl };
    const getLanguageBaseUrl = buildGetBaseUrlForLanguage({ isNonEmptyString, env });
    const lang = "L1";

    // Act
    const baseUrl = await getLanguageBaseUrl(lang);

    // Assert
    expect(baseUrl).toBe(envBaseUrl);
  });

  it("should return configured compiler values", async () => {
    // Arrange
    const env = {};
    const config = { protocol: "http" };
    const getConfig = jest.fn().mockReturnValue(config);
    const getCompilerHost = jest.fn().mockReturnValue("localhost");
    const getCompilerPort = jest.fn().mockReturnValue("5000");
    const getLanguageBaseUrl = buildGetBaseUrlForLanguage({
      isNonEmptyString,
      env,
      getConfig,
      getCompilerHost,
      getCompilerPort
    });
    const lang = "LTest";

    // Act
    const baseUrl = await getLanguageBaseUrl(lang);

    // Assert
    expect(getCompilerHost).toHaveBeenCalledWith(lang, config);
    expect(getCompilerPort).toHaveBeenCalledWith(lang, config);
    expect(baseUrl).toBe("http://localhost:5000");
  });

  it("should use http if LOCAL_COMPILES is true", async () => {
    // Arrange
    const env = { LOCAL_COMPILES: "true" };
    const config = { protocol: "https" };
    const getConfig = jest.fn().mockReturnValue(config);
    const getCompilerHost = jest.fn().mockReturnValue("localhost");
    const getCompilerPort = jest.fn().mockReturnValue("5000");
    const getLanguageBaseUrl = buildGetBaseUrlForLanguage({
      isNonEmptyString,
      env,
      getConfig,
      getCompilerHost,
      getCompilerPort
    });
    const lang = "LTest";

    // Act
    const baseUrl = await getLanguageBaseUrl(lang);

    // Assert
    expect(getCompilerHost).toHaveBeenCalledWith(lang, config);
    expect(getCompilerPort).toHaveBeenCalledWith(lang, config);
    expect(baseUrl).toBe("http://localhost:5000");
  });

  it("should prefix is L if lang is only a number", async () => {
    // Arrange
    const envBaseUrl = "http://localhost:5000";
    const env = { BASE_URL_L1: envBaseUrl };
    const getLanguageBaseUrl = buildGetBaseUrlForLanguage({ isNonEmptyString, env });
    const lang = "1";

    // Act
    const baseUrl = await getLanguageBaseUrl(lang);

    // Assert
    expect(baseUrl).toBe(envBaseUrl);
  });

  it("should return per-user override when present, ahead of env and config", async () => {
    // Arrange
    const overrideBaseUrl = "https://test42---l0175-656973052505.us-central1.run.app";
    const env = { BASE_URL_L175: "http://should-not-win:5000" };
    const getConfig = jest.fn().mockReturnValue({});
    const getCompilerHost = jest.fn().mockReturnValue("l175.graffiticode.org");
    const getCompilerPort = jest.fn().mockReturnValue("443");
    const getOverrideBaseUrl = jest.fn().mockResolvedValue(overrideBaseUrl);
    const getLanguageBaseUrl = buildGetBaseUrlForLanguage({
      isNonEmptyString,
      env,
      getConfig,
      getCompilerHost,
      getCompilerPort,
      getOverrideBaseUrl
    });
    const lang = "L175";

    // Act
    const baseUrl = await getLanguageBaseUrl(lang, { uid: "user-1" });

    // Assert
    expect(getOverrideBaseUrl).toHaveBeenCalledWith({ uid: "user-1", lang });
    expect(baseUrl).toBe(overrideBaseUrl);
  });

  it("should fall back to default when override is absent", async () => {
    // Arrange
    const env = {};
    const getConfig = jest.fn().mockReturnValue({});
    const getCompilerHost = jest.fn().mockReturnValue("l175.graffiticode.org");
    const getCompilerPort = jest.fn().mockReturnValue("443");
    const getOverrideBaseUrl = jest.fn().mockResolvedValue(undefined);
    const getLanguageBaseUrl = buildGetBaseUrlForLanguage({
      isNonEmptyString,
      env,
      getConfig,
      getCompilerHost,
      getCompilerPort,
      getOverrideBaseUrl
    });
    const lang = "L175";

    // Act
    const baseUrl = await getLanguageBaseUrl(lang, { uid: "user-1" });

    // Assert
    expect(getOverrideBaseUrl).toHaveBeenCalledWith({ uid: "user-1", lang });
    expect(baseUrl).toBe("https://l175.graffiticode.org:443");
  });

  it("should never look up an override when uid is absent", async () => {
    // Arrange
    const env = {};
    const getConfig = jest.fn().mockReturnValue({});
    const getCompilerHost = jest.fn().mockReturnValue("l175.graffiticode.org");
    const getCompilerPort = jest.fn().mockReturnValue("443");
    const getOverrideBaseUrl = jest.fn().mockResolvedValue("https://should-not-be-used");
    const getLanguageBaseUrl = buildGetBaseUrlForLanguage({
      isNonEmptyString,
      env,
      getConfig,
      getCompilerHost,
      getCompilerPort,
      getOverrideBaseUrl
    });
    const lang = "L175";

    // Act
    const baseUrl = await getLanguageBaseUrl(lang);

    // Assert
    expect(getOverrideBaseUrl).not.toHaveBeenCalled();
    expect(baseUrl).toBe("https://l175.graffiticode.org:443");
  });
});
