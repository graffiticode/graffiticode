// The interpreter pass in the API (docs/graffiticode-interpreter-plan.md, B3):
// which stages are interpreted, the restrictions a stage's result carries, and
// the stage cache's key. data.js runs the chain with these.
//
// A stage is interpreted only when its language is declared an interpreter in
// @graffiticode/common/interpreter-manifest AND its INTERPRETER_LNNNN is "on"
// in the API's environment. Every other stage goes through the legacy adapter,
// today's POST /compile, unchanged. No language is declared yet, so every chain
// runs exactly as before.
import { canonicalDigest } from "@graffiticode/common/canonical";
import {
  INTERPRETER_DECLARATIONS, capCacheClass, interpreterDeclarationFor, stricterCacheClass,
} from "@graffiticode/common/interpreter-manifest";

const FLAG_RE = /^INTERPRETER_L(\d{4})$/;

// The languages whose stages are interpreted, from the environment, read at
// each request's start like the compile generations. A flag for a language the
// manifest doesn't declare an interpreter is ignored (and logged): the
// declaration is what caps its results, so there is nothing to run it under.
export const getInterpreterLanguages = (env = process.env, declarations = INTERPRETER_DECLARATIONS) => {
  const langs = new Set();
  for (const [name, value] of Object.entries(env)) {
    const match = FLAG_RE.exec(name);
    if (!match || value === undefined || value === "" || value === "off") continue;
    if (value !== "on") {
      console.log(`ERROR ${name} must be "on" or "off"; treating it as off`);
      continue;
    }
    if (interpreterDeclarationFor(match[1], declarations).interpreter !== "interpreter") {
      console.log(`ERROR ${name} is on, but L${match[1]} isn't declared an interpreter; treating it as off`);
      continue;
    }
    langs.add(match[1]);
  }
  return langs;
};

// What a result may be cached as, and until when (epoch ms, or null for no
// expiry). A chain's result carries the strictest class and earliest expiry of
// every stage it went through.
/** @typedef {{ cacheClass: import("@graffiticode/common/interpreter-manifest").CacheClass, expiresAt: number | null }} Restrictions */
/** @type {Readonly<Restrictions>} */
export const PERMANENT = Object.freeze({ cacheClass: "immutable", expiresAt: null });
/** @type {Readonly<Restrictions>} */
export const NO_STORE = Object.freeze({ cacheClass: "no-store", expiresAt: null });

const earliest = (a, b) => (a === null ? b : b === null ? a : Math.min(a, b));

/** @type {(a: Restrictions, b: Restrictions) => Restrictions} */
export const combineRestrictions = (a, b) => ({
  cacheClass: stricterCacheClass(a.cacheClass, b.cacheClass),
  expiresAt: earliest(a.expiresAt, b.expiresAt),
});

// An expiry the stage gave, as epoch ms. One that can't be read has already
// passed, so its result is never stored.
const parseExpiry = value => {
  if (value === undefined || value === null) return null;
  const ms = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

// A legacy stage says only `cache: false` (L0176's signed previews), which is
// no-store; anything else is what it has always been, immutable.
export const legacyRestrictions = envelope =>
  (envelope && typeof envelope === "object" && envelope.cache === false ? NO_STORE : PERMANENT);

// An interpreted stage's own restrictions: the class its envelope claims
// (`cache: false` is no-store, none is immutable, a class it names is that
// class, anything else the strictest), capped by its language's declaration
// for the mode, and its `expiresAt`.
export const interpretedRestrictions = (envelope, lang, mode, declarations = INTERPRETER_DECLARATIONS) => {
  const cache = envelope?.cache;
  const claimed = cache === undefined ? "immutable" : cache === false ? "no-store" : cache;
  return {
    cacheClass: capCacheClass(claimed, lang, mode, declarations),
    expiresAt: parseExpiry(envelope?.expiresAt),
  };
};

// What the API reads from an interpreted stage's answer and never forwards:
// the next stage, a legacy compiler and the client see the envelope without
// it.
const STAGE_METADATA = ["cache", "expiresAt", "revision", "responseLost"];
export const withoutStageMetadata = envelope => {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return envelope;
  const out = { ...envelope };
  for (const field of STAGE_METADATA) delete out[field];
  return out;
};

// Whether a result with these restrictions may be read from or written to a
// shared cache: only immutable and shared results that haven't expired.
// Private and no-store never are.
export const sharable = ({ cacheClass, expiresAt }, now = Date.now()) =>
  (cacheClass === "immutable" || cacheClass === "shared") && (expiresAt === null || expiresAt > now);

// Whether a result may be held as the whole chain's permanent answer (the
// compiles/ store, immutable HTTP caching): immutable, with no expiry.
export const permanent = ({ cacheClass, expiresAt }) => cacheClass === "immutable" && expiresAt === null;

// Whose authority a stage ran under, as the stage cache keys it. A compile
// without a connection runs as its caller: anonymous, or the signed-in user
// (whose token reaches the interpreter), so one user's result is never served
// to another. A compile through a connection is never interpreted in B3.
export const authorityFor = uid => (uid ? `user:${uid}` : "anonymous");

// The stage cache's key: everything that decides an interpreted stage's
// result. The model digest covers its language, kind and contents; the
// interpreter's revision, the configuration, the language's generation, the
// mode and the authority are beside it, and so is the input, by its canonical
// digest. A change to any one is a different entry.
export const stageCacheKey = ({ lang, interpreterLang, modelDigest, revision, options, generation, mode, authority, input }) =>
  canonicalDigest({
    v: 1,
    lang,
    interpreterLang,
    modelDigest,
    revision,
    config: canonicalDigest(options ?? {}),
    generation: generation ?? null,
    mode,
    authority,
    input: canonicalDigest(input ?? null),
  });
