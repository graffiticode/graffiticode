// STATUS: this manifest is the policy contract. Nothing enforces it in
// production yet — enforcement arrives with the policy service, the broker, and
// L0176 registering these functions with its compiler.
//
// The authoritative registry of protected functions: compiler functions that
// exercise an external API through an owner's connection, and the broker
// operations each one may be issued. Policy (minting) and the broker
// (execution) consult ONLY this manifest. A compiler may publish metadata for
// display, but neither a compiler nor a per-user language override defines what
// authority it receives. Changes here are security changes: review them as
// such and bump REGISTRY_VERSION.
//
// Shape: lang -> fn -> spec. A function is named for the language function
// it guards (the lexicon name of its node tag: `init`, `save-to-itembank`,
// `author`), so permissions, grants and audit records read like the program.
//   backend    connection backend the function runs against
//   kind       read | write | sign
//   ops        broker operations a token for this fn may name — nothing else
//   tags       compiler node tags whose presence in a program requires the fn
//   implicit   required by every compile of the language (no source node)
//   delegable  whether an owner may grant it to another account
//   viewSafe   whether a view of a published item may use it (the viewer holds
//              no grant; the publication's authority reaches only these)
//   requiresEnablement
//              disabled until verified (spec AUTHOR-01): Policy and Broker each
//              refuse it unless their deployment explicitly enables it
//              (POLICY_ENABLED_GATED_FUNCTIONS / BROKER_ENABLED_GATED_OPERATIONS).
//              Owner permissions cannot bypass it.

// There are no execution modes: running the program is the action, and the
// grant is the authority. A function runs whenever its program calls it
// through a connection whose grant covers it.
// v6 (unreleased): Author gated behind explicit enablement (AUTHOR-01), and the
// registered execution-step table (OPERATIONS[op].steps) that W2's live
// authorization checks each Broker step against (spec API-02).
export const REGISTRY_VERSION = 6;

// What a step of an operation does:
//   dispatch  one provider request
//   sign      one local signature issuance (no provider request)
//   replay    returning an operation's recorded receipt instead of executing
export type StepPurpose = "dispatch" | "sign" | "replay";
export type OperationStep = Readonly<{ id: string; purpose: StepPurpose }>;

// One protected function's entry (see the field notes above).
export type FunctionSpec = Readonly<{
  backend: string;
  kind: "read" | "write" | "sign";
  ops: readonly string[];
  tags: readonly string[];
  implicit: boolean;
  delegable: boolean;
  viewSafe: boolean;
  requiresEnablement?: boolean;
}>;

// Broker operations. The broker builds each request itself from a constrained
// payload; none is a general signer or proxy.
//   steps  the registered execution steps, in order: the identifiers Broker
//          derives from the operation definition (never from a request) and
//          asks Policy to authorize one at a time (W2, spec API-02). An
//          operation may stop before its last dispatch step (write-items skips
//          `items` when there are none); it may never take a step not listed
//          here, or take them out of order.
const step = (id: string, purpose: StepPurpose): OperationStep => Object.freeze({ id, purpose });
const SIGN_STEPS = Object.freeze([step("sign", "sign")]);

export const OPERATIONS = Object.freeze({
  // Items API and inline Questions API previews: the two rendering APIs L0176
  // uses for ordinary previews (packages/core/src/items.ts, questions.ts).
  "learnosity.sign-items-preview": Object.freeze({ backend: "learnosity", kind: "sign", steps: SIGN_STEPS }),
  "learnosity.sign-questions-preview": Object.freeze({ backend: "learnosity", kind: "sign", steps: SIGN_STEPS }),
  // Author API signing. Its config carries edit and delete permissions
  // (packages/core/src/author.ts), so it is NOT preview authority: it is
  // non-delegable (only the connection's owner can reach it) and not viewSafe
  // (a published view never can). The broker accepts a
  // constrained payload and builds the request itself: mode fixed to
  // `item_edit`, one item `reference` (required), widget types drawn only from
  // the L0176 allowlist, and no custom widgets or caller-supplied config.
  "learnosity.sign-author": Object.freeze({ backend: "learnosity", kind: "sign", steps: SIGN_STEPS }),
  // Data API item-bank write: two sequential provider writes (questions, then
  // the items that reference them), each recorded as it completes, and a
  // receipt replay for a retry of the same operation.
  "learnosity.write-items": Object.freeze({
    backend: "learnosity",
    kind: "write",
    steps: Object.freeze([step("questions", "dispatch"), step("items", "dispatch"), step("receipt", "replay")]),
  }),
});

