// SPDX-License-Identifier: MIT
/* Copyright (c) 2026, ARTCOMPILER INC */
//
// L0185 inherits L0000: its Checker/Transformer extend L0000's, so every L0000 expression still
// works inside a program — in lambdas, in `let`, anywhere a value is written.
//
// Every L0185 word is arity 2 — its parameter, then everything to its right — and its handler is
// GENERATED from `stepFields`: it evaluates the right-hand side FIRST (the record carrying the
// data so far), then its own parameter, then applies itself. So a program runs right to left:
// the source, just before `{}`, runs first.
import { Checker as BaseChecker, Transformer as BaseTransformer, Compiler } from "@graffiticode/l0000";

import { isRecord, showValue, stepFields, toPlainObject, wordOf } from "./attributes.js";
import { getFetcher } from "./source.js";
import * as steps from "./steps.js";
import { type Ctx, type State, isState } from "./steps.js";

const message = (e: any): string => String((e && e.message) || e);

export const MAX_OUTPUT_ROWS = 10_000;
export const MAX_OUTPUT_BYTES = 5_000_000;
export const MAX_URLS = 10;

/* ------------------------------------------------------------------ Checker */

export class Checker extends BaseChecker {
  [key: string]: any;
}

// An arity-2 word must walk BOTH children: `elts[1]` is the rest of the program, so a method that
// walked only `elts[0]` would silently drop every error to its right.
const checkBoth = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any) => {
    this.visit(node.elts[1], options, (e1: any) => resume(([] as any[]).concat(e0 || [], e1 || []), node));
  });
};
for (const name of Object.keys(stepFields)) Checker.prototype[name] = checkBoth;

const OWN_TAGS = new Set([...Object.keys(stepFields), "RECORD"]);

/**
 * A `{}` written before the end of a program ends it there, and the words after it parse as a
 * SECOND top-level expression — well formed, and silently dropped, because a program's value is
 * its last expression. Catch that: an L0185 word or a bare `{}` anywhere but the last position.
 */
Checker.prototype.PROG = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any) => {
    const errs = [...(e0 || [])];
    const exprs = this.nodePool[node.elts[0]];
    const elts: any[] = (exprs && exprs.elts) || [];
    const strayAt = elts.slice(0, -1).findIndex((e) => OWN_TAGS.has(this.nodePool[e]?.tag));
    if (strayAt >= 0) {
      const next = this.nodePool[elts[strayAt + 1]];
      errs.push({
        message:
          `A \`{}\` ended the program early: it has ${elts.length} top-level expressions where one was expected, ` +
          "and the words after the early `{}` started a new one. A program is steps, then the source, then exactly one `{}`: " +
          'write `where ["age" ABOVE 30] fetch "https://…" {}`, not `where ["age" ABOVE 30] {} fetch "https://…" {}`.',
        from: next?.coord?.from ?? -1,
        to: next?.coord?.to ?? -1,
      });
    }
    resume(errs, node);
  });
};

/* -------------------------------------------------------------- Transformer */

export class Transformer extends BaseTransformer {
  [key: string]: any;
}

/** The record to a word's right: the State so far, or the program-ending `{}`. */
function stateOf(word: string, rest: any): State {
  if (isState(rest)) return rest;
  const plain = toPlainObject(rest);
  if (isRecord(plain) && !Object.keys(plain).length) return { __l0185: true, opts: {} };
  throw new Error(`${word}: everything to its right must be more of the program, ending in \`{}\`, e.g. ${stepFields[word.toUpperCase().replace(/-/g, "_")].example}. Got ${showValue(plain)}.`);
}

