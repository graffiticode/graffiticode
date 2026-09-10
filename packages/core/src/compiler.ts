// SPDX-License-Identifier: MIT
/* Copyright (c) 2026, ARTCOMPILER INC */
//
// L0014 inherits L0000: its Checker/Transformer extend L0000's, adding handlers
// for the rule-authoring vocabulary. Transcribed from L120's `src/compile.js`,
// which ran on the pre-L0000 Graffiticode host and is the language that
// produced every rule set TransLaTeX ships — including the one still in
// `@graffiticode/translatex/src/rules.js` today.
//
// THE OUTPUT CONTRACT IS FIXED: `{options, tests}`. `options` is what a
// consumer passes to `TransLaTeX.buildTranslator` as its rule set, and
// translatex's build wrote exactly `data.options` into `src/rules.js`. The
// round-trip test (see rules.test.ts) pins it byte for byte against the
// recovered original, which is the only real proof this port is faithful.
//
// ONE DELIBERATE DEPARTURE from L120. There, `words`/`rules`/`types` MUTATED
// the shared `options` object and `PROG` took the last expression as the tests
// — "Tests must be last", says the comment in L120's program(). Here each
// statement is a pure single-key record and PROG merges them, then runs the
// corpus against the assembled rule set. Same output, no ordering rule, and it
// matches how every modern dialect composes (cf. L0179's attribute lists).
import {
  Checker as BaseChecker,
  Transformer as BaseTransformer,
  Compiler,
} from "@graffiticode/l0000";
import { TransLaTeX } from "@graffiticode/translatex";

// Unwrap L0000's internal Record representation ({_type:"record", _entries:Map})
// to plain JS, stripping the tag:/str:/num: key prefixes.
//
// INSERTION ORDER IS LOAD-BEARING and this preserves it. translatex's match()
// filters patterns in `Object.keys` order and matchedExpansion() takes the
// first hit, so the order rules are written in IS their precedence. A Map
// iterates in insertion order and none of these keys are integer-like (they are
// patterns like "?+?" and words like "\\alpha"), so the object keeps it.
function toPlainObject(val: any): any {
  if (val !== null && typeof val === "object" && val._type === "record" && val._entries instanceof Map) {
    const obj: any = {};
    for (const [k, v] of val._entries) {
      const name = (k as string).replace(/^(tag|str|num):/, "");
      obj[name] = toPlainObject(v);
    }
    return obj;
  }
  if (Array.isArray(val)) {
    return val.map(toPlainObject);
  }
  return val;
}

/**
 * Collapse runs of whitespace and trim the ends.
 *
 * Transcribed from L120's `trim()`, and it is applied to the EXPECTED value of
 * a test but never to the actual. That asymmetry is intentional there: the
 * expected value is hand-written in the source and wraps across lines, while
 * the actual comes from the translator and is already canonical.
 */
export function trim(str: any): string {
  if (typeof str !== "string") return str == null ? "" : String(str);
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const c = str.charAt(i);
    if (c === " " || c === "\t" || c === "\n") {
      // Erase space at the beginning and after other space.
      if (out.length === 0 || out.charAt(out.length - 1) === " ") continue;
      out += " ";
    } else {
      out += c;
    }
  }
  return out.charAt(out.length - 1) === " " ? out.slice(0, -1) : out;
}

/**
 * The compiled key each option word writes.
 *
 * The WORD is kebab-case (modern convention); the KEY is whatever translatex
 * already reads, and those are not the same string. `allow-thousands-separator`
 * emits `allowThousandsSeparator` because that is the name
 * `parse()` looks up in parselatex (model.js:908). Renaming any value here
 * silently disables the option rather than erroring, so this table is
 * transcribed, not derived.
 */
const optionFields: Record<string, string> = {
  ALLOW_THOUSANDS_SEPARATOR: "allowThousandsSeparator",
  SET_DECIMAL_SEPARATOR: "setDecimalSeparator",
  SET_THOUSANDS_SEPARATOR: "setThousandsSeparator",
  ALLOW_INTERVAL: "allowInterval",
  IGNORE_TEXT: "ignoreText",
  IGNORE_COEFFICIENT_ONE: "ignoreCoefficientOne",
};

/** A single-key contribution to `options`, tagged so PROG can merge in order. */
const contribution = (key: string, value: any) => ({ __l0014: key, value });

export class Checker extends BaseChecker {
  [key: string]: any;

  WORDS(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any) => resume(([] as any[]).concat(e0 || []), node));
  }

  RULES(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any) => resume(([] as any[]).concat(e0 || []), node));
  }

  TYPES(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any) => resume(([] as any[]).concat(e0 || []), node));
  }

  TESTS(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any) => resume(([] as any[]).concat(e0 || []), node));
  }

  TRANSLATE(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any) => resume(([] as any[]).concat(e0 || []), node));
  }
}

// The option words are all the same shape, so they are generated rather than
// hand-written — the same reason L0179 generates its attribute handlers.
for (const name of Object.keys(optionFields)) {
  Checker.prototype[name] = function (node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any) => resume(([] as any[]).concat(e0 || []), node));
  };
}

