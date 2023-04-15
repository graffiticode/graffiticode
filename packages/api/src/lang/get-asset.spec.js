import { jest } from "@jest/globals";
import { buildGetAsset } from "./get-asset.js";

describe("getAsset", () => {
  it("should returned fetched asset", async () => {
    // Arrange
    const baseUrl = "http://localhost:5000";
    const getBaseUrlForLanguage = jest.fn().mockReturnValue(baseUrl);
    const asset = "asset";
    const call = jest.fn().mockResolvedValue(asset);
    const bent = jest.fn().mockReturnValue(call);
    const getAsset = buildGetAsset({ getBaseUrlForLanguage, bent });
    const lang = "LTest";
    const path = "/path";

    // Act
    const actual = await getAsset(lang, path);

    // Assert
    expect(getBaseUrlForLanguage).toHaveBeenCalledWith(lang);
    expect(bent).toHaveBeenCalledWith(baseUrl, "string");
    expect(call).toHaveBeenCalledWith(path);
    expect(actual).toBe(asset);
  });

  it("should throw error is fails to get asset", async () => {
    // Arrange
    const baseUrl = "http://localhost:5000";
    const getBaseUrlForLanguage = jest.fn().mockReturnValue(baseUrl);
    const call = jest.fn().mockRejectedValue(new Error("failed to get asset"));
    const bent = jest.fn().mockReturnValue(call);
    const getAsset = buildGetAsset({ getBaseUrlForLanguage, bent });
    const lang = "LTest";
    const path = "/path";

    // Act
    await expect(getAsset(lang, path)).rejects.toThrow("failed to get asset");

    // Assert
    expect(getBaseUrlForLanguage).toHaveBeenCalledWith(lang);
    expect(bent).toHaveBeenCalledWith(baseUrl, "string");
    expect(call).toHaveBeenCalledWith(path);
  });
});
