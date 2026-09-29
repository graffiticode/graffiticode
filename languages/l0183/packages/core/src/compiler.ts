// SPDX-License-Identifier: MIT
/* Copyright (c) 2026, ARTCOMPILER INC */
//
// L0183 inherits L0000: its Checker/Transformer extend L0000's. Word handlers are GENERATED
// from the tables in `attributes.ts` — never hand-write one. Only the three containers
// (CONCEPT_WEB, NODES, EDGES) and PROG are written out, because each assembles something the
// tables cannot express. Unhandled tags fall through to L0000's handlers.
import {
  Checker as BaseChecker,
  Transformer as BaseTransformer,
  Compiler,
} from "@graffiticode/l0000";

import {
  assertKnownAttributes,
  assertKnownSettings,
  assessFields,
  chainFields,
  checkValue,
  isRecord,
  memberExample,
  memberFields,
  mergeAttributes,
  showValue,
  sourceWord,
  toPlainObject,
  validSettings,
  wordOf,
} from "./attributes.js";
import { buildWeb, type Members } from "./web.js";

const message = (e: any): string => String((e && e.message) || e);

/* ------------------------------------------------------------------ Checker */

export class Checker extends BaseChecker {
  [key: string]: any;
}

const checkNone = function (this: any, node: any, _options: any, resume: any) {
  resume([], node);
};

const checkChild = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any) => resume(([] as any[]).concat(e0 || []), node));
};

// An arity-2 word must walk BOTH children. `elts[1]` is the rest of the chain, so a method
// that walked only `elts[0]` would silently drop every error below it.
const checkBoth = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any) => {
    this.visit(node.elts[1], options, (e1: any) =>
      resume(([] as any[]).concat(e0 || [], e1 || []), node),
    );
  });
};

// The Checker only walks the tree. Value validation lives in the Transformer — `Checker.LIST`
// visits just `elts[0]`, so a rule written here would fire on the first element of a list and
// nowhere else.
for (const name of Object.keys(chainFields)) Checker.prototype[name] = checkBoth;
for (const name of Object.keys(memberFields)) Checker.prototype[name] = checkChild;
for (const [name, meta] of Object.entries(assessFields)) {
  Checker.prototype[name] = meta.expects === "flag" ? checkNone : checkChild;
}
Checker.prototype.CONCEPT_WEB = checkBoth;
Checker.prototype.NODES = checkBoth;
Checker.prototype.EDGES = checkBoth;

/* -------------------------------------------------------------- Transformer */

export class Transformer extends BaseTransformer {
  [key: string]: any;
}

/** An example chain for a word, for the "must end in a record" error. */
const chainExample = (word: string): string => {
  const owner = Object.keys(validSettings).find((c) => validSettings[c].includes(word));
  if (owner === "concept-web") return `] ${word} … {}`;
  if (owner) return `${owner} [ … ] ${word} ${owner === "edges" ? "bottom" : "left"} {}`;
  return `node ${word} … {}`;
};

/**
 * Chain words, arity 2: take the value AND the rest of the chain, and return the chain's record
 * with this key added. `text "Nucleus" color "blue" {}` computes `{text, color}`, terminating
 * in the record literal.
 */
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
            err.concat(
              `${word}: a chain must end in a record — write \`{}\` after the last word, e.g. ${chainExample(word)}. Got ${showValue(rest)}.`,
            ),
            {},
          );
          return;
        }
        if (Object.prototype.hasOwnProperty.call(rest, meta.field)) {
          resume(err.concat(`${word}: is given twice. Each word may appear once in a chain.`), {});
          return;
        }
        resume(err, { ...rest, [meta.field]: value });
      });
    });
  };
}

/** Typed members, arity 1: `node <chain>` evaluates to `{node: {...}}`. */
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

