// SPDX-License-Identifier: MIT
/* Copyright (c) 2023, ARTCOMPILER INC */
//
// L0010 inherits L0000: its Checker/Transformer extend L0000's. Dialect-specific
// handlers for the L0010 vocabulary are added here during language design.
// Unhandled tags fall through to L0000's base handlers via the shared Visitor dispatch.
import {
  Checker as BaseChecker,
  Transformer as BaseTransformer,
  Compiler,
} from "@graffiticode/l0000";

const ID_RE = /^\d{3,5}$/;
const MAX_STAGES = 4;

export class Checker extends BaseChecker {
  [key: string]: any;

  // `plan [<id strings>]` — validate every element is a language id, with no
  // duplicates, bounded length. Reject (don't trim) so authors see the issue.
  PLAN(node, options, resume) {
    this.visit(node.elts[0], options, (e0, list) => {
      const err = [].concat(e0);
      const eltIds = (list && list.elts) || [];
      const seen = new Set<string>();
      for (const id of eltIds) {
        const elt = this.nodePool[id];
        const coord = elt?.coord || node.coord || {};
        if (!elt || elt.tag !== "STR") {
          err.push({ message: "plan: each element must be a language id string.", ...coord });
          continue;
        }
        const lang = String(elt.elts[0] ?? "");
        if (!ID_RE.test(lang)) {
          err.push({ message: `plan: "${lang}" is not a language id.`, ...coord });
        } else if (seen.has(lang)) {
          err.push({ message: `plan: duplicate language "${lang}".`, ...coord });
        } else {
          seen.add(lang);
        }
      }
      if (eltIds.length > MAX_STAGES) {
        err.push({ message: `plan: at most ${MAX_STAGES} stages.`, ...(node.coord || {}) });
      }
      resume(err, node);
    });
  }
}

export class Transformer extends BaseTransformer {
  [key: string]: any;

  // Evaluate the list of id strings to { langs: [...] }. Base PROG returns this
  // as the program's data, so no PROG override is needed.
  PLAN(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      const langs = Array.isArray(v0) ? v0.map((s) => String(s)) : [];
      resume(e0, { langs });
    });
  }
}

export const compiler = new Compiler({
  langID: "0010",
  version: "v0.0.1",
  Checker,
  Transformer,
});
