// The interpreter manifest: how each language's results are produced and how
// they may be stored, once the interpreter pass exists
// (docs/graffiticode-interpreter-design.md §11; docs/graffiticode-interpreter-plan.md,
// P1c and B2). The API reads it; a language server can't change it.
//
// It is kept apart from the protected registry on purpose. REGISTRY_VERSION is
// bound into tokens, broker receipts, admitted plans and stored artifacts, and
// a change to it is rolled out across services (P1b). Declaring or changing how
// a language is interpreted touches none of those, so it has its own version.
// Changes here are still security-relevant: a declaration caps how a
// language's results may be cached, so a looser cap can put a result where it
// must not go. Review them as such and bump INTERPRETER_MANIFEST_VERSION.
//
// Declarations only describe what a language may do. Activation is separate:
// a language is interpreted only while its INTERPRETER_LNNNN (reads) or
// COMMANDS_LNNNN (effects) flag is on in the API's environment, and each flag
// change moves its compile generation (plan, "Rollback procedures").
//
// Shape: lang -> declaration. A language without one is compile-only.
//   interpreter  "compile-only": today's POST /compile, run at the stage's
//                turn by the API's legacy adapter. "interpreter": the
//                language's Rust service compiles to a model and
//                POST /interpret evaluates it.
//   cacheCaps    per mode, the least restrictive cache class the language's
//                results may have. The API applies the stricter of this cap
//                and what the result says, so a language can tighten its
//                class but never loosen it past the cap.
//                  evaluate  a result that feeds the next stage
//                  present   the result the final consumer receives
//   interprets   other languages whose models this language interprets: the
//                approved producer -> interpreter pairs. One mapping drives
//                both routing and provenance checks.
//   getOrCreate  the one declared exception to a read-only get: an atomic,
//                idempotent create of per-viewer state (L0182's assignment).

export const INTERPRETER_MANIFEST_VERSION = 9;

// From loosest to strictest.
export const CACHE_CLASSES = Object.freeze(["immutable", "shared", "private", "no-store"] as const);
export type CacheClass = typeof CACHE_CLASSES[number];

export const INTERPRET_MODES = Object.freeze(["evaluate", "present"] as const);
export type InterpretMode = typeof INTERPRET_MODES[number];

export type InterpreterDeclaration = Readonly<{
  interpreter: "compile-only" | "interpreter";
  cacheCaps: Readonly<Record<InterpretMode, CacheClass>>;
  interprets?: readonly string[];
  getOrCreate?: boolean;
}>;

