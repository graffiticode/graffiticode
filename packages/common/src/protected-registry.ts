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
// it guards (the lexicon name of its node tag: `init`, `save-to-itembank`),
// so permissions, grants and audit records read like the program.
//   backend    connection backend the function runs against
//   kind       read | write | sign
//   ops        broker operations a token for this fn may name — nothing else
//   tags       compiler node tags whose presence in a program requires the fn
//   implicit   required by every compile of the language (no source node)
//   delegable  whether an owner may grant it to another account
//   credential "connection" (the default): the function acts through an
//              owner's connection, with that connection's credentials.
//              "service": Broker acts with its own runtime identity; no
//              connection is ever presented, granted or delegated for it.
//   scope      what one execution of it is authorized against: "connection"
//              (the default) or "item" (one item id, checked against the item
//              store; docs/c5-l0013-commands-plan.md decisions 1 and 3)
//   publicCapture  for an item-scoped function only: the dated compatibility
//              exception under which a public item may be captured by a
//              caller who doesn't own it (C5 plan decision 4). `since` is set
//              when the exception takes effect (C5d's activation); until then
//              it is null and nothing executes under it.
//   viewSafe   whether a view of a published item may use it (the viewer holds
//              no grant; the publication's authority reaches only these)
//   writesOutsideCommands  the language's compile can perform this function's
//              write itself, outside Policy and Broker command control, when
//              it runs outside a command (L0013's direct thumbnail upload,
//              until C5d retires it). Nothing that must stay read-only may
//              dispatch a stage in such a language: a render grant's read is
//              refused before it compiles (writesOutsideCommandControl).

// There are no execution modes: running the program is the action, and the
// grant is the authority. A function runs whenever its program calls it
// through a connection whose grant covers it.
// v6: the registered execution-step table (OPERATIONS[op].steps) that W2's
// live authorization checks each Broker step against (spec API-02).
// v7: `author` and `learnosity.sign-author` removed (AUTHOR-01, closed by
// removal). Graffiticode signs no Author API sessions: L0176 makes items and
// activities for the item bank, and an Author integration is signed by the
// customer's own application (L0177 only plans one). Signing Author sessions
// again would be a new protected function, reviewed from scratch.
// v9 (C5a, docs/c5-l0013-commands-plan.md): L0013's `snap`, the first
// function with a service credential and an item scope, and its operation
// `gcs.put-thumbnail`, whose one dispatch step is conditional with bounded
// attempts; and `writesOutsideCommands`, which marks snap's legacy direct
// upload so read-only paths refuse its language. No v8 function or operation changes meaning, so v8 stays in the
// window and its artifacts stay compatible (decision 2).
// v8: `learnosity.write-items` only creates records (AT-10 B1). Broker writes
// every question and item under a reference derived from the operation id,
// never the one a program sent, and an item may link only to questions the
// same save writes. A save never changes a record already in the bank;
// re-saving a program makes new records.
export const REGISTRY_VERSION = 9;

// Earlier registry versions whose stored artifacts this version still serves
// (docs/graffiticode-interpreter-plan.md, P1). An artifact records the version
// it was made under, and a view or publish refuses one from any other version
// as incompatible, which strands it until its owner reruns or republishes. A
// bump that changes no protected function's meaning may list its predecessors
// here so their artifacts stay readable; that listing is part of the bump's
// security review. The default is none: a version not listed is incompatible.
// v8: v9 adds functions and changes none of v8's (C5 plan decision 2). There
// is no retirement step for this listing.
export const ARTIFACT_COMPATIBLE_VERSIONS: readonly number[] = Object.freeze([8]);

// A registry bump is rolled out across services, not swapped at once
// (docs/graffiticode-interpreter-plan.md, P1b). Policy and Broker deploy
// first with the new version and this window naming the old one, so
// compilers still reporting it, plans admitted under it and tokens minted
// for it keep working while compilers and the API catch up. A later release
// empties the window. List a version here only when every function and
// operation it registered keeps its meaning in the current registry: tokens
// it covers are interpreted under the current tables. Each plan keeps the
// version it was admitted under, and a receipt binds that version, so the
// two are never interchangeable. The default is none.
// v8: kept until its own retirement gate (C5 plan decision 2): every v8
// command terminal or given up, and no repair or materialize pending on one.
// Removing it earlier would leave v8 plans' unreached stages and B6 repairs
// with replay-only sessions.
export const REGISTRY_WINDOW: readonly number[] = Object.freeze([8]);

// Whether `version` may still execute: the current version, or one in the
// window.
export const isAcceptedRegistryVersion = (
  version: unknown,
  { current = REGISTRY_VERSION, window = REGISTRY_WINDOW }: { current?: number, window?: readonly number[] } = {},
): boolean =>
  version === current || (Number.isInteger(version) && window.includes(version as number));