/** The compiler's side of a step: lambdas applied per record, and deduplicated fetches. */
function ctxOf(t: any, options: any): Ctx {
  return {
    call(nodeId: number, row: any) {
      let err: any[] = [];
      let out: any;
      let done = false;
      t.visit(nodeId, { ...options, SYNC: true, args: [row] }, (e: any, v: any) => {
        err = ([] as any[]).concat(e || []);
        out = v;
        done = true;
      });
      if (!done) throw new Error("A function given to a step must compute its value directly; it cannot fetch.");
      if (err.length) throw new Error(message(err[0]));
      return toPlainObject(out);
    },
    fetch(url: string) {
      const cache: Map<string, Promise<any>> = (t.__fetches ??= new Map());
      if (!cache.has(url)) {
        if (cache.size >= MAX_URLS) throw new Error(`fetch: a program may fetch at most ${MAX_URLS} different URLs.`);
        cache.set(url, getFetcher()(url));
      }
      return cache.get(url)!;
    },
  };
}

/** A node with its parentheses removed: `(<row: …>)` is the lambda inside. */
function unparen(t: any, id: number): { id: number; node: any } {
  let node = t.nodePool[id];
  while (node?.tag === "PAREN" && node.elts?.length === 1) {
    id = node.elts[0];
    node = t.nodePool[id];
  }
  return { id, node };
}

/**
 * The parameter of a word, as the step needs it. Lambdas are kept as their node — evaluating a
 * lambda with no arguments yields only `{lambda: {params}}`, so `where (<row: …>)` and the values
 * of `derive {f: <row: …>}` are applied per record by `ctx.call` instead.
 */
function readParam(t: any, name: string, node: any, options: any, done: (err: any[], value: any) => void) {
  const { id: pid, node: pnode } = unparen(t, node.elts[0]);
  const expects = stepFields[name].expects;
  if (expects === "condition" && pnode?.tag === "LAMBDA") {
    done([], { lambda: pid });
    return;
  }
  if (expects === "lambda-record" && pnode?.tag === "RECORD") {
    const entries: [string, any][] = [];
    const errs: any[] = [];
    const bindings: number[] = pnode.elts || [];
    let pending = bindings.length;
    if (!pending) {
      done([], entries);
      return;
    }
    bindings.forEach((bid, i) => {
      const b = t.nodePool[bid];
      t.visit(b.elts[0], options, (ek: any, key: any) => {
        const k = toPlainObject(typeof key === "object" && key?.tag ? key.tag : key);
        const { id: vid, node: vnode } = unparen(t, b.elts[1]);
        const finish = (ev: any[], v: any) => {
          errs.push(...(ev || []));
          entries[i] = [String(k), v];
          if (--pending === 0) done(errs, entries);
        };
        errs.push(...(ek || []));
        if (vnode?.tag === "LAMBDA") finish([], { lambda: vid });
        else t.visit(b.elts[1], options, (ev: any, v: any) => finish(ev, toPlainObject(v)));
      });
    });
    return;
  }
  t.visit(node.elts[0], options, (e0: any, v0: any) => done(([] as any[]).concat(e0 || []), isState(v0) ? v0 : toPlainObject(v0)));
}

const APPLY: Record<string, (param: any, state: State, ctx: Ctx) => State | Promise<State>> = {
  FETCH: (p, s, c) => steps.fetchSource(p, s, c),
  ROWS: (p, s) => steps.rowsSource(p, s),
  FROM: (p, s) => steps.fromSource(p, s),
  WHERE: (p, s, c) => steps.where(p, s, c),
  PICK: (p, s) => steps.pick(p, s),
  OMIT: (p, s) => steps.omit(p, s),
  RENAME: (p, s) => steps.rename(p, s),
  DERIVE: (p, s, c) => {
    if (!Array.isArray(p)) throw new Error(`derive: expects {field: <row: …>}, e.g. derive {total: <row: mul (get "price" row) (get "qty" row)>}. Got ${showValue(p)}.`);
    return steps.derive(p, s, c);
  },
  FILL: (p, s) => steps.fill(p, s),
  GROUP_BY: (p, s) => steps.groupBy(p, s),
  SUMMARIZE: (p, s) => steps.summarize(p, s),
  SORT_BY: (p, s) => steps.sortBy(p, s),
  LIMIT: (p, s) => steps.limit(p, s),
  SKIP: (p, s) => steps.skip(p, s),
  DISTINCT: (p, s) => steps.distinct(p, s),
  UNNEST: (p, s) => steps.unnest(p, s),
  SPREAD: (p, s) => steps.spread(p, s),
  JOIN: (p, s) => steps.join(p, s),
  FORMAT: (p, s) => steps.format(p, s),
};

