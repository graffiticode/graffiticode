// SPDX-License-Identifier: MIT
// L0176 under chain admission (capability plan W4, PR 5): preflight reports
// what a compile through a connection would run (its protected functions,
// implicit `init` included, after the legacy save lowering), and a planned
// compile runs only on a binding that matches it.
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { parser } from "@graffiticode/parser";
import { digestOf } from "@graffiticode/l0000";
import { compiler, lexicon, REGISTRY_VERSION } from "./index.js";

const ITEM = "item [questions [mcq []] {}]";
const parse = (src: string) => parser.parse(176, src, lexicon);
const ENV = { K_REVISION: "l0176-rtest", GC_IMAGE_DIGEST: `sha256:${"3".repeat(64)}` };
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("L0176 preflight", () => {
  test("names its protected functions, implicit init included, with registry version 6", async () => {
    const code = await parse(`set-var "lrn-id" "t" save-to-itembank items [${ITEM}] {}..`);
    const out: any = await (compiler as any).preflight(code, { stage: "s1", options: {} });
    expect(out.manifest).toMatchObject({
      stage: "s1", lang: "0176", registryVersion: REGISTRY_VERSION, revision: ENV.K_REVISION, imageDigest: ENV.GC_IMAGE_DIGEST,
      requiredFunctions: ["init", "save-to-itembank"], sourceDigest: digestOf(code),
    });
    expect(REGISTRY_VERSION).toBe(6);
  });

  test("pins the lowered program for the legacy save member form, and still finds its save", async () => {
    const code = await parse(`set-var "lrn-id" "t" items [save-to-itembank true, ${ITEM}] {}..`);
    const out: any = await (compiler as any).preflight(code, { stage: "s0", options: {} });
    expect(out.manifest.requiredFunctions).toEqual(["init", "save-to-itembank"]);
    expect(out.manifest.sourceDigest).toBe(digestOf(code));
    expect(out.manifest.programDigest).not.toBe(out.manifest.sourceDigest);
  });

  test("a program that only previews requires init alone", async () => {
    const out: any = await (compiler as any).preflight(await parse(`set-var "lrn-id" "t" items [${ITEM}] {}..`), { stage: "s0" });
    expect(out.manifest.requiredFunctions).toEqual(["init"]);
  });
});

describe("a planned compile through a connection", () => {
  const planned = { uid: "u1", connectionId: "conn-1", userToken: "user", invocationToken: "inv", stage: "s1", admissionToken: "adm" };
  const run = (code: any) => new Promise<{ err: any[]; val: any }>(resolve =>
    compiler.compile(code, {}, {}, (err: any, val: any) => resolve({ err: Array.isArray(err) ? err.filter(Boolean) : [], val }), planned));

  test("runs on a matching binding, and refuses before any protected call on another", async () => {
    const code = await parse(`set-var "lrn-id" "t" items [${ITEM}] {}..`);
    const { manifest } = await (compiler as any).preflight(code, { stage: "s1", options: {} });
    const { stage: _s, registryVersion: _r, ...bind } = manifest;
    const invoked: any[] = [];
    let reply = bind;
    (compiler as any).setPolicyClient({
      getSnapshot: async (args: any) => {
        args.exec.setSessionToken("session");
        return { allowed: ["init"], bind: reply };
      },
      invoke: async (_exec: any, call: any) => {
        invoked.push(call);
        return { status: "succeeded", result: { request: "signed" } };
      },
    });
    const ok = await run(code);
    expect(ok.err).toEqual([]);
    expect(invoked.map(c => c.fn)).toEqual(["init"]);
    invoked.length = 0;
    reply = { ...bind, programDigest: "f".repeat(64) };
    const refused = await run(code);
    expect(refused.err[0].message).toMatch(/not the one the admitted plan pins/);
    expect(invoked).toEqual([]);
  });
});
