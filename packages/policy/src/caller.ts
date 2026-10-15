// Moved to @graffiticode/common/caller so the auth service can check callers
// the same way; re-exported here for existing importers.
export { createCallerIdentity, buildGoogleIdTokenVerifier } from "@graffiticode/common/caller";
