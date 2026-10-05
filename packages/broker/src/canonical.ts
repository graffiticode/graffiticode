// The args digest binds an execution token to one request. Both sides — the
// compiler that asks policy to mint, and the broker that executes — must
// compute it the same way: SHA-256 over canonical JSON, defined once in
// @graffiticode/common/canonical with the shared vectors that pin it.

import { canonicalJSON, canonicalDigest } from "@graffiticode/common/canonical";

export { canonicalJSON };
export const argsDigest = canonicalDigest;
