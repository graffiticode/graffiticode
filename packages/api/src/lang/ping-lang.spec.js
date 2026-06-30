import { jest } from "@jest/globals";
import { buildPingLang } from "./ping-lang.js";

describe("pingLang", () => {
  const log = jest.fn();
  it("should return true when language pongs", async () => {
    // Arrange
    const baseUrl = "http://ltest.artcompiler.com";
    const getBaseUrlForLanguage = jest.fn().mockResolvedValue(baseUrl);
    const call = jest.fn().mockResolvedValue();
    const bent = jest.fn().mockReturnValue(call);
    const pingLang = buildPingLang({ getBaseUrlForLanguage, bent, log });
    const lang = "LTest";

    // Act
    const pong = await pingLang(lang);

    // Assert
    expect(getBaseUrlForLanguage).toHaveBeenCalledWith(lang, { uid: undefined });
    expect(bent).toHaveBeenCalledWith(baseUrl, "HEAD");
    expect(call).toHaveBeenCalledWith("/");
    expect(pong).toBe(true);
  });

  it("should return false call throws", async () => {
    // Arrange
    const baseUrl = "http://ltest.artcompiler.com";
    const getBaseUrlForLanguage = jest.fn().mockResolvedValue(baseUrl);
    const call = jest.fn().mockRejectedValue(new Error("failed to ping"));
    const bent = jest.fn().mockReturnValue(call);
    const pingLang = buildPingLang({ getBaseUrlForLanguage, bent, log });
    const lang = "LTest";

    // Act
    const pong = await pingLang(lang);

    // Assert
    expect(getBaseUrlForLanguage).toHaveBeenCalledWith(lang, { uid: undefined });
    expect(bent).toHaveBeenCalledWith(baseUrl, "HEAD");
    expect(call).toHaveBeenCalledWith("/");
    expect(pong).toBe(false);
  });

  it("should cache successful ping call by base url", async () => {
    // Arrange
    const baseUrl = "http://ltest.artcompiler.com";
    const getBaseUrlForLanguage = jest.fn().mockResolvedValue(baseUrl);
    const call = jest.fn().mockResolvedValue();
    const bent = jest.fn().mockReturnValue(call);
    const pingLang = buildPingLang({ getBaseUrlForLanguage, bent, log });
    const lang = "LTest";

    // Act
    const pong1 = await pingLang(lang);
    const pong2 = await pingLang(lang);

    // Assert
    // The base url is resolved on each call, but the HEAD request is cached.
    expect(getBaseUrlForLanguage).toHaveBeenCalledTimes(2);
    expect(getBaseUrlForLanguage).toHaveBeenCalledWith(lang, { uid: undefined });
    expect(bent).toHaveBeenCalledTimes(1);
    expect(bent).toHaveBeenCalledWith(baseUrl, "HEAD");
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith("/");
    expect(pong1).toBe(true);
    expect(pong2).toBe(true);
  });

  it("should not share a cache entry across distinct base urls", async () => {
    // Arrange
    const defaultBaseUrl = "http://ltest.artcompiler.com";
    const overrideBaseUrl = "http://override.example.com";
    const getBaseUrlForLanguage = jest.fn()
      .mockResolvedValueOnce(defaultBaseUrl)
      .mockResolvedValueOnce(overrideBaseUrl);
    const call = jest.fn().mockResolvedValue();
    const bent = jest.fn().mockReturnValue(call);
    const pingLang = buildPingLang({ getBaseUrlForLanguage, bent, log });
    const lang = "LTest";

    // Act
    await pingLang(lang);
    await pingLang(lang, { uid: "tester" });

    // Assert
    // Distinct resolved base urls must each be pinged (no cache collision).
    expect(bent).toHaveBeenCalledTimes(2);
    expect(bent).toHaveBeenNthCalledWith(1, defaultBaseUrl, "HEAD");
    expect(bent).toHaveBeenNthCalledWith(2, overrideBaseUrl, "HEAD");
  });

  it("should not cache failed ping call", async () => {
    // Arrange
    const baseUrl = "http://ltest.artcompiler.com";
    const getBaseUrlForLanguage = jest.fn().mockResolvedValue(baseUrl);
    const call = jest.fn()
      .mockRejectedValueOnce(new Error("failed to ping"))
      .mockResolvedValue();
    const bent = jest.fn().mockReturnValue(call);
    const pingLang = buildPingLang({ getBaseUrlForLanguage, bent, log });
    const lang = "LTest";

    // Act
    const pong1 = await pingLang(lang);
    const pong2 = await pingLang(lang);

    // Assert
    expect(getBaseUrlForLanguage).toHaveBeenCalledTimes(2);
    expect(bent).toHaveBeenCalledTimes(2);
    expect(bent).toHaveBeenNthCalledWith(1, baseUrl, "HEAD");
    expect(bent).toHaveBeenNthCalledWith(2, baseUrl, "HEAD");
    expect(call).toHaveBeenNthCalledWith(1, "/");
    expect(call).toHaveBeenNthCalledWith(2, "/");
    expect(pong1).toBe(false);
    expect(pong2).toBe(true);
  });
});