/** The words of `assess [...]`: single-key records the list merges. Flags take no argument. */
for (const [name, meta] of Object.entries(assessFields)) {
  Transformer.prototype[name] =
    meta.expects === "flag"
      ? function (this: any, _node: any, _options: any, resume: any) {
          resume([], { [meta.field]: true });
        }
      : function (this: any, node: any, options: any, resume: any) {
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

/** A misplaced member, as written. */
const describe = (m: any): string => {
  if (isRecord(m)) {
    const keys = Object.keys(m);
    if (!keys.length) return "a stray `{}` — a chain ends in exactly one `{}`";
    if (keys.length === 1) return article(sourceWord(keys[0]));
  }
  return showValue(m);
};

/**
 * A member list: its typed children, kept as a sequence, and its settings record.
 *
 * Returned as a single-key record so `concept-web`'s child list merges it like its other
 * children. The children are NOT assembled here — `buildWeb` does that, because resolving an
 * edge needs every node in hand, and numbering needs each child's position.
 */
function memberList(word: string, member: string) {
  const example = `${word} [ ${memberExample(member)} ] {}`;
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
          resume([`${word}: expected a list in [brackets], e.g. ${example}.`], {});
          return;
        }
        if (!isRecord(settings)) {
          resume(
            [
              `${word}: needs its settings after the list, ending in a record — write \`{}\` when there are none, e.g. ${example}.`,
            ],
            {},
          );
          return;
        }
        const items: any[] = [];
        try {
          for (let i = 0; i < list.length; i++) {
            const m = list[i];
            const keys = isRecord(m) ? Object.keys(m) : [];
            if (keys.length !== 1 || keys[0] !== member) {
              throw new Error(
                `${word}: member ${i + 1} is ${describe(m)}, not ${article(member)}. Every member is written ${memberExample(member)}.`,
              );
            }
            // Checked here, member by member, so a word that ended a chain early (an arity-1
            // word like `points` leaves the chain's `{}` stranded as the next member) is
            // reported where it was written, not as the stray `{}` after it.
            assertKnownAttributes(member, m[member], `${member} ${i + 1}`);
            items.push(m[member]);
          }
          assertKnownSettings(word, settings);
          const members: Members = { items, settings };
          resume([], { [word]: members });
        } catch (e) {
          resume([message(e)], {});
        }
      });
    });
  };
}

Transformer.prototype.NODES = memberList("nodes", "node");
Transformer.prototype.EDGES = memberList("edges", "edge");

const WEB_EXAMPLE = 'concept-web [ hub text "The Cell" {} nodes [ node text "Nucleus" {} ] {} ] {}';

/**
 * `concept-web [children] {settings}` — the program.
 *
 * The children say what the diagram is (`hub`, `nodes`, `edges`); the settings record says how
 * it is presented (`title`, `instructions`, `theme`).
 */
Transformer.prototype.CONCEPT_WEB = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    this.visit(node.elts[1], options, (e1: any, v1: any) => {
      const err = ([] as any[]).concat(e0 || [], e1 || []);
      if (err.length) {
        resume(err, {});
        return;
      }
      const settings = toPlainObject(v1);
      if (!isRecord(settings)) {
        resume(
          [
            'concept-web: needs its settings after the list, ending in a record — write `{}` when there are none, e.g. concept-web [ … ] title "…" {}.',
          ],
          {},
        );
        return;
      }
      try {
        const web = mergeAttributes(toPlainObject(v0), "concept-web", WEB_EXAMPLE);
        assertKnownAttributes("concept-web", web);
        assertKnownSettings("concept-web", settings);
        resume([], buildWeb(web, settings, options?.data));
      } catch (e) {
        resume([message(e)], {});
      }
    });
  });
};

/**
 * The program's value is its last expression, with no wrapper.
 *
 * `options.data` is NOT spread over it. The learner's answers are the one thing carried across
 * a recompile, and `buildWeb` takes exactly those — each blank's `value` — so a stale compile
 * riding back in `data` can never shadow a fresh one.
 */
Transformer.prototype.PROG = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    const err = ([] as any[]).concat(e0 || []);
    const val = v0.pop();
    if (!err.length && !(isRecord(val) && val.interaction?.type === "concept-web")) {
      resume(
        [
          `A program is one concept web: concept-web [ hub … {} nodes [ … ] {} ] {}.. — e.g. ${WEB_EXAMPLE}..`,
        ],
        {},
      );
      return;
    }
    resume(err, val);
  });
};

export const compiler = new Compiler({
  langID: "0183",
  version: "v0.0.1",
  Checker,
  Transformer,
});
