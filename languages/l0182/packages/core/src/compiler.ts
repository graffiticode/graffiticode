// SPDX-License-Identifier: MIT
/* Copyright (c) 2026, ARTCOMPILER INC */
//
// L0182 inherits L0000: its Checker/Transformer extend L0000's. Attribute handlers are
// GENERATED from `attributeFields` — never hand-write one. Only the two containers (SURVEY,
// RESPONSE) and PROG are written out, because each has an assembly step the table cannot
// express. Unhandled tags fall through to L0000's handlers.
import {
  Checker as BaseChecker,
  Transformer as BaseTransformer,
  Compiler,
} from "@graffiticode/l0000";

import { attributeFields, checkValue, toPlainObject } from "./attributes.js";
import { loadSurvey } from "./source.js";
import { buildResponse, buildSurvey, readSurveyAttributes } from "./survey.js";

/* ------------------------------------------------------------------ Checker */

export class Checker extends BaseChecker {
  [key: string]: any;
}

const checkChild = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any) => resume(([] as any[]).concat(e0 || []), node));
};

// The Checker only walks the tree. Value validation lives in the Transformer — `Checker.LIST`
// visits just `elts[0]`, so a rule written here would fire on the first element of a list and
// nowhere else, which in a list-based style is almost nowhere.
for (const name of Object.keys(attributeFields)) {
  Checker.prototype[name] = checkChild;
}
Checker.prototype.SURVEY = checkChild;
Checker.prototype.RESPONSE = checkChild;

/* -------------------------------------------------------------- Transformer */

export class Transformer extends BaseTransformer {
  [key: string]: any;
}

/** Attributes: evaluate to a single-key record; whatever encloses them merges. */
for (const [name, meta] of Object.entries(attributeFields)) {
  Transformer.prototype[name] = function (this: any, node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      const err = ([] as any[]).concat(e0 || []);
      const raw = toPlainObject(v0);
      const typeError = checkValue(name, meta, raw);
      if (typeError) {
        resume(err.concat(typeError), {});
        return;
      }
      resume(err, { [meta.field]: raw });
    });
  };
}

/**
 * `response [...]` — evaluates to a single-key record like an attribute, so `survey`'s
 * attribute list merges it in the ordinary way. `buildSurvey` then lifts it back out.
 */
Transformer.prototype.RESPONSE = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    const err = ([] as any[]).concat(e0 || []);
    try {
      resume(err, { response: buildResponse(toPlainObject(v0)) });
    } catch (e: any) {
      resume(err.concat(String((e && e.message) || e)), {});
    }
  });
};

/**
 * `survey [...]` — the program.
 *
 * The attribute list says which survey is being taken and by which session; everything the
 * survey IS comes from `loadSurvey`, which reads it from the back end. That read is
 * asynchronous, and resuming from a promise is how the base language's own `use` fetches a
 * schema at compile time, so it is a supported shape here rather than a liberty being taken.
 */
Transformer.prototype.SURVEY = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    const err = ([] as any[]).concat(e0 || []);
    const raw = toPlainObject(v0);
    let asked: { id: string; sessionId?: string };
    try {
      asked = readSurveyAttributes(raw);
    } catch (e: any) {
      resume(err.concat(String((e && e.message) || e)), {});
      return;
    }
    loadSurvey(asked.id, { sessionId: asked.sessionId }).then(
      (loaded) => {
        try {
          resume(err, buildSurvey(raw, loaded));
        } catch (e: any) {
          resume(err.concat(String((e && e.message) || e)), {});
        }
      },
      (e) => resume(err.concat(String((e && e.message) || e)), {}),
    );
  });
};

/**
 * The program's value is its last expression.
 *
 * `options.data` is deliberately NOT merged in. It used to be, because the React player wrote
 * the participant's answer back through it on every recompile — which also meant the compiler
 * had to unwrap the `{data, errors}` envelope that storage wraps a stored model in, in a loop,
 * because a second layer was observed appearing after the first round trip. That envelope has
 * drawn blood three times across this codebase. Nothing writes back now: the response is
 * authored in code by whoever answers, so the compiled value is the whole model and the
 * envelope cannot reach it.
 *
 * If a data-side response is ever wanted again it comes back as ONE key where data wins over
 * the compiled value — not as a blanket spread, which is what let a stale compile shadow a
 * fresh one.
 */
Transformer.prototype.PROG = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    resume(e0, v0.pop());
  });
};

export const compiler = new Compiler({
  langID: "0182",
  version: "v0.0.1",
  Checker,
  Transformer,
});
