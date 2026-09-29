// SPDX-License-Identifier: MIT
/* Copyright (c) 2026, ARTCOMPILER INC */
//
// L0181 inherits L0000: its Checker/Transformer extend L0000's, adding a handler per L0181
// word and overriding PROG. Unhandled tags fall through to L0000's base handlers via the
// shared Visitor dispatch.
//
// Where validation lives: the Checker only walks the tree. `Checker.LIST` visits `elts[0]`
// alone, so a rule written there would fire on the first pair of the deck and nowhere else —
// which is almost nowhere, in a language whose one container is a list. Value checking
// therefore happens in the Transformer, where the whole resolved value is in hand.
import {
  Checker as BaseChecker,
  Transformer as BaseTransformer,
  Compiler,
} from "@graffiticode/l0000";

import { asString, cardsFromPairs, toPlainObject } from "./cards.js";

/* ------------------------------------------------------------------ Checker */

export class Checker extends BaseChecker {
  [key: string]: any;

  /**
   * The one rule whose argument is a direct child, so a Checker rule does fire on it.
   *
   * Note the parenthesization: l0003 has this as `(v0.tag === "TAG" && v0.elts[0] === "DARK")
   * || v0.elts[0] === "LIGHT"`, which accepts any value at all whose `elts[0]` is "LIGHT".
   */
  THEME(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (_e0: any, v0: any) => {
      // elts[1] is the REST of the program, so it has to be walked too — otherwise a Checker
      // error anywhere inside a chain that `theme` happens to wrap is silently dropped.
      this.visit(node.elts[1], options, async (e1: any) => {
        const rest = ([] as any[]).concat(e1 || []);
        const node0 = this.nodePool[node.elts[0]];
        const ok = v0?.tag === "TAG" && (v0.elts[0] === "DARK" || v0.elts[0] === "LIGHT");
        if (ok) {
          resume(rest, node);
          return;
        }
        // In the Checker a literal is still its node, so name it the way it was written
        // rather than letting a record stringify to "[object Object]".
        const got =
          v0?.tag === "TAG"
            ? `tag ${v0.elts[0]}`
            : v0?.tag === "STR"
              ? JSON.stringify(v0.elts[0])
              : v0?.tag === "NUM"
                ? String(v0.elts[0])
                : (v0?.tag ?? String(v0)).toLowerCase();
        resume(
          rest.concat({
            message: `theme: expected the tag DARK or LIGHT. Got ${got}.`,
            ...node0.coord,
          }),
          node,
        );
      });
    });
  }
}

/** Walk both children and carry their errors up. */
const checkBoth = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any) => {
    this.visit(node.elts[1], options, (e1: any) =>
      resume(([] as any[]).concat(e0 || [], e1 || []), node),
    );
  });
};

Checker.prototype.CARDS = checkBoth;
Checker.prototype.TITLE = checkBoth;
Checker.prototype.INSTRUCTIONS = checkBoth;

/* -------------------------------------------------------------- Transformer */

export class Transformer extends BaseTransformer {
  [key: string]: any;

  /**
   * The deck, then the rest of the chain. Every other word contributes one field to the
   * record it is handed; this one contributes the cards and closes the program.
   */
  CARDS(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      this.visit(node.elts[1], options, async (e1: any, v1: any) => {
        const err = ([] as any[]).concat(e0 || [], e1 || []);
        const { cards, error } = cardsFromPairs(v0);
        if (error) {
          resume(err.concat(error), {});
          return;
        }
        resume(err, { ...(toPlainObject(v1) || {}), cards });
      });
    });
  }

  TITLE(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      this.visit(node.elts[1], options, async (e1: any, v1: any) => {
        const err = ([] as any[]).concat(e0 || [], e1 || []);
        const title = asString("title", v0, 'title "Spanish Vocab"');
        if (typeof title !== "string") {
          resume(err.concat(title.error), toPlainObject(v1) || {});
          return;
        }
        resume(err, { ...(toPlainObject(v1) || {}), title });
      });
    });
  }

  INSTRUCTIONS(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      this.visit(node.elts[1], options, async (e1: any, v1: any) => {
        const err = ([] as any[]).concat(e0 || [], e1 || []);
        const instructions = asString(
          "instructions",
          v0,
          'instructions "Flip each card to reveal the answer."',
        );
        if (typeof instructions !== "string") {
          resume(err.concat(instructions.error), toPlainObject(v1) || {});
          return;
        }
        resume(err, { ...(toPlainObject(v1) || {}), instructions });
      });
    });
  }

  THEME(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      this.visit(node.elts[1], options, async (e1: any, v1: any) => {
        const err = ([] as any[]).concat(e0 || [], e1 || []);
        resume(err, { ...(toPlainObject(v1) || {}), theme: v0?.tag?.toLowerCase?.() ?? v0 });
      });
    });
  }

  /**
   * The program result IS the data — no `_` wrapper. `data` merges last, so the learner's
   * state (which card, which marks) rides over the compiled deck on every recompile.
   *
   * `v0.pop()` keeps only the last top-level expression, which is what makes `let` bindings
   * above the deck work as bindings rather than as output.
   */
  PROG(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      const data = options?.data || {};
      const val = v0.pop();
      const isObject = typeof val === "object" && val !== null && !Array.isArray(val);
      resume(e0, isObject ? { ...val, ...data } : val);
    });
  }
}

export const compiler = new Compiler({
  langID: "0181",
  version: "v0.0.1",
  Checker,
  Transformer,
});
