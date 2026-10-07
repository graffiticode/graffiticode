// SPDX-License-Identifier: MIT
import { Compiler, Checker, Transformer, Renderer } from "@graffiticode/l0000";

// L0000 is the root language: the server compiles with the base Checker/Transformer
// directly (no subclassing). Child language servers construct their Compiler with their
// own subclasses instead.
export const compiler = new Compiler({
  langID: "0000",
  version: "v0.0.1",
  Checker,
  Transformer,
  Renderer,
});

export async function compile({
  code,
  data,
  config,
  identity,
}: {
  code?: any;
  data?: any;
  config?: any;
  identity?: Record<string, any>;
  [k: string]: any;
}) {
  if (!code || !data) {
    throw new Error("Missing required parameters: code and data");
  }
  // Response envelope: successful compile output goes in `data`; compile errors go in
  // `errors` (always an array). Consumers (the View/Form) branch on `errors.length`.
  // `effects`, when the compile made protected writes, says what each did; the api
  // gateway collects it per stage and keeps it out of the next stage's input.
  return await new Promise((resolve) =>
    compiler.compile(code, data, config, (err: any, out: any, meta?: { effects?: unknown[] }) => {
      const errors = Array.isArray(err) ? err.filter(Boolean) : err ? [err] : [];
      const effects = Array.isArray(meta?.effects) && meta.effects.length > 0 ? { effects: meta.effects } : {};
      if (errors.length > 0) {
        resolve({ data: null, errors, ...effects });
      } else {
        resolve({ data: out, errors: [], ...effects });
      }
    }, identity),
  );
}