// Whether an artifact made under `version` may be served now: the current
// version, or one the current version declares compatible.
export const isArtifactCompatible = (
  version: unknown,
  compatible: readonly number[] = ARTIFACT_COMPATIBLE_VERSIONS,
): boolean =>
  version === REGISTRY_VERSION || (Number.isInteger(version) && compatible.includes(version as number));

// What a step of an operation does:
//   dispatch  one provider request
//   sign      one local signature issuance (no provider request)
//   replay    returning an operation's recorded receipt instead of executing
export type StepPurpose = "dispatch" | "sign" | "replay";
// A `conditional` dispatch step is a precondition-guarded write: a failed
// precondition means nothing was written, and the step may be authorized again,
// as attempts 2..`attempts` of the same step, each with its own decision
// (C5 plan decision 5). Every other step is authorized once.
export type OperationStep = Readonly<{ id: string; purpose: StepPurpose; conditional?: true; attempts?: number }>;
export type Credential = "connection" | "service";
export type ScopeKind = "connection" | "item";

// One protected function's entry (see the field notes above).
export type FunctionSpec = Readonly<{
  backend: string;
  kind: "read" | "write" | "sign";
  ops: readonly string[];
  tags: readonly string[];
  implicit: boolean;
  delegable: boolean;
  viewSafe: boolean;
  credential?: Credential;
  scope?: ScopeKind;
  publicCapture?: Readonly<{ since: string | null }>;
  writesOutsideCommands?: true;
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
// The most attempts a conditional step may declare.
export const MAX_CONDITIONAL_ATTEMPTS = 4;
const conditionalStep = (id: string, attempts: number): OperationStep => Object.freeze({ id, purpose: "dispatch", conditional: true, attempts });
const SIGN_STEPS = Object.freeze([step("sign", "sign")]);

export const OPERATIONS = Object.freeze({
  // Items API and inline Questions API previews: the two rendering APIs L0176
  // uses for ordinary previews (packages/core/src/items.ts, questions.ts).
  "learnosity.sign-items-preview": Object.freeze({ backend: "learnosity", kind: "sign", steps: SIGN_STEPS }),
  "learnosity.sign-questions-preview": Object.freeze({ backend: "learnosity", kind: "sign", steps: SIGN_STEPS }),
  // Data API item-bank write: two sequential provider writes (questions, then
  // the items that reference them), each recorded as it completes, and a
  // receipt replay for a retry of the same operation. From v8 it only
  // creates: every reference is derived from the operation id (see above).
  "learnosity.write-items": Object.freeze({
    backend: "learnosity",
    kind: "write",
    steps: Object.freeze([step("questions", "dispatch"), step("items", "dispatch"), step("receipt", "replay")]),
  }),
  // L0013's thumbnail publish (C5 plan decision 8): Broker, as itself, reads
  // the staged PNG and replaces the item's object only if this capture's
  // sequence is newer, by one generation-precondition write. A failed
  // precondition wrote nothing and is retried as the next attempt.
  "gcs.put-thumbnail": Object.freeze({
    backend: "gcs",
    kind: "write",
    credential: "service" as const,
    steps: Object.freeze([conditionalStep("publish", MAX_CONDITIONAL_ATTEMPTS), step("receipt", "replay")]),
  }),
});

// The credential an operation or function acts with ("connection" unless it
// declares otherwise).
export const credentialOf = (entry: object | null | undefined): Credential =>
  (entry as { credential?: unknown } | null | undefined)?.credential === "service" ? "service" : "connection";

// The backends an owner may create a connection for: those of operations that
// act through a connection. A service backend (gcs) is never one.
export const connectionBackends = (): string[] =>
  [...new Set(Object.values(OPERATIONS).filter(op => credentialOf(op) === "connection").map(op => op.backend))].sort();

// The registered steps of an operation, or null for an unknown operation.
export const operationSteps = (op: unknown): readonly OperationStep[] | null =>
  Object.prototype.hasOwnProperty.call(OPERATIONS, op as string) ? OPERATIONS[op as keyof typeof OPERATIONS].steps : null;

// Is `step` a registered step of `op` with exactly this purpose? `after`, when
// given, is the step that completed just before: a dispatch step must come
// after the one listed before it (the first needs none), so steps cannot be
// skipped forward or repeated. Replay needs no predecessor.
//
// `attempt` (default 1) is which attempt of the step this is. Only a
// conditional step has more than one: attempt k (2 <= k <= its `attempts`)
// follows attempt k-1 of the same step, so `after` is the step itself. For
// any other step an attempt other than 1 is not registered, which leaves every
// unconditional step's rule exactly as before.
export const isStepRegistered = ({ op, step: id, purpose, after = null, attempt = 1 }: { op: unknown; step: unknown; purpose: unknown; after?: unknown; attempt?: unknown }): boolean => {
  const steps = operationSteps(op);
  if (!steps) return false;
  const index = steps.findIndex(s => s.id === id);
  if (index < 0 || steps[index].purpose !== purpose) return false;
  if (!Number.isInteger(attempt) || (attempt as number) < 1) return false;
  if (attempt !== 1) {
    const s = steps[index];
    return purpose === "dispatch" && s.conditional === true && (attempt as number) <= (s.attempts ?? 1) && after === s.id;
  }
  if (purpose !== "dispatch") return true;
  const dispatch = steps.filter(s => s.purpose === "dispatch");
  const position = dispatch.findIndex(s => s.id === id);
  return position === 0 ? after === null : after === dispatch[position - 1].id;
};

export const PROTECTED_FUNCTIONS = Object.freeze({
  "0176": Object.freeze({
    // Every L0176 render is signed in PROG (signForRender), and `init` signs
    // explicitly. Both exercise this one permission, named for `init`; the op
    // a token names decides which API is signed.
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
  }),
  "0013": Object.freeze({
    // `snap item "<id>" {…}..`: a capture of the item's own form view,
    // published as its thumbnail (C5 plan). It acts with Broker's identity on
    // one item, never through a connection, so it is never delegable.
    snap: Object.freeze({
      backend: "gcs",
      kind: "write",
      ops: Object.freeze(["gcs.put-thumbnail"]),
      tags: Object.freeze(["SNAP"]),
      implicit: false,
      delegable: false,
      viewSafe: false,
      credential: "service" as const,
      scope: "item" as const,
      publicCapture: Object.freeze({ since: null }),
      // Outside a command, L0013 still uploads a snap itself (its legacy
      // path), with no Policy or Broker in the way.
      writesOutsideCommands: true as const,
    }),
  }),
});

const normalizeLang = (lang: unknown): string => String(lang ?? "").replace(/^L/i, "").padStart(4, "0");

export const protectedFunctionsForLang = (lang: unknown): Readonly<Record<string, FunctionSpec>> | null =>
  PROTECTED_FUNCTIONS[normalizeLang(lang)] || null;

// The functions a view of a published item may use.
export const viewSafeFunctionsForLang = (lang: unknown): string[] =>
  Object.entries(protectedFunctionsForLang(lang) || {}).filter(([, spec]) => spec.viewSafe === true).map(([fn]) => fn);

// The functions a SYSTEM preview session may carry: a compile with no user
// connection signs its render through a Graffiticode-owned system connection
// (policy POST /v1/preview-session). Only functions that are signing,
// view-safe AND implicit (required by every render) qualify, so a system
// session can sign a preview and never write. Derived
// from existing fields: this adds no authority and needs no version bump.
export const systemPreviewFunctionsForLang = (lang: unknown): string[] =>
  Object.entries(protectedFunctionsForLang(lang) || {})
    .filter(([, spec]) => spec.kind === "sign" && spec.viewSafe === true && spec.implicit === true)
    .map(([fn]) => fn);

// Whether a compile in `lang` can write outside Policy and Broker command
// control: any of its functions declares `writesOutsideCommands`. A read-only
// path (a render grant's /form and /data) checks every stage of its chain
// against this and dispatches none that does.
export const writesOutsideCommandControl = (lang: unknown): boolean =>
  Object.values(protectedFunctionsForLang(lang) || {}).some(spec => spec.writesOutsideCommands === true);

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
// backend? The full relationship must hold, so a preview grant can never write
// items, and a write grant can never sign. `backend` comes from the
// credential: a connection function's is its connection's, a service
// function's is its operation's own. Function and operation must agree on the
// credential, so a connection can never reach a service operation, nor the
// reverse.
export const isOperationAllowed = ({ lang, fn, op, backend }: { lang: unknown; fn: unknown; op: unknown; backend: unknown }): boolean => {
  const spec = protectedFunctionsForLang(lang)?.[fn as string];
  const operation = Object.prototype.hasOwnProperty.call(OPERATIONS, op) ? OPERATIONS[op as keyof typeof OPERATIONS] : null;
  return Boolean(
    spec &&
    operation &&
    spec.ops.includes(op as string) &&
    spec.backend === backend &&
    operation.backend === backend &&
    operation.kind === spec.kind &&
    credentialOf(spec) === credentialOf(operation)
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
