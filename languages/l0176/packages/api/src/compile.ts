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
  // No Learnosity credential lives in this process. Previews are signed by the
  // credential broker: through the caller's selected connection, or without
  // one through a system preview session policy issues (see protection.ts).
  // `config` passes through untouched; the core compiler reads no credentials
  // from it.
  //
  // Response envelope: success output in `data`, compile errors in `errors` (array),
  // and `cache: false` — signForRender folds a time-limited Learnosity signature into
  // `request` on every compile, so this output goes stale on a timer. The api strips
  // the directive and, seeing it, neither stores the compile nor lets the `/data`
  // response be held by the browser or the CDN. Without it a cached compile hands the
  // browser a dead token and the form renders blank.
  //
  // `effects`, when the compile made protected writes (item-bank saves), says what each
  // did, an earlier save included when a later one fails; the api gateway collects it
  // per stage and keeps it out of the next stage's input.
  return await new Promise((resolve) =>
    compiler.compile(code, data, config ?? {}, (err: any, out: any, meta?: { effects?: unknown[] }) => {
      const errors = Array.isArray(err) ? err.filter(Boolean) : err ? [err] : [];
      const effects = Array.isArray(meta?.effects) && meta.effects.length > 0 ? { effects: meta.effects } : {};
      // Under an admitted plan (W4) the gateway checks the revision that
      // answered against the one the plan pins.
      const revision = identity?.admissionToken ? { revision: process.env.K_REVISION ?? null } : {};
      if (errors.length > 0) {
        resolve({ data: null, errors, cache: false, ...effects, ...revision });
      } else {
        resolve({ data: out, errors: [], cache: false, ...effects, ...revision });
      }
    }, identity),
  );
}
