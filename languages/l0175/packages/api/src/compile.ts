// SPDX-License-Identifier: MIT
// Uses the L0175 core compiler (its Checker/Transformer extend @graffiticode/l0000).
import { compiler } from "@graffiticode/l0175";

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
