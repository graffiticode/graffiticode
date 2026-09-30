// SPDX-License-Identifier: MIT
/* Copyright (c) 2026, ARTCOMPILER INC */
//
// L0184 inherits L0000: its Checker/Transformer extend L0000's. Property and member handlers are
// GENERATED from the tables in `attributes.ts` — never hand-write one. The containers and PROG
// are written out, because each assembles something the tables cannot express. Unhandled tags
// fall through to L0000's handlers, so every L0000 expression still works inside a program.
import { Checker as BaseChecker, Transformer as BaseTransformer, Compiler } from "@graffiticode/l0000";

import {
  assertKnownAttributes,
  assertKnownSettings,
  chainFields,
  checkValue,
  containerFields,
  containerParts,
  exampleOf,
  hintFor,
  isRecord,
  listMember,
  memberFields,
  showValue,
  sourceWord,
  toPlainObject,
  validSettings,
  wordOf,
} from "./attributes.js";
import { buildCollection } from "./collection.js";

const message = (e: any): string => String((e && e.message) || e);

/* ------------------------------------------------------------------ Checker */

export class Checker extends BaseChecker {
  [key: string]: any;
}

const checkChild = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any) => resume(([] as any[]).concat(e0 || []), node));
};

// An arity-2 word must walk BOTH children: `elts[1]` is the rest of the chain, so a method that
// walked only `elts[0]` would silently drop every error below it.
const checkBoth = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any) => {
    this.visit(node.elts[1], options, (e1: any) => resume(([] as any[]).concat(e0 || [], e1 || []), node));
  });
};

// The Checker only walks the tree. Value validation lives in the Transformer — `Checker.LIST`
// visits just `elts[0]`, so a rule written here would fire on the first element of a list only.
for (const name of Object.keys(chainFields)) Checker.prototype[name] = checkBoth;
for (const name of Object.keys(memberFields)) Checker.prototype[name] = checkChild;
for (const name of Object.keys(containerFields)) Checker.prototype[name] = checkBoth;

/** The node tags L0184's own words produce, plus a bare `{}`. */
const OWN_TAGS = new Set([...Object.keys(chainFields), ...Object.keys(memberFields), ...Object.keys(containerFields), "RECORD"]);

/**
 * A `{}` written before the end of a description ends it there, and the words after it parse as
 * a SECOND top-level expression — well formed, and silently dropped, because a program's value
 * is its last expression. That is the one mistake the parser cannot report, so it is caught
 * here: an L0184 word or a bare `{}` anywhere but the last position is an early-closed
 * description. L0000 expressions (`set-var`, `print`, …) may still precede the program.
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
          `A \`{}\` ended a description early: the program has ${elts.length} top-level expressions where one ` +
          "`charts [ … ] {}` was expected, and the words after the early `{}` started a new one. " +
          "Every description ends in exactly one `{}`, after its last word: write " +
          "`plot kind BAR values [1 2] {}`, not `plot kind BAR {} values [1 2] {}`.",
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

/** Where a property's chain goes, for the "must end in a record" error. */
const chainExample = (word: string): string => {
  const owner = Object.keys(validSettings).find((c) => validSettings[c].includes(word));
  if (owner === "charts") return `charts [ … ] ${word} … {}`;
  if (owner === "chart") return `chart [ … ] ${word} … {}`;
  return `plot kind BAR ${word} … {}`;
};

/** Properties, arity 2: the value AND the rest of the chain; returns the chain's record + this key. */
for (const [name, meta] of Object.entries(chainFields)) {
  Transformer.prototype[name] = function (this: any, node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      this.visit(node.elts[1], options, (e1: any, v1: any) => {
        const err = ([] as any[]).concat(e0 || [], e1 || []);
        const word = wordOf(name);
        const { value, error } = checkValue(name, meta, toPlainObject(v0));
        if (error) {
          resume(err.concat(error), {});
          return;
        }
        const rest = toPlainObject(v1);
        if (!isRecord(rest)) {
          resume(
            err.concat(`${word}: a description must end in a record — write \`{}\` after its last word, e.g. ${chainExample(word)}. Got ${showValue(rest)}.`),
            {},
          );
          return;
        }
        if (Object.prototype.hasOwnProperty.call(rest, meta.field)) {
          resume(err.concat(`${word}: is given twice. Each word may appear once in a description.`), {});
          return;
        }
        resume(err, { ...rest, [meta.field]: value });
      });
    });
  };
}

