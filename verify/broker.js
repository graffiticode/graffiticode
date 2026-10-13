// Candidate checks for the broker service (deploy.json services.broker.verify).
// Denial-only by design: the broker reads the policy key from KMS before it
// listens, so a ready candidate has loaded it; these prove real Google token
// verification and the callers map without registering a new caller. Allowed
// paths (execute, replay, receipts) are covered by compiled-module and
// emulator tests, not here.

import { callerDenials, protectedExecutionState } from "./lib.js";

export default async ctx => {
  await protectedExecutionState(ctx);
  await callerDenials(ctx, { path: "/v1/execute", audience: "urn:graffiticode:broker", body: {} });
};
