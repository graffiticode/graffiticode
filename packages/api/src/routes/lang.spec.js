import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { buildLangRouter } from "./lang.js";

describe.each([
  ["L<number>", (l, p) => `/L${l}${p}`],
  ["l<number>", (l, p) => `/l${l}${p}`],
  ["/lang?id=<number>", (l, p) => `/lang${p}?id=${l}`]
])("lang router: %s", (name, getPath) => {
  let app;
  let pingLang;
  let getLangAsset;
  beforeEach(() => {
    pingLang = jest.fn();
    getLangAsset = jest.fn();
    const langRouter = buildLangRouter({ pingLang, getLangAsset });
    app = express();
    app.use("/lang", langRouter);
    app.use("/L*", langRouter);
    app.use((err, req, res, next) => {
      console.log(err.stack);
      res.sendStatus(500);
    });
  });

  it("should return languages asset", async () => {
    // Arrange
    pingLang.mockResolvedValue(true);
    getLangAsset.mockResolvedValue("asset");

    // Act
    const res = await request(app)
      .get(getPath(42, "/thing"))
      .expect(200);

    // Assert
    expect(pingLang).toHaveBeenCalledWith("L42");
    expect(res.text).toBe("asset");
  });

  it("should return 400 if invalid lang id", async () => {
    // Arrange

    // Act
    await request(app)
      .get(getPath("ab", "/thing"))
      .expect(400);

    // Assert
  });

  it("should return 400 if lang id is NaN", async () => {
    // Arrange

    // Act
    await request(app)
      .get(getPath("NaN", ""))
      .expect(400);

    // Assert
  });

  it("should return 404 is if ping fails", async () => {
    // Arrange
    pingLang.mockResolvedValue(false);

    // Act
    await request(app)
      .get(getPath(42, "/thing"))
      .expect(404);

    // Assert
    expect(pingLang).toHaveBeenCalledWith("L42");
  });
});