/** Members, arity 1: `plot <description>` evaluates to `{plot: {...}}`. */
for (const [name, meta] of Object.entries(memberFields)) {
  Transformer.prototype[name] = function (this: any, node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      const err = ([] as any[]).concat(e0 || []);
      const { value, error } = checkValue(name, meta, toPlainObject(v0));
      if (error) {
        resume(err.concat(error), {});
        return;
      }
      resume(err, { [meta.field]: value });
    });
  };
}

const article = (w: string): string => `${/^[aeiou]/.test(w) ? "an" : "a"} \`${w}\``;

/** Something in a list, as written, for an error message. */
const describe = (m: any): string => {
  if (isRecord(m)) {
    const keys = Object.keys(m);
    if (!keys.length) return "a stray `{}` — a description ends in exactly one `{}`";
    if (keys.length === 1) return article(sourceWord(keys[0]));
    return `a description (${keys.map(sourceWord).join(", ")}) with no word in front of it`;
  }
  return showValue(m);
};

/** Words that start a list item on their own, as opposed to properties inside one. */
const ITEM_WORDS = new Set([...Object.keys(memberFields), ...Object.keys(containerFields)].map(wordOf));

/**
 * When a list item is a bare property (`values …`, `title …`), the usual cause is a `{}` that
 * ended the previous description early, so the rest of it became an item of its own.
 */
const earlyClose = (m: any, prev: string): string => {
  const keys = isRecord(m) ? Object.keys(m) : [];
  if (keys.length !== 1 || ITEM_WORDS.has(sourceWord(keys[0]))) return "";
  return ` If \`${sourceWord(keys[0])}\` belongs to the ${prev} before it, a \`{}\` ended that ${prev} early: a description ends in exactly one \`{}\`, after its last word.`;
};

/** Run both children of a container; hand the list and settings to `build`. */
function container(word: string, build: (list: any[], settings: any) => any) {
  return function (this: any, node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      this.visit(node.elts[1], options, (e1: any, v1: any) => {
        const err = ([] as any[]).concat(e0 || [], e1 || []);
        if (err.length) {
          resume(err, {});
          return;
        }
        const list = toPlainObject(v0);
        const settings = toPlainObject(v1);
        if (!Array.isArray(list)) {
          resume([`${word}: expected a list in [brackets], e.g. ${exampleOf(word)}.`], {});
          return;
        }
        if (!isRecord(settings)) {
          resume([`${word}: needs its settings after the \`]\`, ending in a record — write \`{}\` when there are none, e.g. ${exampleOf(word)}.`], {});
          return;
        }
        try {
          resume([], build(list, settings));
        } catch (e) {
          resume([message(e)], {});
        }
      });
    });
  };
}

/**
 * A typed list (`datasets`, `axes`, `plots`): every entry is its one member word, and each
 * member's words are checked as it is reached, so an error lands on the member that caused it.
 */
function memberList(word: string) {
  const member = listMember[word];
  return container(word, (list, settings) => {
    assertKnownSettings(word, settings);
    const items = list.map((m, i) => {
      const keys = isRecord(m) ? Object.keys(m) : [];
      if (keys.length !== 1 || keys[0] !== member) {
        throw new Error(
          `${word}: item ${i + 1} is ${describe(m)}, not ${article(member)}. Every item is written ${exampleOf(member)}.${i > 0 ? earlyClose(m, member) : ""}`,
        );
      }
      assertKnownAttributes(member, m[member], `${member} ${m[member].id ? JSON.stringify(m[member].id) : i + 1}`);
      return m[member];
    });
    return { [word]: { items } };
  });
}

