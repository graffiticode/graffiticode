// SPDX-License-Identifier: MIT
//
// Admission of protected functions: the checker-side half of delegated API
// permissions. A protected function is one whose evaluation exercises an
// external API through a connection (see docs/graffiticode_capability_policy_spec.md
// in the console repo). The broker enforces authority at the call; this pass
// gives early rejection so the transformer never begins a program it would have
// to abandon halfway, after earlier external calls had already happened.
//
// Coverage for EXPLICIT calls comes from scanning every node in the pool by
// tag, not from walking the tree through checker methods. The parser lowers
// every call of a lexicon function — top level, parenthesized, under a branch,
// inside a lambda, bound by `let` — to a node carrying that function's tag, so
// no language's Checker override can skip one. It is conservative: a protected
// call in dead code is still admitted or refused.
//
// The tag scan does NOT cover protected behavior the transformer performs
// without a protected node in the source: implicit operations (e.g. L0176
// signing every render in PROG) and any call a transformer constructs at run
// time. A language must declare those as `implicitProtectedFunctions`, which
// are admitted for every compile of that language, and must never synthesize a
// protected node the pool did not contain.

import type { ExecContext, Invoker } from "./exec-context.js";

export type ProtectedFunctionKind = "read" | "write" | "sign";

export interface ProtectedFunctionSpec {
  // The permission key: the stable function name a grant names.
  fn: string;
  kind: ProtectedFunctionKind;
}

// Keyed by node tag (the lexicon entry's `name`).
export type ProtectedFunctions = Record<string, ProtectedFunctionSpec>;

export interface PolicySnapshot {
  // Function names this invocation may call through its connection.
  allowed: string[];
}

// A snapshot is accepted only if it is exactly well-formed. Anything else —
// a non-array, a single non-string entry — is malformed, and a malformed
// snapshot allows nothing: partially honoring it would let a corrupted or
// mismatched response grant whatever valid-looking strings it happens to hold.
export function parseSnapshot(snapshot: unknown): PolicySnapshot | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }
  const allowed = (snapshot as any).allowed;
  if (!Array.isArray(allowed) || !allowed.every((f) => typeof f === "string" && f.length > 0)) {
    return null;
  }
  return { allowed: [...allowed] };
}

export interface PolicyClient {
  getSnapshot(args: { exec: ExecContext; langID: string; fns: string[] }): Promise<PolicySnapshot>;
  // Performs one admitted protected call (mint, then broker). Optional: a
  // client without it admits but cannot execute.
  invoke?: Invoker;
}

export interface AdmissionError {
  message: string;
  from: number;
  to: number;
}

function errorAt(message: string, node: any): AdmissionError {
  return { message, from: node?.coord?.from ?? -1, to: node?.coord?.to ?? -1 };
}

export function findProtectedNodes(nodePool: any, protectedFunctions: ProtectedFunctions) {
  const found: { node: any; spec: ProtectedFunctionSpec }[] = [];
  if (!nodePool || !protectedFunctions) {
    return found;
  }
  for (const key of Object.keys(nodePool)) {
    if (key === "root") continue;
    const node = nodePool[key];
    const tag = node?.tag;
    if (typeof tag === "string" && Object.prototype.hasOwnProperty.call(protectedFunctions, tag)) {
      found.push({ node, spec: protectedFunctions[tag] });
    }
  }
  return found;
}

// Decides every protected node before transformation: a function missing
// from the policy snapshot is an error, so the transformer never begins.
// There are no execution modes: running the program is the action, and a
// granted function (a write included) runs whenever the program calls it.
// The snapshot is fetched once, only when protected nodes exist, and fails
// closed: no policy client, a failed fetch, or a malformed response means
// nothing is allowed.
export async function admitProtectedFunctions({
  nodePool,
  protectedFunctions,
  implicitProtectedFunctions = [],
  exec,
  langID,
  policy,
}: {
  nodePool: any;
  protectedFunctions: ProtectedFunctions;
  implicitProtectedFunctions?: ProtectedFunctionSpec[];
  exec: ExecContext;
  langID: string;
  policy?: PolicyClient;
}): Promise<AdmissionError[]> {
  // Implicit operations have no node; they are required by every compile.
  const found: { node: any; spec: ProtectedFunctionSpec }[] = [
    ...implicitProtectedFunctions.map((spec) => ({ node: null, spec })),
    ...findProtectedNodes(nodePool, protectedFunctions),
  ];
  if (found.length === 0) {
    return [];
  }
  for (const { node, spec } of found) {
    // A write must be visible in the program: an implicit one would run on
    // every compile without the program ever asking for it.
    if (!node && spec.kind === "write") {
      return [errorAt(`Implicit protected function ${spec.fn} cannot be a write.`, null)];
    }
  }
  // One snapshot per compile, covering every protected function present.
  let snapshot: PolicySnapshot = { allowed: [] };
  // A view of a published item has no user: it carries the publication's
  // invocation token instead, and policy confines it to viewSafe functions.
  const hasPrincipal = Boolean(exec.uid || exec.policyCredentials().invocationToken);
  if (policy && exec.connectionId && hasPrincipal) {
    const fns = [...new Set(found.map(({ spec }) => spec.fn))];
    let response: unknown;
    try {
      response = await policy.getSnapshot({ exec, langID, fns });
    } catch {
      return [errorAt("Permission check is unavailable; protected functions cannot run.", null)];
    }
    snapshot = parseSnapshot(response) ?? { allowed: [] };
    if (typeof policy.invoke === "function") {
      exec.bindInvoker(policy.invoke);
    }
  }
  exec.setSnapshot(Object.freeze({ allowed: Object.freeze([...snapshot.allowed]) }));
  const allowed = new Set(snapshot.allowed);
  const errors: AdmissionError[] = [];
  for (const { node, spec } of found) {
    if (!allowed.has(spec.fn)) {
      errors.push(
        errorAt(
          exec.connectionId
            ? `${spec.fn} is not permitted through the selected connection.`
            : `${spec.fn} requires a connection that permits it.`,
          node,
        ),
      );
    }
  }
  return errors;
}