// Languages are added as each is upgraded (plan Track C). A declaration turns
// nothing on by itself: the API interprets a language only while its
// INTERPRETER_LNNNN is "on".
//   0184  C1: charts. A program that doesn't read its input is a value model;
//         one that does (`rows data use "0185"`) is a plan the kernel
//         evaluates. Its results carry nothing that expires or is private, so
//         they may be cached as immutable in either mode.
//   0186  C1: FigJam boards. Upstream data never reaches a board, so every
//         program that doesn't read its input (all of the corpus) is a value
//         model; immutable in either mode, as L0184.
//   0175  C1: Grade 5 ELA items. An item is composed from its program alone, so
//         every program that doesn't read its input (all of the corpus) is a
//         value model; immutable in either mode.
//   0187  C1 from its first release: declarative FigJam boards (Rust only).
//         Upstream data never reaches a board and layout is deterministic per
//         profile, so a program that doesn't read its input is a value model;
//         immutable in either mode, as L0186.
//   0174, 0179, 0181, 0183  C2: languages that read their input (forms,
//         spreadsheets, flashcard decks, concept webs). They don't declare input
//         independence, so every model is a plan the kernel evaluates against
//         the stage's input; L0174's PROG merges upstream data at run time. Their
//         results depend only on the program and its input, with nothing that
//         expires or is private, so immutable in either mode (the stage cache is
//         keyed by the input's digest).
//   0003, 0010, 0014, 0177, 0178, 0180  C2 batch 2: the rest of the languages
//         that read their input. Plans, immutable in either mode, as batch 1.
//         L0014 translates through its TransLaTeX worker when interpreted, as it
//         does when compiled; the translation is deterministic for the rule set
//         and source.
//   0185  C3: fetch & shape data (docs/c3-l0185-interpreter-plan.md). Every
//         model is a plan, and fetching runs only at interpret. The cap is
//         immutable on purpose: the language claims `shared` itself, expiring
//         5 minutes after its earliest fetch, for every result that fetched
//         (checked over its whole corpus), and a fetch-free result stays
//         immutable. A `shared` cap would downgrade fetch-free results to
//         shared with no expiry.
//   0176  C6 part 2: Learnosity (docs/c6-l0176-reads-plan.md). Every model is a
//         plan (`init` is implicit). Only `present` signs (the system preview
//         session, gateway-only): its result carries an expiring signature and
//         is never stored, so present is no-store, and the server answers it
//         `cache: false` too, errors included, for the legacy path. An
//         `evaluate` result is the activity unsigned, a function of the program
//         and its input (deterministic ids, no session id), and acts on nothing
//         (the kernel refuses every protected call in it): immutable, within its
//         input's own expiry. No `interprets` (L0158 stays on its /form
//         redirect; a follow-up).
export const INTERPRETER_DECLARATIONS: Readonly<Record<string, InterpreterDeclaration>> = Object.freeze({
  "0003": Object.freeze({
    interpreter: "interpreter",
    cacheCaps: Object.freeze({ evaluate: "immutable", present: "immutable" }),
  }),
  "0010": Object.freeze({
    interpreter: "interpreter",
    cacheCaps: Object.freeze({ evaluate: "immutable", present: "immutable" }),
  }),
  "0014": Object.freeze({
    interpreter: "interpreter",
    cacheCaps: Object.freeze({ evaluate: "immutable", present: "immutable" }),
  }),
  "0174": Object.freeze({
    interpreter: "interpreter",
    cacheCaps: Object.freeze({ evaluate: "immutable", present: "immutable" }),
  }),
  "0175": Object.freeze({
    interpreter: "interpreter",
    cacheCaps: Object.freeze({ evaluate: "immutable", present: "immutable" }),
  }),
  "0176": Object.freeze({
    interpreter: "interpreter",
    cacheCaps: Object.freeze({ evaluate: "immutable", present: "no-store" }),
  }),
  "0177": Object.freeze({
    interpreter: "interpreter",
    cacheCaps: Object.freeze({ evaluate: "immutable", present: "immutable" }),
  }),
  "0178": Object.freeze({
    interpreter: "interpreter",
    cacheCaps: Object.freeze({ evaluate: "immutable", present: "immutable" }),
  }),
  "0179": Object.freeze({
    interpreter: "interpreter",
    cacheCaps: Object.freeze({ evaluate: "immutable", present: "immutable" }),
  }),
  "0180": Object.freeze({
    interpreter: "interpreter",
    cacheCaps: Object.freeze({ evaluate: "immutable", present: "immutable" }),
  }),
  "0181": Object.freeze({
    interpreter: "interpreter",
    cacheCaps: Object.freeze({ evaluate: "immutable", present: "immutable" }),
  }),
  "0183": Object.freeze({
    interpreter: "interpreter",
    cacheCaps: Object.freeze({ evaluate: "immutable", present: "immutable" }),
  }),
  "0184": Object.freeze({
    interpreter: "interpreter",
    cacheCaps: Object.freeze({ evaluate: "immutable", present: "immutable" }),
  }),
  "0185": Object.freeze({
    interpreter: "interpreter",
    cacheCaps: Object.freeze({ evaluate: "immutable", present: "immutable" }),
  }),
  "0186": Object.freeze({
    interpreter: "interpreter",
    cacheCaps: Object.freeze({ evaluate: "immutable", present: "immutable" }),
  }),
  "0187": Object.freeze({
    interpreter: "interpreter",
    cacheCaps: Object.freeze({ evaluate: "immutable", present: "immutable" }),
  }),
});