Transformer.prototype.DATASETS = memberList("datasets");
Transformer.prototype.AXES = memberList("axes");
Transformer.prototype.PLOTS = memberList("plots");

/** A container's parts, each at most (and at least) as often as `containerParts` allows. */
function collectParts(word: string, list: any[], where: string): Record<string, any[]> {
  const allowed = containerParts[word];
  const got: Record<string, any[]> = {};
  list.forEach((m, i) => {
    const keys = isRecord(m) ? Object.keys(m) : [];
    const part = keys.length === 1 ? sourceWord(keys[0]) : undefined;
    if (!part || !allowed[part]) {
      const own = part && validSettings[word]?.includes(part);
      const hint = !part
        ? ""
        : own
          ? ` \`${part}\` is a setting of ${word}: write it after the ${word === "charts" ? "outer" : "chart's"} \`]\`, e.g. ${word} [ … ] ${part} … {}.`
          : hintFor(part, word);
      throw new Error(`${where}: item ${i + 1} is ${describe(m)}, which is not a part of ${word}. It holds: ${Object.keys(allowed).join(", ")}.${hint}`);
    }
    (got[part] = got[part] || []).push(m[keys[0]]);
    if (got[part].length > allowed[part].max) {
      throw new Error(`${where}: \`${part}\` appears ${got[part].length} times. ${word === "chart" ? "A chart" : "The collection"} takes one \`${part}\`; put everything in it.`);
    }
  });
  for (const [part, { min }] of Object.entries(allowed)) {
    if ((got[part]?.length ?? 0) < min) {
      throw new Error(`${where}: needs ${min === 1 ? "a" : `at least ${min}`} \`${part}\`, e.g. ${exampleOf(word)}.`);
    }
  }
  return got;
}

/** `chart [ parts ] settings {}` — one chart. Its build waits for the collection, which knows its position and the shared datasets. */
Transformer.prototype.CHART = container("chart", (list, settings) => {
  const where = settings.id !== undefined ? `chart ${JSON.stringify(settings.id)}` : "chart";
  assertKnownSettings("chart", settings, where);
  const got = collectParts("chart", list, where);
  if (got.plots[0].items.length === 0) throw new Error(`${where}: plots is empty. A chart needs at least one plot, e.g. ${exampleOf("plots")}.`);
  const parts: any = { plots: got.plots[0] };
  for (const p of ["datasets", "axes", "legend", "tooltip"]) if (got[p]) parts[p] = got[p][0];
  return { chart: { parts, settings } };
});

/** `charts [ datasets? chart… ] settings {}` — the program. */
Transformer.prototype.CHARTS = container("charts", (list, settings) => {
  assertKnownSettings("charts", settings);
  const got = collectParts("charts", list, "charts");
  return buildCollection({ datasets: got.datasets?.[0], charts: got.chart }, settings);
});

const PROGRAM_EXAMPLE = "charts [ chart [ plots [ plot kind BAR values [3 5 2] {} ] {} ] {} ] {}";

/**
 * The program's value is its last expression, which must be the `charts` collection. Upstream
 * `options.data` is never spread into it: the envelope is exactly what this program compiled.
 */
Transformer.prototype.PROG = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    const err = ([] as any[]).concat(e0 || []);
    const val = Array.isArray(v0) ? v0[v0.length - 1] : v0;
    if (!err.length && !(isRecord(val) && val.type === "charts")) {
      resume([`A program is one charts collection, ending in \`..\`: e.g. ${PROGRAM_EXAMPLE}..`], {});
      return;
    }
    resume(err, err.length ? {} : val);
  });
};

export const compiler = new Compiler({ langID: "0184", version: "v0.1.0", Checker, Transformer });
