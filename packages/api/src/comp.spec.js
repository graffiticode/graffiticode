import { jest } from "@jest/globals";
import { buildCompile } from "./comp.js";
import { DATA1, TASK1 } from "./testing/fixture.js";

describe("comp", () => {
  describe("compile", () => {
    let langCompile;
    let compile;
    beforeEach(() => {
      langCompile = jest.fn();
      compile = buildCompile({ langCompile });
    });

    it("should call langCompile", async () => {
      langCompile.mockResolvedValue(DATA1);

      await expect(compile({ ...TASK1 })).resolves.toBe(DATA1);

      expect(langCompile).toHaveBeenCalledWith(`L${TASK1.lang}`, { code: TASK1.code, data: {}, auth: null, options: {} });
    });
  });
});
