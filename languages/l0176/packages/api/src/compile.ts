// SPDX-License-Identifier: MIT
// Uses the L0176 core compiler (its Checker/Transformer extend @graffiticode/l0000).
import { compiler } from "@graffiticode/l0176";

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
  // Inject Learnosity consumer credentials from the api process's environment
  // into `config` (which the core compiler reads as `options.config`). Secrets
  // live here, in the api process, and never at the core package's module scope.
  // A program that supplies its own `set-var "learnosity-key"/"learnosity-secret"`
  // still overrides these (see resolveCredentials in the core compiler).
  const mergedConfig = {
    ...config,
    learnosity: {
      key: process.env.LEARNOSITY_KEY,
      secret: process.env.LEARNOSITY_SECRET,
      ...(config?.learnosity ?? {}),
    },
  };
  // Response envelope: success output in `data`, compile errors in `errors` (array),
  // and `cache: false` — signForRender folds a time-limited Learnosity signature into
  // `request` on every compile, so this output goes stale on a timer. The api strips
  // the directive and, seeing it, neither stores the compile nor lets the `/data`
  // response be held by the browser or the CDN. Without it a cached compile hands the
  // browser a dead token and the form renders blank.
  return await new Promise((resolve) =>
    compiler.compile(code, data, mergedConfig, (err: any, out: any) => {
      const errors = Array.isArray(err) ? err.filter(Boolean) : err ? [err] : [];
      if (errors.length > 0) {
        resolve({ data: null, errors, cache: false });
      } else {
        resolve({ data: out, errors: [], cache: false });
      }
    }, identity),
  );
}
