// POST /preview/sign through the interpreter (C6 part 2, decision 4), with a fake
// compile and a fake interpreter: no emulator, no language server.
import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { buildModelCache } from "../model-cache.js";
import buildPreviewRoute, { INIT_DATA_CODE, buildInterpretedSign, previewSignBodyParser } from "./preview.js";

const ACTIVITY = { type: "questions", data: { id: "graffiticode-0123456789abcdef", questions: [{ type: "mcq", response_id: "r1" }] } };
const SIGNED = { consumer_key: "k", signature: "$02$x", questions: [] };

/** @param {any} [opts] */
const setup = ({ on = true, interpretReply = undefined, modelReply = undefined, compileReply = undefined, modelCache = buildModelCache() } = {}) => {
  const compile = /** @type {any} */ (jest.fn(async () => compileReply ?? { data: SIGNED, errors: [], cache: false }));
  /** @type {any} */
  const interpreter = {
    model: jest.fn(async ({ lang, code }) => modelReply ?? ({
      model: { lang, kind: "plan", digest: "d1", program: code }, errors: [], revision: "r1",
    })),
    interpret: jest.fn(async () => interpretReply ?? { data: SIGNED, errors: [], cache: false, revision: "r1" }),
  };
  const app = express();
  app.use("/preview/sign", previewSignBodyParser);
  app.use("/preview", buildPreviewRoute({
    compile,
    interpreter,
    modelCache,
    getInterpreterLanguages: () => new Set(on ? ["0176"] : []),
    getLanguageGenerations: () => ({ "0176": "interp-1" }),
  }));
  const sign = (activity = ACTIVITY) => request(app).post("/preview/sign").send({ activity });
  return { app, compile, interpreter, sign };
};

describe("POST /preview/sign", () => {
  it("compiles init data {} as today with INTERPRETER_L0176 off", async () => {
    const t = setup({ on: false });
    const res = await t.sign();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ request: SIGNED });
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    expect(t.compile.mock.calls[0][0]).toMatchObject({ lang: "0176", code: INIT_DATA_CODE, data: ACTIVITY, auth: null, uid: null });
    expect(t.interpreter.model).not.toHaveBeenCalled();
  });

  it("interprets init data {}'s model in present, with the activity as its input and no user, with the flag on", async () => {
    const t = setup();
    const res = await t.sign();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ request: SIGNED });
    expect(res.headers["cache-control"]).toMatch(/no-store/);
    expect(t.compile).not.toHaveBeenCalled();
    expect(t.interpreter.model.mock.calls[0][0]).toMatchObject({ lang: "0176", code: INIT_DATA_CODE, auth: null, uid: null });
    expect(t.interpreter.interpret.mock.calls[0][0]).toMatchObject({ lang: "0176", input: ACTIVITY, mode: "present", auth: null, uid: null });
    // A request or signing note the activity arrived with never reaches the signer.
    await t.sign({ ...ACTIVITY, request: { stale: true }, signing: { unsigned: "x" } });
    expect(t.interpreter.interpret.mock.calls[1][0].input).toEqual(ACTIVITY);
  });

  it("compiles the model once, from the model cache after that, and drops it when another revision answers", async () => {
    const t = setup();
    await t.sign();
    await t.sign();
    expect(t.interpreter.model).toHaveBeenCalledTimes(1);
    t.interpreter.interpret.mockResolvedValueOnce({ data: SIGNED, errors: [], cache: false, revision: "r2" });
    await t.sign();
    await t.sign();
    expect(t.interpreter.model).toHaveBeenCalledTimes(2);
  });

  it("answers an unsigned preview, compile errors and a lost answer as a compile's", async () => {
    const unsigned = setup({ interpretReply: { data: { ...ACTIVITY, signing: { unsigned: "busy", message: "Previews are busy" } }, errors: [], cache: false, revision: "r1" } });
    const res = await unsigned.sign();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ signing: { unsigned: "busy", message: "Previews are busy" } });

    const errors = setup({ interpretReply: { data: null, errors: [{ message: "Error: init: bad" }], cache: false, revision: "r1" } });
    expect((await errors.sign()).status).toBe(422);

    const lost = setup({ interpretReply: { responseLost: true } });
    expect((await lost.sign()).status).toBe(502);
    const lostModel = setup({ modelReply: { responseLost: true } });
    expect((await lostModel.sign()).status).toBe(502);
    expect(lostModel.interpreter.interpret).not.toHaveBeenCalled();
  });

  it("keeps the api's stage metadata out of what it maps", async () => {
    const sign = buildInterpretedSign({
      interpreter: {
        model: async () => ({ model: { lang: "0176", kind: "plan", digest: "d1" }, errors: [], revision: "r1" }),
        interpret: async () => ({ data: SIGNED, errors: [], cache: false, revision: "r1" }),
      },
      getLanguageGenerations: () => ({}),
    });
    await expect(sign(ACTIVITY)).resolves.toEqual({ data: SIGNED, errors: [] });
  });
});
