// SPDX-License-Identifier: MIT
// L0014's lexicon = L0000's base vocabulary + the L120 rule-authoring words
// (child keys win on merge).
//
// Transcribed from L120's `src/lexicon.js` — the entry shape (tk/name/cls/
// length/arity) is unchanged from the old Graffiticode host, so the port is a
// straight copy. L120's whole surface is thirteen words; that is the entire
// language for writing a TransLaTeX translator.
//
// TWO WORDS ARE DELIBERATELY NOT REDECLARED. L0000 already defines `equiv`
// (arity 2, `<any any: boolean>`) and `apply`. L120's `equiv` compared two
// translation results; L0000's compares any two values and subsumes it, so
// redeclaring would shadow the base for no gain. See compiler.ts.
import { lexicon as base } from "@graffiticode/l0000";

const additions = {
  // The rule set. Each is a record whose entries accumulate into `options`,
  // which is what a consumer of the compiled item reads as its rule set.
  words: { tk: 1, name: "WORDS", cls: "function", length: 1, arity: 1 },
  rules: { tk: 1, name: "RULES", cls: "function", length: 1, arity: 1 },
  types: { tk: 1, name: "TYPES", cls: "function", length: 1, arity: 1 },

  // The corpus. A list of [source, expected] pairs, run against the rule set
  // the rest of the program builds. This is the half of L120 that makes a rule
  // set self-validating rather than merely serializable.
  tests: { tk: 1, name: "TESTS", cls: "function", length: 1, arity: 1 },
  translate: { tk: 1, name: "TRANSLATE", cls: "function", length: 1, arity: 1 },

  // Parser options, passed through to TransLaTeX untouched.
  "allow-thousands-separator": { tk: 1, name: "ALLOW_THOUSANDS_SEPARATOR", cls: "function", length: 1, arity: 1 },
  "set-decimal-separator": { tk: 1, name: "SET_DECIMAL_SEPARATOR", cls: "function", length: 1, arity: 1 },
  "set-thousands-separator": { tk: 1, name: "SET_THOUSANDS_SEPARATOR", cls: "function", length: 1, arity: 1 },
  "allow-interval": { tk: 1, name: "ALLOW_INTERVAL", cls: "function", length: 1, arity: 1 },
  "ignore-text": { tk: 1, name: "IGNORE_TEXT", cls: "function", length: 1, arity: 1 },
  "ignore-coefficient-one": { tk: 1, name: "IGNORE_COEFFICIENT_ONE", cls: "function", length: 1, arity: 1 },
};

// L120 spelled these in camelCase (`allowThousandsSeparator`). Kebab-case is
// the modern convention across every L00xx dialect, and nothing depends on the
// old spelling: no L120 SOURCE survives outside the recovered fixtures, so
// there is no back-compatibility to keep. The COMPILED key names are a
// different matter and are preserved exactly — see optionFields in compiler.ts.
export const lexicon = { ...base, ...additions };

// L120's context alternates, deliberately not ported. They are the source of the
// three hard-coded context names in translatex's core.js:1001-1003, and NO
// shipping rule set uses any of them — checked across translatex's own set and
// all four of L0179's. The machinery there also carries a context-accumulation
// bug (core.js:991). Port them when a rule set needs them, not on spec.
//
// Listed here so they are dropped from the published vocabulary while the
// compiler can still name them in an error.
export const deprecatedWords: string[] = ["RHS", "NoParens", "EndRoot"];
