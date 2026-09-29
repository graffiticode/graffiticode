// SPDX-License-Identifier: MIT
// Uses the L0177 core compiler (its Checker/Transformer extend @graffiticode/l0000).
import { compiler } from "@graffiticode/l0177";

export async function compile({
  code,
  data,
  config,
}: {
  code?: any;
  data?: any;
  config?: any;
  [k: string]: any;
}) {
  if (!code || !data) {
    throw new Error("Missing required parameters: code and data");
  }
  // No Learnosity credentials are injected here. L0177 is an oracle: it emits a
  // developer recipe, it never signs or sends a Learnosity request, so this process
  // has no use for a consumer key or secret. The caller's own integration signs
  // server-side with their credentials, as the recipe instructs.
  //
  // Response envelope: success output in `data`, compile errors in `errors` (array).
  return await new Promise((resolve) =>
    compiler.compile(code, data, config, (err: any, out: any) => {
      const errors = Array.isArray(err) ? err.filter(Boolean) : err ? [err] : [];
      if (errors.length > 0) {
        resolve({ data: null, errors });
      } else {
        resolve({ data: out, errors: [] });
      }
    }),
  );
}
