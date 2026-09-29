// SPDX-License-Identifier: MIT
import { Compiler, Checker, Transformer, Renderer } from "@graffiticode/l0000";

// L0000 is the root language: the server compiles with the base Checker/Transformer
// directly (no subclassing). Child language servers construct their Compiler with their
// own subclasses instead.
const compiler = new Compiler({
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
  return await new Promise((resolve) =>
    compiler.compile(code, data, config, (err: any, out: any) => {
      const errors = Array.isArray(err) ? err.filter(Boolean) : err ? [err] : [];
      if (errors.length > 0) {
        resolve({ data: null, errors });
      } else {
        resolve({ data: out, errors: [] });
      }
    }, identity),
  );
}
