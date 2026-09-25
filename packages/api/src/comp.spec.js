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

    it("should forward connectionId at the top level, not in options", async () => {
      langCompile.mockResolvedValue(DATA1);

      await compile({ ...TASK1, connectionId: "conn-1" });

      expect(langCompile).toHaveBeenCalledWith(
        `L${TASK1.lang}`,
        { code: TASK1.code, data: {}, auth: null, options: {}, connectionId: "conn-1" },
        { uid: null }
      );
    });

    it("should forward an intent token beside the connection", async () => {
      langCompile.mockResolvedValue(DATA1);

      await compile({ ...TASK1, connectionId: "conn-1", intentToken: "a.b.c" });

      expect(langCompile).toHaveBeenCalledWith(
        `L${TASK1.lang}`,
        { code: TASK1.code, data: {}, auth: null, options: {}, connectionId: "conn-1", intentToken: "a.b.c" },
        { uid: null }
      );
    });

    it("should call langCompile", async () => {
      langCompile.mockResolvedValue(DATA1);

      await expect(compile({ ...TASK1 })).resolves.toBe(DATA1);

      expect(langCompile).toHaveBeenCalledWith(`L${TASK1.lang}`, { code: TASK1.code, data: {}, auth: null, options: {} }, { uid: null });
    });
  });
});
