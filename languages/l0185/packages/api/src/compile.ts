// SPDX-License-Identifier: MIT
// Uses the L0185 core compiler (its Checker/Transformer extend @graffiticode/l0000).
import { compiler } from "@graffiticode/l0185";

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
  // Response envelope: success output in `data`, compile errors in `errors` (array). The
  // invocation's identity is L0000 0.6's fifth argument — never part of `config`.
  return await new Promise((resolve) =>
    compiler.compile(
      code,
      data,
      config,
      (err: any, out: any) => {
        const errors = Array.isArray(err) ? err.filter(Boolean) : err ? [err] : [];
        if (errors.length > 0) {
          resolve({ data: null, errors });
        } else {
          resolve({ data: out, errors: [] });
        }
      },
      identity,
    ),
  );
}
