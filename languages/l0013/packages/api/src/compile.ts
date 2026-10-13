// SPDX-License-Identifier: MIT
// Uses the L0013 core compiler (its Checker/Transformer extend @graffiticode/l0000).
import { compiler } from "@graffiticode/l0013";

export async function compile({
  code,
  data,
  config,
  auth,
  authToken,
}: {
  code?: any;
  data?: any;
  config?: any;
  auth?: any;
  authToken?: any;
  [k: string]: any;
}) {
  if (!code || !data) {
    throw new Error("Missing required parameters: code and data");
  }
  // Thread the request's access token into config so the SNAP handler can authenticate the
  // headless render of the target task's form view (api.graffiticode.org/form?...&access_token).
  const mergedConfig = { ...(config || {}), auth, authToken };
  // Response envelope: success output in `data`, compile errors in `errors` (array).
  return await new Promise((resolve) =>
    compiler.compile(code, data, mergedConfig, (err: any, out: any) => {
      const errors = Array.isArray(err) ? err.filter(Boolean) : err ? [err] : [];
      if (errors.length > 0) {
        resolve({ data: null, errors });
      } else {
        resolve({ data: out, errors: [] });
      }
    }),
  );
}