// What an undeclared language is: today's protocol, with no cap beyond what
// its compile envelope already says.
export const COMPILE_ONLY: InterpreterDeclaration = Object.freeze({
  interpreter: "compile-only",
  cacheCaps: Object.freeze({ evaluate: "immutable", present: "immutable" }),
});

const normalizeLang = (lang: unknown): string => String(lang ?? "").replace(/^L/i, "").padStart(4, "0");
const LANG_RE = /^\d{4}$/;

// A language's declaration, or COMPILE_ONLY when it has none.
export const interpreterDeclarationFor = (
  lang: unknown,
  declarations: Readonly<Record<string, InterpreterDeclaration>> = INTERPRETER_DECLARATIONS,
): InterpreterDeclaration => declarations[normalizeLang(lang)] ?? COMPILE_ONLY;

// The language that interprets models `producer` produced: the one whose
// declaration names it in `interprets`, else the producer itself.
export const interpreterLangFor = (
  producer: unknown,
  declarations: Readonly<Record<string, InterpreterDeclaration>> = INTERPRETER_DECLARATIONS,
): string => {
  const lang = normalizeLang(producer);
  const claimant = Object.entries(declarations).find(([, d]) => (d.interprets ?? []).includes(lang));
  return claimant ? claimant[0] : lang;
};

// The stricter of two cache classes.
export const stricterCacheClass = (a: CacheClass, b: CacheClass): CacheClass =>
  CACHE_CLASSES.indexOf(a) >= CACHE_CLASSES.indexOf(b) ? a : b;

// A result's class after its language's cap for the mode: never looser than
// the cap. A class the manifest doesn't know is treated as the strictest.
export const capCacheClass = (
  claimed: unknown,
  lang: unknown,
  mode: InterpretMode,
  declarations: Readonly<Record<string, InterpreterDeclaration>> = INTERPRETER_DECLARATIONS,
): CacheClass => {
  const known = CACHE_CLASSES.includes(claimed as CacheClass) ? claimed as CacheClass : "no-store";
  return stricterCacheClass(known, interpreterDeclarationFor(lang, declarations).cacheCaps[mode]);
};

// Problems with a set of declarations, for the manifest's own test and for
// any declaration set a caller assembles.
export const manifestProblems = (declarations: Readonly<Record<string, unknown>>): string[] => {
  const problems: string[] = [];
  const claimedBy = new Map<string, string>();
  for (const [lang, raw] of Object.entries(declarations)) {
    const d = raw as Partial<InterpreterDeclaration> | null;
    if (!LANG_RE.test(lang)) problems.push(`${lang}: not a four-digit language id`);
    if (!d || typeof d !== "object") {
      problems.push(`${lang}: not a declaration`);
      continue;
    }
    if (d.interpreter !== "compile-only" && d.interpreter !== "interpreter") problems.push(`${lang}: interpreter must be "compile-only" or "interpreter"`);
    for (const mode of INTERPRET_MODES) {
      if (!CACHE_CLASSES.includes(d.cacheCaps?.[mode] as CacheClass)) problems.push(`${lang}: cacheCaps.${mode} must be one of ${CACHE_CLASSES.join(", ")}`);
    }
    for (const producer of d.interprets ?? []) {
      if (!LANG_RE.test(producer)) problems.push(`${lang}: interprets ${producer}, not a four-digit language id`);
      else if (producer === lang) problems.push(`${lang}: interprets itself`);
      else if (claimedBy.has(producer)) problems.push(`${producer}: interpreted by both ${claimedBy.get(producer)} and ${lang}`);
      else claimedBy.set(producer, lang);
    }
    if (d.getOrCreate !== undefined && typeof d.getOrCreate !== "boolean") problems.push(`${lang}: getOrCreate must be a boolean`);
    if (d.getOrCreate && d.interpreter !== "interpreter") problems.push(`${lang}: getOrCreate needs an interpreter`);
  }
  return problems;
};