export class Transformer extends BaseTransformer {
  [key: string]: any;

  WORDS(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      resume(([] as any[]).concat(e0 || []), contribution("words", toPlainObject(v0) || {}));
    });
  }

  /**
   * `rules { "pattern": "expansion" }` compiles to `{"pattern": ["expansion"]}`.
   *
   * THE ARRAY WRAP IS THE WHOLE POINT and it is transcribed from L120's
   * rules(): a bare value becomes a one-element list, a list is left alone.
   * Every rule set in existence has this shape — measured across all five live
   * ones, expansions are either `["string"]` or `[{key: {...}}]` and nothing
   * else — so a pretty-printer can invert it and the round-trip closes.
   */
  RULES(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      const plain = toPlainObject(v0) || {};
      const rules: any = {};
      for (const k of Object.keys(plain)) {
        const v = plain[k];
        rules[k] = Array.isArray(v) ? v : [v];
      }
      resume(([] as any[]).concat(e0 || []), contribution("rules", rules));
    });
  }

  TYPES(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      resume(([] as any[]).concat(e0 || []), contribution("types", toPlainObject(v0) || {}));
    });
  }

  /**
   * The corpus, carried unevaluated. L120 translated each case HERE, which is
   * why it required `tests` to be the last statement — it needed the rule set
   * to already be in `options`. PROG runs them instead, so order stops
   * mattering.
   */
  TESTS(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      const plain = toPlainObject(v0);
      resume(([] as any[]).concat(e0 || []), contribution("tests", Array.isArray(plain) ? plain : []));
    });
  }

  /** Translate one source string against the rule set built so far. */
  TRANSLATE(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      const { value, errors } = runTranslate(String(v0 ?? ""), collectOptions(options.__l0014Rules || {}));
      resume(([] as any[]).concat(e0 || [], errors), value);
    });
  }

  PROG(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      const err = ([] as any[]).concat(e0 || []);
      const list = Array.isArray(v0) ? v0 : [v0];

      // Merge the statements in source order; a repeated statement wins, which
      // is what L120 did by assigning into `options`.
      const acc: any = {};
      let corpus: any[] = [];
      for (const item of list) {
        if (item && typeof item === "object" && item.__l0014) {
          if (item.__l0014 === "tests") corpus = item.value;
          else acc[item.__l0014] = item.value;
        }
      }

      const compiled = collectOptions(acc);
      const tests = runCorpus(corpus, compiled);
      resume(err, { options: compiled, tests });
    });
  }
}

for (const [name, field] of Object.entries(optionFields)) {
  Transformer.prototype[name] = function (node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      resume(([] as any[]).concat(e0 || []), contribution(field, toPlainObject(v0)));
    });
  };
}

/**
 * Assemble the compiled rule set.
 *
 * `data` is always present and always empty. It is a vestige of the old host —
 * every recovered rule set carries it, translatex's `src/rules.js` starts
 * `{"data":{}, ...}`, and l0166's first rules file still had it. Emitting it
 * keeps the round-trip byte-identical; dropping it would be a gratuitous diff
 * against every shipping artifact.
 */
function collectOptions(acc: any) {
  const out: any = { data: {} };
  if (acc.words) out.words = acc.words;
  if (acc.types) out.types = acc.types;
  if (acc.rules) out.rules = acc.rules;
  for (const field of Object.values(optionFields)) {
    if (acc[field] !== undefined) out[field] = acc[field];
  }
  return out;
}

/** Run one source string through TransLaTeX. Never throws; errors come back as data. */
function runTranslate(source: string, ruleSet: any): { value: string; errors: any[] } {
  let value = "";
  let errors: any[] = [];
  try {
    const translate = TransLaTeX.buildTranslator({ ...ruleSet }, undefined as any);
    translate(source, (err: any, val: any) => {
      if (err && err.length) errors = errors.concat(err.map((e: any) => String(e)));
      value = val;
    });
  } catch (x: any) {
    errors = errors.concat(String(x && x.message ? x.message : x));
  }
  return { value, errors };
}

/**
 * Score the corpus against the assembled rule set.
 *
 * `score` is 1 or -1, not true/false — transcribed from L120, and the recovered
 * rule set's own tests carry exactly those values. An empty `expected` means
 * "capture what it does today", which is how the original corpus was written:
 * every one of its ~50 LaTeX cases has `""` on the right.
 */
function runCorpus(corpus: any[], ruleSet: any) {
  const out: any[] = [];
  for (const entry of corpus) {
    if (!Array.isArray(entry)) continue;
    const source = entry[0];
    const expected = trim(entry[1]);
    const { value } = runTranslate(String(source ?? ""), ruleSet);
    out.push({ score: value === expected ? 1 : -1, source, actual: value, expected });
  }
  return out;
}

export const compiler = new Compiler({
  langID: "0014",
  version: "v0.0.1",
  Checker,
  Transformer,
});
