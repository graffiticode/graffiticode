// The authoritative registry of protected functions: compiler functions that
// exercise an external API through an owner's connection, and the broker
// operations each one may be issued. Policy (minting) and the broker
// (execution) consult ONLY this manifest. A compiler may publish metadata for
// display, but neither a compiler nor a per-user language override defines what
// authority it receives. Changes here are security changes: review them as
// such and bump REGISTRY_VERSION.
//
// Shape: lang -> fn -> spec
//   backend    connection backend the function runs against
//   kind       read | write | sign
//   modes      execution modes it may run in, set by the authenticated entry
//              point and bound into the session: a write only ever `save`
//   ops        broker operations a token for this fn may name — nothing else
//   tags       compiler node tags whose presence in a program requires the fn
//   implicit   required by every compile of the language (no source node)
//   delegable  whether an owner may grant it to another account

export const REGISTRY_VERSION = 2;

const ALL_MODES = Object.freeze(["save", "author", "read", "render", "verify", "corpus"]);

// Broker operations. The broker builds each request itself from a constrained
// payload; none is a general signer or proxy.
export const OPERATIONS = Object.freeze({
  // Items API and inline Questions API previews: the two rendering APIs L0176
  // uses for ordinary previews (packages/core/src/items.ts, questions.ts).
  "learnosity.sign-items-preview": Object.freeze({ backend: "learnosity", kind: "sign" }),
  "learnosity.sign-questions-preview": Object.freeze({ backend: "learnosity", kind: "sign" }),
  // Author API signing. Its config carries edit and delete permissions
  // (packages/core/src/author.ts), so it is NOT preview authority, and it runs
  // only in `author` mode, which only the owner's authoring entry point sets —
  // never a render, read, verification or corpus request. The broker accepts a
  // constrained payload and builds the request itself: mode fixed to
  // `item_edit`, one item `reference` (required), widget types drawn only from
  // the L0176 allowlist, and no custom widgets or caller-supplied config.
  "learnosity.sign-author": Object.freeze({ backend: "learnosity", kind: "sign" }),
  // Data API item-bank write (two sequential provider writes; see receipts).
  "learnosity.write-items": Object.freeze({ backend: "learnosity", kind: "write" }),
});

export const PROTECTED_FUNCTIONS = Object.freeze({
  "0176": Object.freeze({
    // Every L0176 render is signed in PROG (signForRender), and `init` signs
    // explicitly. Both exercise this one permission; the op a token names
    // decides which API is signed, and Author is not among them.
    "preview-itembank": Object.freeze({
      backend: "learnosity",
      kind: "sign",
      ops: Object.freeze(["learnosity.sign-items-preview", "learnosity.sign-questions-preview"]),
      tags: Object.freeze(["INIT"]),
      modes: ALL_MODES,
      implicit: true,
      delegable: true,
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
      modes: Object.freeze(["save"]),
      implicit: false,
      delegable: true,
    }),
    // Rendering an `author [...]` activity signs for the Author API. Owners
    // may use it through their own connection; it is not delegable until its
    // edit/delete authority has its own reviewed boundary.
    "author-itembank": Object.freeze({
      backend: "learnosity",
      kind: "sign",
      ops: Object.freeze(["learnosity.sign-author"]),
      tags: Object.freeze(["AUTHOR"]),
      modes: Object.freeze(["author"]),
      implicit: false,
      delegable: false,
    }),
  }),
});

const normalizeLang = lang => String(lang ?? "").replace(/^L/i, "").padStart(4, "0");

export const protectedFunctionsForLang = lang =>
  PROTECTED_FUNCTIONS[normalizeLang(lang)] || null;

// The two views a compiler needs (l0000 Compiler config): explicit functions
// keyed by node tag, and implicit ones required by every compile.
export const compilerConfigForLang = lang => {
  const fns = protectedFunctionsForLang(lang) || {};
  const protectedFunctions = {};
  const implicitProtectedFunctions = [];
  for (const [fn, spec] of Object.entries(fns)) {
    for (const tag of spec.tags) {
      protectedFunctions[tag] = { fn, kind: spec.kind, modes: [...spec.modes] };
    }
    if (spec.implicit) {
      implicitProtectedFunctions.push({ fn, kind: spec.kind, modes: [...spec.modes] });
    }
  }
  return { protectedFunctions, implicitProtectedFunctions };
};

// Minting check: may a token for (lang, fn) name this op against this
// connection backend, in this session's mode? The full relationship must hold,
// so a preview grant can never sign Author requests or write items, and a
// render session can never mint an Author signature or a write.
export const isOperationAllowed = ({ lang, fn, op, backend, mode }) => {
  const spec = protectedFunctionsForLang(lang)?.[fn];
  const operation = Object.prototype.hasOwnProperty.call(OPERATIONS, op) ? OPERATIONS[op] : null;
  return Boolean(
    spec &&
    operation &&
    spec.ops.includes(op) &&
    spec.modes.includes(mode) &&
    spec.backend === backend &&
    operation.backend === backend &&
    operation.kind === spec.kind
  );
};

// Does a compiled task (a {lang, code} with code as a node pool) require any
// protected function? Used to keep such results out of shared caches. A
// language with an implicit protected function always does.
export const taskRequiresProtected = ({ lang, code }) => {
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
    ([key, node]) => key !== "root" && typeof node?.tag === "string" && tags.has(node.tag)
  );
};