// The registered steps of an operation, or null for an unknown operation.
export const operationSteps = (op: unknown): readonly OperationStep[] | null =>
  Object.prototype.hasOwnProperty.call(OPERATIONS, op as string) ? OPERATIONS[op as keyof typeof OPERATIONS].steps : null;

// Is `step` a registered step of `op` with exactly this purpose? `after`, when
// given, is the step that completed just before: a dispatch step must come
// after the one listed before it (the first needs none), so steps cannot be
// skipped forward or repeated. Replay needs no predecessor.
export const isStepRegistered = ({ op, step: id, purpose, after = null }: { op: unknown; step: unknown; purpose: unknown; after?: unknown }): boolean => {
  const steps = operationSteps(op);
  if (!steps) return false;
  const index = steps.findIndex(s => s.id === id);
  if (index < 0 || steps[index].purpose !== purpose) return false;
  if (purpose !== "dispatch") return true;
  const dispatch = steps.filter(s => s.purpose === "dispatch");
  const position = dispatch.findIndex(s => s.id === id);
  return position === 0 ? after === null : after === dispatch[position - 1].id;
};

export const PROTECTED_FUNCTIONS = Object.freeze({
  "0176": Object.freeze({
    // Every L0176 render is signed in PROG (signForRender), and `init` signs
    // explicitly. Both exercise this one permission, named for `init`; the op
    // a token names decides which API is signed, and Author is not among them.
    init: Object.freeze({
      backend: "learnosity",
      kind: "sign",
      ops: Object.freeze(["learnosity.sign-items-preview", "learnosity.sign-questions-preview"]),
      tags: Object.freeze(["INIT"]),
      implicit: true,
      delegable: true,
      viewSafe: true,
    }),
    // `save-to-itembank <activity>`: the node IS the item-bank write, and
    // ITEMS/QUESTIONS never write. The legacy literal member
    // (`items [save-to-itembank true ...]`) is lowered to the wrapper before
    // checking or admission; any other way of setting the flag is refused
    // (l0176 packages/core/src/save-lowering.ts, branch explicit-save).
    "save-to-itembank": Object.freeze({
      backend: "learnosity",
      kind: "write",
      ops: Object.freeze(["learnosity.write-items"]),
      tags: Object.freeze(["SAVE_TO_ITEMBANK"]),
      implicit: false,
      delegable: true,
      viewSafe: false,
    }),
    // Rendering an `author [...]` activity signs for the Author API. It is
    // owner-only and not delegable until its edit/delete authority has its
    // own reviewed boundary, and DISABLED (requiresEnablement) until provider
    // integration tests establish its request shape, item/reference and
    // widget restrictions and session limits (spec AUTHOR-01, AT-10).
    author: Object.freeze({
      backend: "learnosity",
      kind: "sign",
      ops: Object.freeze(["learnosity.sign-author"]),
      tags: Object.freeze(["AUTHOR"]),
      implicit: false,
      delegable: false,
      viewSafe: false,
      requiresEnablement: true,
    }),
  }),
});

const normalizeLang = (lang: unknown): string => String(lang ?? "").replace(/^L/i, "").padStart(4, "0");

export const protectedFunctionsForLang = (lang: unknown): Readonly<Record<string, FunctionSpec>> | null =>
  PROTECTED_FUNCTIONS[normalizeLang(lang)] || null;

