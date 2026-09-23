// SPDX-License-Identifier: MIT
/* Copyright (c) 2026, ARTCOMPILER INC */
//
// L0183 inherits L0000: its Checker/Transformer extend L0000's. Attribute and setting handlers
// are GENERATED from the tables in `attributes.ts` — never hand-write one. Only the three
// containers (CONCEPT_WEB, NODES, EDGES) and PROG are written out, because each assembles
// something the tables cannot express. Unhandled tags fall through to L0000's handlers.
import {
  Checker as BaseChecker,
  Transformer as BaseTransformer,
  Compiler,
} from "@graffiticode/l0000";

import {
  assertKnownAttributes,
  assertKnownSettings,
  attributeFields,
  checkValue,
  configFields,
  mergeAttributes,
  toPlainObject,
  wordOf,
} from "./attributes.js";
import { buildWeb, type Members } from "./web.js";

const message = (e: any): string => String((e && e.message) || e);
const isRecord = (v: any): boolean => v !== null && typeof v === "object" && !Array.isArray(v);

/* ------------------------------------------------------------------ Checker */

export class Checker extends BaseChecker {
  [key: string]: any;
}

const checkChild = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any) => resume(([] as any[]).concat(e0 || []), node));
};

// An arity-2 word must walk BOTH children. `elts[1]` is the configuration record, or the rest
// of the chain building it, so a method that walked only `elts[0]` would silently drop every
// error below it.
const checkBoth = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any) => {
    this.visit(node.elts[1], options, (e1: any) =>
      resume(([] as any[]).concat(e0 || [], e1 || []), node),
    );
  });
};

// The Checker only walks the tree. Value validation lives in the Transformer — `Checker.LIST`
// visits just `elts[0]`, so a rule written here would fire on the first element of a list and
// nowhere else, which in a list-based style is almost nowhere.
for (const name of Object.keys(attributeFields)) Checker.prototype[name] = checkChild;
for (const name of Object.keys(configFields)) Checker.prototype[name] = checkBoth;
Checker.prototype.CONCEPT_WEB = checkBoth;
Checker.prototype.NODES = checkBoth;
Checker.prototype.EDGES = checkBoth;

/* -------------------------------------------------------------- Transformer */

export class Transformer extends BaseTransformer {
  [key: string]: any;
}

/** Attributes, arity 1: evaluate to a single-key record; whatever encloses them merges. */
for (const [name, meta] of Object.entries(attributeFields)) {
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

/**
 * Settings, arity 2: take the value AND the rest of the chain, and return the chain's record
 * with this key added. That is what lets `] title "…" theme DARK {}` build a configuration
 * record without brackets, terminating in the record literal.
 */
for (const [name, meta] of Object.entries(configFields)) {
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
              `${word}: settings must end in a record — write \`{}\` after the last one, e.g. ] ${word} … {}.`,
            ),
            {},
          );
          return;
        }
        if (Object.prototype.hasOwnProperty.call(rest, meta.field)) {
          resume(err.concat(`${word}: is given twice. Each setting may appear once.`), {});
          return;
        }
        resume(err, { ...rest, [meta.field]: value });
      });
    });
  };
}

/**
 * A member list: its children, kept as a sequence, and its configuration record.
 *
 * Returned as a single-key record so `concept-web`'s attribute list merges it like any other
 * attribute. The children are NOT merged here — `buildWeb` does that, because resolving an
 * edge needs every node in hand, and numbering needs each child's position.
 */
function memberList(word: string, example: string) {
  return function (this: any, node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      this.visit(node.elts[1], options, (e1: any, v1: any) => {
        const err = ([] as any[]).concat(e0 || [], e1 || []);
        const items = toPlainObject(v0);
        const settings = toPlainObject(v1);
        if (!Array.isArray(items)) {
          resume(err.concat(`${word}: expected a list in [brackets], e.g. ${example}.`), {});
          return;
        }
        if (!isRecord(settings)) {
          resume(
            err.concat(
              `${word}: needs its settings after the list, ending in a record — write \`{}\` when there are none, e.g. ${example}.`,
            ),
            {},
          );
          return;
        }
        try {
          assertKnownSettings(word, settings);
          const members: Members = { items, settings };
          resume(err, { [word]: members });
        } catch (e) {
          resume(err.concat(message(e)), {});
        }
      });
    });
  };
}

Transformer.prototype.NODES = memberList("nodes", 'nodes [ [text "Nucleus"] [text "Ribosome"] ] {}');
Transformer.prototype.EDGES = memberList(
  "edges",
  'edges [ [from "hub" to "Nucleus" label "contains"] ] {}',
);

/**
 * `concept-web [structure] {settings}` — the program.
 *
 * The attribute list says what the diagram is (`hub`, `nodes`, `edges`); the configuration
 * record says how it is presented (`title`, `instructions`, `theme`).
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
        const web = mergeAttributes(
          toPlainObject(v0),
          "concept-web",
          'concept-web [ hub [text "The Cell"] nodes [ [text "Nucleus"] ] {} ] {}',
        );
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
          'A program is one concept web: concept-web [ hub [ … ] nodes [ … ] {} ] {}.. — ' +
            'e.g. concept-web [ hub [text "The Cell"] nodes [ [text "Nucleus"] ] {} ] {}..',
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
