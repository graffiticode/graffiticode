import { jest } from "@jest/globals";
import { buildCompile, buildInterpreter } from "./comp.js";
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

    it("should forward the invocation token and stage beside the connection", async () => {
      langCompile.mockResolvedValue(DATA1);

      await compile({ ...TASK1, connectionId: "conn-1", invocationToken: "i.n.v", stage: "s1" });

      expect(langCompile).toHaveBeenCalledWith(
        `L${TASK1.lang}`,
        { code: TASK1.code, data: {}, auth: null, options: {}, connectionId: "conn-1", invocationToken: "i.n.v", stage: "s1" },
        { uid: null }
      );
    });

    it("should call langCompile", async () => {
      langCompile.mockResolvedValue(DATA1);

      await expect(compile({ ...TASK1 })).resolves.toBe(DATA1);

      expect(langCompile).toHaveBeenCalledWith(`L${TASK1.lang}`, { code: TASK1.code, data: {}, auth: null, options: {} }, { uid: null });
    });
  });

  describe("interpreter (plan B3)", () => {
    it("asks for the model, then interprets it, each with the compile's token, options and identity", async () => {
      const langCompile = /** @type {any} */ (jest.fn()).mockResolvedValue({});
      const callerIdentity = /** @type {any} */ (jest.fn()).mockResolvedValue({ "X-Caller-Identity": "id" });
      const interpreter = buildInterpreter({ langCompile, callerIdentity });
      await interpreter.model({ lang: "0184", code: TASK1.code, auth: "tok", options: { o: 1 }, uid: "u1" });
      await interpreter.interpret({ lang: "0184", model: { digest: "d" }, input: { data: 1, errors: [] }, mode: "present", auth: "tok", options: { o: 1 }, uid: "u1", baseUrl: "https://pinned" });
      expect(langCompile.mock.calls).toEqual([
        ["L0184", { code: TASK1.code, data: {}, auth: "tok", options: { o: 1 }, form: "model" }, { uid: "u1", path: "/compile", headers: { "X-Caller-Identity": "id" } }],
        ["L0184", { model: { digest: "d" }, input: { data: 1, errors: [] }, mode: "present", auth: "tok", options: { o: 1 } }, { uid: "u1", path: "/interpret", baseUrl: "https://pinned", headers: { "X-Caller-Identity": "id" } }],
      ]);
    });
  });
});