// Is this function disabled unless a deployment explicitly enables it?
export const isGatedFunction = (lang: unknown, fn: unknown): boolean =>
  protectedFunctionsForLang(lang)?.[fn as string]?.requiresEnablement === true;

// Operations that only gated functions can name: Broker refuses these unless
// its own deployment enables them, independently of Policy.
export const gatedOperations = (): Set<string> => {
  const gated = new Set<string>();
  const open = new Set<string>();
  for (const fns of Object.values(PROTECTED_FUNCTIONS)) {
    for (const spec of Object.values(fns) as FunctionSpec[]) {
      for (const op of spec.ops) (spec.requiresEnablement === true ? gated : open).add(op);
    }
  }
  for (const op of open) gated.delete(op);
  return gated;
};

// The functions a view of a published item may use.
export const viewSafeFunctionsForLang = (lang: unknown): string[] =>
  Object.entries(protectedFunctionsForLang(lang) || {}).filter(([, spec]) => spec.viewSafe === true).map(([fn]) => fn);

// The functions a SYSTEM preview session may carry: a compile with no user
// connection signs its render through a Graffiticode-owned system connection
// (policy POST /v1/preview-session). Only functions that are signing,
// view-safe AND implicit (required by every render) qualify, so a system
// session can sign a preview and never write or open the Author Site. Derived
// from existing fields: this adds no authority and needs no version bump.
export const systemPreviewFunctionsForLang = (lang: unknown): string[] =>
  Object.entries(protectedFunctionsForLang(lang) || {})
    .filter(([, spec]) => spec.kind === "sign" && spec.viewSafe === true && spec.implicit === true)
    .map(([fn]) => fn);

// The two views a compiler needs (l0000 Compiler config): explicit functions
// keyed by node tag, and implicit ones required by every compile.
export const compilerConfigForLang = (lang: unknown) => {
  const fns = protectedFunctionsForLang(lang) || {};
  const protectedFunctions: Record<string, { fn: string; kind: FunctionSpec["kind"] }> = {};
  const implicitProtectedFunctions: { fn: string; kind: FunctionSpec["kind"] }[] = [];
  for (const [fn, spec] of Object.entries(fns)) {
    for (const tag of spec.tags) {
      protectedFunctions[tag] = { fn, kind: spec.kind };
    }
    if (spec.implicit) {
      implicitProtectedFunctions.push({ fn, kind: spec.kind });
    }
  }
  return { protectedFunctions, implicitProtectedFunctions };
};

// Minting check: may a token for (lang, fn) name this op against this
// connection backend? The full relationship must hold, so a preview grant can
// never sign Author requests or write items.
export const isOperationAllowed = ({ lang, fn, op, backend }: { lang: unknown; fn: unknown; op: unknown; backend: unknown }): boolean => {
  const spec = protectedFunctionsForLang(lang)?.[fn as string];
  const operation = Object.prototype.hasOwnProperty.call(OPERATIONS, op) ? OPERATIONS[op as keyof typeof OPERATIONS] : null;
  return Boolean(
    spec &&
    operation &&
    spec.ops.includes(op as string) &&
    spec.backend === backend &&
    operation.backend === backend &&
    operation.kind === spec.kind
  );
};

// Does a compiled task (a {lang, code} with code as a node pool) require any
// protected function? Used to keep such results out of shared caches. A
// language with an implicit protected function always does.
export const taskRequiresProtected = ({ lang, code }: { lang: unknown; code: unknown }): boolean => {
  const fns = protectedFunctionsForLang(lang);
  if (!fns) {
    return false;
  }
  const tags = new Set();
  for (const spec of Object.values(fns)) {
    if (spec.implicit) {
      return true;
    }
    spec.tags.forEach(tag => tags.add(tag));
  }
  if (!code || typeof code !== "object") {
    return false;
  }
  return Object.entries(code).some(
    ([key, node]: [string, any]) => key !== "root" && typeof node?.tag === "string" && tags.has(node.tag)
  );
};