for (const [name, meta] of Object.entries(stepFields)) {
  const word = wordOf(name);
  Transformer.prototype[name] = function (this: any, node: any, options: any, resume: any) {
    this.visit(node.elts[1], options, (e1: any, v1: any) => {
      const err1 = ([] as any[]).concat(e1 || []);
      if (err1.length) {
        resume(err1, {});
        return;
      }
      readParam(this, name, node, options, (e0, param) => {
        if (e0.length) {
          resume(e0, {});
          return;
        }
        Promise.resolve()
          .then(() => {
            const state = stateOf(word, v1);
            if (meta.role === "option") return steps.option(name, param, state);
            return APPLY[name](param, state, ctxOf(this, options));
          })
          .then(
            (v) => resume([], v),
            (e) => resume([message(e)], {}),
          );
      });
    });
  };
}

/**
 * L0000 list functions used as steps. They are L0000's words, not L0185's — `take` is not a step
 * — so when one is given the data of an L0185 program, say what to write instead.
 */
const SHADOWED: Record<string, { arg: number; instead: string }> = {
  TAKE: { arg: 1, instead: 'limit 10 fetch "https://…" {}' },
  DROP: { arg: 1, instead: 'skip 10 fetch "https://…" {}' },
  FILTER: { arg: 1, instead: 'where ["age" ABOVE 30] fetch "https://…" {}' },
  MAP: { arg: 1, instead: 'derive {total: <row: …>} fetch "https://…" {}' },
  LAST: { arg: 0, instead: 'limit 1 sort-by ["date" DESC] fetch "https://…" {}' },
};
for (const [tag, { arg, instead }] of Object.entries(SHADOWED)) {
  const base = (BaseTransformer.prototype as any)[tag];
  Transformer.prototype[tag] = function (this: any, node: any, options: any, resume: any) {
    if (OWN_TAGS.has(this.nodePool[node.elts[arg]]?.tag)) {
      resume([`\`${tag.toLowerCase()}\` is L0000's list function, not an L0185 step. Write: ${instead}.`], {});
      return;
    }
    base.call(this, node, options, resume);
  };
}

const PROGRAM_EXAMPLE = 'where ["age" ABOVE 30] fetch "https://example.org/people.json" {}..';

/** The program's value is the data its last expression produced — nothing is added to it. */
Transformer.prototype.PROG = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    const err = ([] as any[]).concat(e0 || []);
    if (err.length) {
      resume(err, null);
      return;
    }
    const val = Array.isArray(v0) ? v0[v0.length - 1] : v0;
    if (!isState(val)) {
      resume([`A program is steps, then a source, then \`{}\`: e.g. ${PROGRAM_EXAMPLE}`], null);
      return;
    }
    if (val.data === undefined) {
      resume([`The program has no source. Put fetch, rows or from last, just before \`{}\`: e.g. ${PROGRAM_EXAMPLE}`], null);
      return;
    }
    if (val.groupBy) {
      resume(["group-by: has no summarize to its left. Write summarize {…} group-by […] …, e.g. summarize {orders: COUNT} group-by [\"region\"] fetch \"https://…\" {}."], null);
      return;
    }
    if (Array.isArray(val.data) && val.data.length > MAX_OUTPUT_ROWS) {
      resume([`The result has ${val.data.length} records, more than the ${MAX_OUTPUT_ROWS} L0185 returns. Add limit, or where, to keep fewer.`], null);
      return;
    }
    if (JSON.stringify(val.data).length > MAX_OUTPUT_BYTES) {
      resume(["The result is larger than 5 MB. Use pick to keep only the fields you need, or limit."], null);
      return;
    }
    resume([], val.data);
  });
};

export const compiler = new Compiler({ langID: "0185", version: "v0.1.0", Checker, Transformer });
