// SPDX-License-Identifier: MIT
// Uses the L0179 core compiler (its Checker/Transformer extend @graffiticode/l0000).
import { compiler } from "@graffiticode/l0179";

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
  // Standard compile response envelope: success output in `data`, compile errors in `errors`
  // (always an array). Deliberately no `cache: false` directive — unlike L0176, whose output
  // carries a time-limited signature, an L0179 compile is a pure function of source and data,
  // so the result stays valid and is safe for the api and the CDN to hold.
  return await new Promise((resolve) =>
    compiler.compile(code, data, config, (err: any, out: any) => {
      const errors = Array.isArray(err) ? err.filter(Boolean) : err ? [err] : [];
      resolve({ data: errors.length ? null : out, errors });
    }),
  );
}
