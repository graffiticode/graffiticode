// SPDX-License-Identifier: MIT
/* Copyright (c) 2026, ARTCOMPILER INC */
//
// L0180 inherits L0000: its Checker/Transformer extend L0000's. Attribute handlers are
// GENERATED from `attributeFields` — never hand-write one. Only containers (CHOICE, OPTIONS)
// and PROG are written out, because each has a second argument role or an assembly step the
// table cannot express. Unhandled tags fall through to L0000's base handlers.
import {
  Checker as BaseChecker,
  Transformer as BaseTransformer,
  Compiler,
} from "@graffiticode/l0000";

import {
  attributeFields,
  configFields,
  assertAssessWords,
  assertKnownAttributes,
  checkValue,
  mergeAttributes,
  templateId,
  toPlainObject,
  wordOf,
} from "./attributes.js";
import { buildActivity, resolveConfig } from "./activity.js";
import { resolveSelections, sentenceUnits, wordUnits } from "./hottext.js";
import type { Paragraph, Unit } from "./hottext.js";
import { isAnchored, keepsOrder } from "./anchors.js";
import { optionLabel } from "./labels.js";
import { cut } from "./textentry.js";
import { cut as cutDropdowns, totalPoints } from "./inlinechoice.js";
import { sequence } from "./order.js";
import { pair, type PairWords } from "./pairing.js";
import { fill } from "./gapmatch.js";

/* ------------------------------------------------------------------ Checker */

export class Checker extends BaseChecker {
  [key: string]: any;
}

const checkNothing = function (this: any, node: any, options: any, resume: any) {
  resume([], node);
};

const checkChild = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any) => resume(([] as any[]).concat(e0 || []), node));
};

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
for (const [name, meta] of Object.entries(attributeFields)) {
  Checker.prototype[name] = meta.flag ? checkNothing : checkChild;
}
Checker.prototype.CHOICE = checkChild;
Checker.prototype.OPTIONS = checkBoth;
Checker.prototype.HOTTEXT = checkChild;
Checker.prototype.SELECTIONS = checkBoth;
Checker.prototype.EXTENDED_TEXT = checkChild;
Checker.prototype.RUBRIC = checkBoth;
Checker.prototype.TEXT_ENTRY = checkChild;
Checker.prototype.BLANKS = checkBoth;
Checker.prototype.RESPONSES = checkBoth;
Checker.prototype.INLINE_CHOICE = checkChild;
Checker.prototype.DROPDOWNS = checkBoth;
Checker.prototype.ORDER = checkChild;
Checker.prototype.ELEMENTS = checkBoth;
Checker.prototype.MATCH = checkChild;
Checker.prototype.TARGETS = checkBoth;
Checker.prototype.MATCH_ITEMS = checkBoth;
Checker.prototype.CLASSIFICATION = checkChild;
Checker.prototype.CATEGORIES = checkBoth;
Checker.prototype.CLASSIFICATION_ITEMS = checkBoth;
Checker.prototype.GAP_MATCH = checkChild;
Checker.prototype.TOKENS = checkBoth;
Checker.prototype.GAPS = checkBoth;
// A config word is arity 2, and `elts[1]` is the rest of the chain — a method that walked only
// `elts[0]` would silently drop every error below it.
for (const name of Object.keys(configFields)) {
  Checker.prototype[name] = checkBoth;
}
Checker.prototype.ITEMS = checkBoth;
Checker.prototype.ITEM = checkChild;
Checker.prototype.PARTS = checkBoth;

/* -------------------------------------------------------------- Transformer */

export class Transformer extends BaseTransformer {
  [key: string]: any;
}

for (const [name, meta] of Object.entries(attributeFields)) {
  if (meta.flag) {
    // Arity 0: nothing to visit, presence is the value.
    Transformer.prototype[name] = function (node: any, options: any, resume: any) {
      resume([], { [meta.field]: true });
    };
    continue;
  }
  Transformer.prototype[name] = function (this: any, node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      const err = ([] as any[]).concat(e0 || []);
      const raw = toPlainObject(v0);
      const typeError = checkValue(name, meta, raw);
      if (typeError) {
        resume(err.concat(typeError), {});
        return;
      }
      let value: any = raw;
      if (meta.shape === "object") {
        try {
          const word = wordOf(name);
          const attrs = mergeAttributes(raw, word);
          assertKnownAttributes(word, attrs);
          value = attrs;
        } catch (e: any) {
          resume(err.concat(String((e && e.message) || e)), {});
          return;
        }
      }
      resume(err, { [meta.field]: value });
    });
  };
}

/* ------------------------------------------------------------- Option ids */

// Derived ids live in `labels.ts` so `inlinechoice.ts` can hand out the same ones without
// importing the compiler. Re-exported here because that is where callers have always found it.
export { optionLabel };

/**
 * Whether a list is presented in a random order.
 *
 * Randomizing is the default: a fixed order is a scoring artifact, since position bias is real
 * and a key that sits in the same slot is learnable. What the author wrote always wins, in
 * either direction; `keepsOrder` only decides the case where they wrote nothing, and it reads
 * the UNANCHORED options — a numeric list ending in "None of the above" is still a numeric
 * list, and the anchor is pinned separately.
 */
function resolveShuffle(authored: unknown, options: { text: string; anchored?: true }[]): boolean {
  if (typeof authored === "boolean") return authored;
  return !keepsOrder(options.filter((o) => !o.anchored).map((o) => o.text));
}

/**
 * True when EVERY dropdown in a sentence is a list whose order is already information.
 *
 * One flag covers the whole interaction, so a sentence mixing an ordered menu with an
 * unordered one has to choose. It shuffles: leaving every menu fixed to protect one of them
 * gives up the randomization on all the others, and the author who wanted the ordered menu
 * left alone can say `shuffle false`.
 */
function menusKeepOrder(segments: any[]): boolean {
  const menus = segments.filter((s: any) => s.choice).map((s: any) => s.options ?? []);
  if (!menus.length) return false;
  return menus.every((opts: any[]) =>
    keepsOrder(opts.filter((o: any) => !o.anchored).map((o: any) => String(o.text ?? ""))),
  );
}

/* ------------------------------------------------------------- Containers */

/**
 * A member list: option attribute lists plus this container's own configuration record.
 * Each element is merged and checked on its own; nothing merges the elements together.
 */
Transformer.prototype.OPTIONS = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    this.visit(node.elts[1], options, (e1: any, v1: any) => {
      const err = ([] as any[]).concat(e0 || [], e1 || []);
      const raw = toPlainObject(v0);
      if (!Array.isArray(raw)) {
        resume(
          err.concat('options: expected a list of options, e.g. options [[text "A"] [text "B"]] {}.'),
          {},
        );
        return;
      }
      try {
        const opts = raw.map((entry: any, i: number) => {
          const opt = mergeAttributes(entry, `option ${i + 1}`);
          assertKnownAttributes("option", opt);
          return opt;
        });
        resume(err, { ...(toPlainObject(v1) || {}), options: opts });
      } catch (e: any) {
        resume(err.concat(String((e && e.message) || e)), {});
      }
    });
  });
};

/**
 * A member list of selections — the same shape as OPTIONS, and merged the same way.
 */
Transformer.prototype.SELECTIONS = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    this.visit(node.elts[1], options, (e1: any, v1: any) => {
      const err = ([] as any[]).concat(e0 || [], e1 || []);
      const raw = toPlainObject(v0);
      if (!Array.isArray(raw)) {
        resume(
          err.concat('selections: expected a list of selections, e.g. selections [[quote "…" assess [correct]]] {}.'),
          {},
        );
        return;
      }
      try {
        const sels = raw.map((entry: any, i: number) => {
          const sel = mergeAttributes(entry, `selection ${i + 1}`);
          assertKnownAttributes("selection", sel);
          return sel;
        });
        resume(err, { ...(toPlainObject(v1) || {}), selections: sels });
      } catch (e: any) {
        resume(err.concat(String((e && e.message) || e)), {});
      }
    });
  });
};

/**
 * Assemble a hottext once its units are known.
 *
 * Shared because the units come from two places: an interaction carrying its own `text` has
 * them immediately, while one selecting `within "stimulus"` cannot — children transform before
 * parents, so the stimulus does not exist when HOTTEXT runs, and ITEM finishes those.
 */
function assembleHottext(attrs: any, units: Unit[], where: string) {
  const { mapping, feedback, correctIds } = resolveSelections(units, attrs.selections, where);

  const template = attrs.responseProcessing !== undefined ? attrs.responseProcessing : "map-response";
  const exactSet = template === "match-correct";
  const scored = Object.keys(mapping).length > 0;
  if (scored && !correctIds.length) {
    throw new Error(
      `${where}: no selection is marked \`correct\`, so the item cannot be scored. ` +
        "Add `assess [correct]` to the right one, or remove every `assess` for an unscored item.",
    );
  }
  if (exactSet && !correctIds.length) {
    throw new Error(
      `${where}: \`response-processing "match-correct"\` scores against the correct set, but no ` +
        "selection is marked `correct`.",
    );
  }

  // Each correct selection is worth its points; `upper-bound` caps the total, which is how
  // "click any three of these five" is expressed — QTI's mapping@upper-bound.
  const sum = correctIds.reduce((n, id) => n + (mapping[id]?.points ?? 0), 0);
  const bounded = attrs.upperBound !== undefined;
  const upperBound = bounded ? attrs.upperBound : sum;
  if (bounded && attrs.upperBound > sum) {
    throw new Error(
      `${where}: upper-bound is ${attrs.upperBound} but the correct selections are only worth ${sum}. ` +
        "Lower `upper-bound`, or mark more selections correct.",
    );
  }

  // How many to click follows from the ceiling: all the correct ones, or the bounded count.
  const maxChoices =
    attrs.maxChoices !== undefined ? attrs.maxChoices : bounded ? attrs.upperBound : correctIds.length || 1;
  const minChoices = attrs.minChoices !== undefined ? attrs.minChoices : maxChoices;
  if (minChoices > maxChoices) {
    throw new Error(`${where}: min-choices (${minChoices}) is greater than max-choices (${maxChoices}).`);
  }
  if (!bounded && correctIds.length > maxChoices) {
    throw new Error(
      `${where}: ${correctIds.length} selections are marked \`correct\` but max-choices is ${maxChoices}. ` +
        "Raise `max-choices`, or set `upper-bound` to ask for that many of them.",
    );
  }

  return {
    interaction: {
      type: "hottext",
      ...(attrs.prompt !== undefined ? { prompt: attrs.prompt } : {}),
      granularity: attrs.granularity !== undefined ? attrs.granularity : "sentence",
      minChoices,
      maxChoices,
      units,
    },
    validation: {
      responseProcessing: templateId(template),
      cardinality: maxChoices > 1 ? "multiple" : "single",
      baseType: "identifier",
      points: exactSet ? 1 : Math.min(sum, upperBound),
      ...(exactSet ? { correctResponse: correctIds } : { mapping }),
      ...(bounded && !exactSet ? { upperBound } : {}),
      ...(Object.keys(feedback).length ? { feedback } : {}),
    },
  };
}

/**
 * A hottext interaction: a passage cut into clickable sentences or words.
 *
 * When it carries its own `text` it resolves here. When it says `within "stimulus"` it cannot —
 * the stimulus is a sibling of `parts` inside `item`, and children transform first — so it
 * emits a `pending` sibling that ITEM consumes. PROG rejects one that never got resolved.
 */
Transformer.prototype.HOTTEXT = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    const err = ([] as any[]).concat(e0 || []);
    try {
      const attrs = mergeAttributes(toPlainObject(v0), "hottext");
      assertKnownAttributes("hottext", attrs);

      if (!Array.isArray(attrs.selections) || !attrs.selections.length) {
        throw new Error(
          'hottext: needs at least one selection, e.g. selections [[quote "…" assess [correct]]] {}.',
        );
      }
      const hasText = attrs.text !== undefined;
      const hasWithin = attrs.within !== undefined;
      if (hasText && hasWithin) {
        throw new Error(
          "hottext: takes `text` or `within`, not both. `text` gives it its own passage; " +
            '`within "stimulus"` selects inside the item\'s passage.',
        );
      }
      if (!hasText && !hasWithin) {
        throw new Error(
          "hottext: needs the text it selects within — either its own `text \"…\"`, or " +
            '`within "stimulus"` to use the passage of the item it is a part of.',
        );
      }

      if (hasWithin) {
        // Deferred. ITEM has the stimulus and will finish this.
        resume(err, { pending: { scope: attrs.within, attrs } });
        return;
      }

      const granularity = attrs.granularity !== undefined ? attrs.granularity : "sentence";
      const units =
        granularity === "word"
          ? wordUnits(attrs.text)
          : sentenceUnits([{ id: "p1", text: attrs.text }]);
      if (!units.length) {
        throw new Error("hottext: `text` is empty, so there is nothing to select.");
      }
      resume(err, assembleHottext(attrs, units, "hottext"));
    } catch (e: any) {
      resume(err.concat(String((e && e.message) || e)), {});
    }
  });
};

/**
 * A member list of rubric bands — the same shape as OPTIONS and SELECTIONS.
 */
Transformer.prototype.RUBRIC = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    this.visit(node.elts[1], options, (e1: any, v1: any) => {
      const err = ([] as any[]).concat(e0 || [], e1 || []);
      const raw = toPlainObject(v0);
      if (!Array.isArray(raw)) {
        resume(
          err.concat('rubric: expected a list of bands, e.g. rubric [[score 2 descriptor "…"]] {}.'),
          {},
        );
        return;
      }
      try {
        const bands = raw.map((entry: any, i: number) => {
          const band = mergeAttributes(entry, `band ${i + 1}`);
          assertKnownAttributes("band", band);
          return band;
        });
        resume(err, { ...(toPlainObject(v1) || {}), rubric: bands });
      } catch (e: any) {
        resume(err.concat(String((e && e.message) || e)), {});
      }
    });
  });
};

/**
 * A member list of blanks — the same shape as OPTIONS, SELECTIONS and RUBRIC.
 */
Transformer.prototype.BLANKS = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    this.visit(node.elts[1], options, (e1: any, v1: any) => {
      const err = ([] as any[]).concat(e0 || [], e1 || []);
      const raw = toPlainObject(v0);
      if (!Array.isArray(raw)) {
        resume(
          err.concat(
            'blanks: expected a list of blanks, e.g. blanks [[id "capital" responses [...] {}]] {}.',
          ),
          {},
        );
        return;
      }
      try {
        const bs = raw.map((entry: any, i: number) => {
          const b = mergeAttributes(entry, `blank ${i + 1}`);
          assertKnownAttributes("blank", b);
          return b;
        });
        resume(err, { ...(toPlainObject(v1) || {}), blanks: bs });
      } catch (e: any) {
        resume(err.concat(String((e && e.message) || e)), {});
      }
    });
  });
};

/**
 * A member list of the answers one blank recognizes, each with its own `assess` — the same
 * shape as the options of a choice, which is the point of the whole arrangement.
 */
Transformer.prototype.RESPONSES = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    this.visit(node.elts[1], options, (e1: any, v1: any) => {
      const err = ([] as any[]).concat(e0 || [], e1 || []);
      const raw = toPlainObject(v0);
      if (!Array.isArray(raw)) {
        resume(
          err.concat(
            'responses: expected a list of answers, e.g. responses [[response "Paris" assess [correct]]] {}.',
          ),
          {},
        );
        return;
      }
      try {
        const rs = raw.map((entry: any, i: number) => {
          const r = mergeAttributes(entry, `response ${i + 1}`);
          assertKnownAttributes("response", r);
          return r;
        });
        resume(err, { ...(toPlainObject(v1) || {}), responses: rs });
      } catch (e: any) {
        resume(err.concat(String((e && e.message) || e)), {});
      }
    });
  });
};

/**
 * A sentence with blanks the candidate types into.
 *
 * The marker `{{<id>}}` positions a blank and names it, so the answer binds BY NAME — QTI's
 * response-identifier model, where an inline interaction binds to a sibling response
 * declaration. Learnosity's `{{response}}` carries no identity and matches its answers by
 * order, which is what makes reordering a clause silently rebind every answer after it.
 *
 * Always `map_response`: each blank is worth one point, so several blanks give partial credit.
 * All-or-nothing across blanks is a conjunctive item around it, the same way a single-part
 * hottext gets its 1/0.
 */
Transformer.prototype.TEXT_ENTRY = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    const err = ([] as any[]).concat(e0 || []);
    try {
      const attrs = mergeAttributes(toPlainObject(v0), "text-entry");
      assertKnownAttributes("text-entry", attrs);

      if (typeof attrs.text !== "string" || !attrs.text.trim()) {
        throw new Error(
          'text-entry: needs the sentence it blanks out, e.g. text "The capital of France is ' +
            '{{capital}}." Put {{<id>}} where each answer goes.',
        );
      }
      if (!Array.isArray(attrs.blanks) || !attrs.blanks.length) {
        throw new Error(
          'text-entry: needs at least one blank, e.g. ' +
            'blanks [[id "capital" responses [[response "Paris" assess [correct]]] {}]] {}.',
        );
      }

      const { segments, mapping } = cut(
        attrs.text,
        attrs.blanks,
        attrs.caseSensitive === true,
        "text-entry",
      );

      resume(err, {
        interaction: {
          type: "text-entry",
          ...(attrs.prompt !== undefined ? { prompt: attrs.prompt } : {}),
          segments,
        },
        validation: {
          responseProcessing: "map_response",
          // Cardinality stays here because it does not vary: every blank takes one typed value.
          // `baseType` DOES vary, so it rides on each mapping entry instead — a text-entry has
          // one response variable per blank, and in QTI each carries its own declaration.
          cardinality: "single",
          // Each blank contributes its own best correct answer; the interaction is their sum.
          points: Object.values(mapping).reduce((n: number, e: any) => n + e.points, 0),
          mapping,
        },
      });
    } catch (e: any) {
      resume(err.concat(String((e && e.message) || e)), {});
    }
  });
};

/**
 * A member list of the dropdowns in a sentence, each named by the marker that positions it.
 *
 * The same skeleton as `BLANKS`, because it is the same construct: a named hole. What a hole
 * holds is the only difference, and that lives one level down.
 */
Transformer.prototype.DROPDOWNS = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    this.visit(node.elts[1], options, (e1: any, v1: any) => {
      const err = ([] as any[]).concat(e0 || [], e1 || []);
      const raw = toPlainObject(v0);
      if (!Array.isArray(raw)) {
        resume(
          err.concat(
            'dropdowns: expected a list of dropdowns, e.g. dropdowns [[id "gas" options [...] {}]] {}.',
          ),
          {},
        );
        return;
      }
      try {
        const ds = raw.map((entry: any, i: number) => {
          const d = mergeAttributes(entry, `dropdown ${i + 1}`);
          assertKnownAttributes("dropdown", d);
          return d;
        });
        resume(err, { ...(toPlainObject(v1) || {}), dropdowns: ds });
      } catch (e: any) {
        resume(err.concat(String((e && e.message) || e)), {});
      }
    });
  });
};

/**
 * A sentence with dropdowns: QTI's inline-choice interaction.
 *
 * Half text-entry and half choice, deliberately. The sentence, the `{{id}}` markers and the
 * cross-checks over them are text-entry's, shared through `cutMarkers` — a dropdown is a named
 * hole in a sentence, exactly as a blank is. What fills the hole is choice's: the response is
 * an option the candidate SELECTED, so `baseType` is `identifier` and an option carries the
 * same `assess` a multiple-choice option does.
 *
 * Always `map_response`, and for text-entry's reason: each dropdown is worth its own points, so
 * a sentence with three holes gives partial credit. All-or-nothing across them is a conjunctive
 * item around it.
 */
Transformer.prototype.INLINE_CHOICE = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    const err = ([] as any[]).concat(e0 || []);
    try {
      const attrs = mergeAttributes(toPlainObject(v0), "inline-choice");
      assertKnownAttributes("inline-choice", attrs);

      if (typeof attrs.text !== "string" || !attrs.text.trim()) {
        throw new Error(
          'inline-choice: needs the sentence its dropdowns sit in, e.g. text "Plants absorb ' +
            '{{gas}} and release oxygen." Put {{<id>}} where each dropdown goes.',
        );
      }
      if (!Array.isArray(attrs.dropdowns) || !attrs.dropdowns.length) {
        throw new Error(
          "inline-choice: needs at least one dropdown, e.g. " +
            'dropdowns [[id "gas" options [[text "carbon dioxide" assess [correct]]] {}]] {}.',
        );
      }

      const { segments, mapping } = cutDropdowns(attrs.text, attrs.dropdowns, "inline-choice");

      resume(err, {
        interaction: {
          type: "inline-choice",
          ...(attrs.prompt !== undefined ? { prompt: attrs.prompt } : {}),
          // One flag for the interaction, applying to every dropdown in the sentence — the
          // arrangement `case-sensitive` already has on `text-entry`. Each menu still shuffles
          // independently; what is shared is the decision, not the order.
          shuffle: typeof attrs.shuffle === "boolean" ? attrs.shuffle : !menusKeepOrder(segments),
          segments,
        },
        validation: {
          responseProcessing: "map_response",
          // Cardinality does not vary: every dropdown takes one selection. `baseType` rides on
          // each mapping entry, as text-entry's does — one response variable per hole, and in
          // QTI each carries its own declaration.
          cardinality: "single",
          points: totalPoints(mapping),
          mapping,
        },
      });
    } catch (e: any) {
      resume(err.concat(String((e && e.message) || e)), {});
    }
  });
};

/**
 * A member list of the things an order interaction sequences.
 *
 * The list order is the PRESENTATION order — what the candidate is shown before touching
 * anything. `ORDER` explains why it cannot also be the answer.
 */
Transformer.prototype.ELEMENTS = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    this.visit(node.elts[1], options, (e1: any, v1: any) => {
      const err = ([] as any[]).concat(e0 || [], e1 || []);
      const raw = toPlainObject(v0);
      if (!Array.isArray(raw)) {
        resume(
          err.concat(
            'elements: expected a list of elements, e.g. elements [[text "First" assess [position 1]]] {}.',
          ),
          {},
        );
        return;
      }
      try {
        const els = raw.map((entry: any, i: number) => {
          const el = mergeAttributes(entry, `element ${i + 1}`);
          assertKnownAttributes("element", el);
          return el;
        });
        resume(err, { ...(toPlainObject(v1) || {}), elements: els });
      } catch (e: any) {
        resume(err.concat(String((e && e.message) || e)), {});
      }
    });
  });
};

/**
 * Put these in the right order: QTI's order interaction.
 *
 * The response is a sequence, so `cardinality` is `ordered` and the key is a `correctResponse`
 * listing the ids in the right order. Scoring is all-or-nothing, which is what
 * `match_correct` already means and what a sequence needs — an order with one pair swapped is
 * not most of the way right, and QTI's partial-credit variants for ordering are a mapping over
 * position pairs that nothing in this language would read.
 *
 * Worth one point, the figure `match_correct` fixes for `choice` and `hottext` too. An item
 * that should be worth more wraps it in a conjunctive item, which is what that word is for.
 *
 * **Authored order is presentation order.** See `order.ts` — emitting the elements in their
 * correct order would ship the answer inside `interaction`, where a graded delivery cannot
 * withhold it.
 */
Transformer.prototype.ORDER = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    const err = ([] as any[]).concat(e0 || []);
    try {
      const attrs = mergeAttributes(toPlainObject(v0), "order");
      assertKnownAttributes("order", attrs);

      if (!Array.isArray(attrs.elements) || !attrs.elements.length) {
        throw new Error(
          "order: needs the things to be put in order, e.g. " +
            'elements [[text "First" assess [position 1]] [text "Second" assess [position 2]]] {}.',
        );
      }

      const { elements, correctResponse, interchangeable } = sequence(attrs.elements, "order");

      resume(err, {
        interaction: {
          type: "order",
          ...(attrs.prompt !== undefined ? { prompt: attrs.prompt } : {}),
          // Randomized unless the author says otherwise, and there is no `keepsOrder` case
          // here: an order's elements have no meaningful presentation order by construction —
          // if they did, the question would already be answered.
          shuffle: typeof attrs.shuffle === "boolean" ? attrs.shuffle : true,
          elements,
        },
        validation: {
          responseProcessing: "match_correct",
          // The one place cardinality is neither single nor multiple: the response is a
          // sequence, and two candidates picking the same elements in different orders have not
          // given the same answer.
          cardinality: "ordered",
          baseType: "identifier",
          points: 1,
          correctResponse,
          // Two elements reading the same thing are the same answer wherever each of them
          // lands. Without this the candidate who builds the identical sentence with the two
          // "the"s the other way round earns nothing, and is told nothing about why.
          ...(interchangeable ? { interchangeable } : {}),
        },
      });
    } catch (e: any) {
      resume(err.concat(String((e && e.message) || e)), {});
    }
  });
};

/**
 * A member list for one of the pairing interactions.
 *
 * Four of them — targets, categories, and the items of each — differing only in the word they
 * are checked under and the field they resume. The same skeleton as `OPTIONS`.
 */
function memberList(container: string, field: string, example: string) {
  return function (this: any, node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      this.visit(node.elts[1], options, (e1: any, v1: any) => {
        const err = ([] as any[]).concat(e0 || [], e1 || []);
        const raw = toPlainObject(v0);
        if (!Array.isArray(raw)) {
          resume(err.concat(`${wordOf(field)}: expected a list, e.g. ${example}`), {});
          return;
        }
        try {
          const list = raw.map((entry: any, i: number) => {
            const merged = mergeAttributes(entry, `${container} ${i + 1}`);
            assertKnownAttributes(container, merged);
            return merged;
          });
          resume(err, { ...(toPlainObject(v1) || {}), [field]: list });
        } catch (e: any) {
          resume(err.concat(String((e && e.message) || e)), {});
        }
      });
    });
  };
}

Transformer.prototype.TARGETS = memberList(
  "target",
  "targets",
  'targets [[id "paris" text "Paris"]] {}.',
);
Transformer.prototype.MATCH_ITEMS = memberList(
  "match-item",
  "matchItems",
  'match-items [[text "France" assess [target "paris"]]] {}.',
);
Transformer.prototype.CATEGORIES = memberList(
  "category",
  "categories",
  'categories [[id "mammal" text "Mammal"]] {}.',
);
Transformer.prototype.CLASSIFICATION_ITEMS = memberList(
  "classification-item",
  "classificationItems",
  'classification-items [[text "Whale" assess [category "mammal"]]] {}.',
);

/**
 * Pairing each thing with somewhere it belongs: QTI's match interaction, and the classification
 * built on the same key.
 *
 * The response is a set of PAIRS — QTI's `directedPair`, serialized as the two identifiers with
 * a space between them — so `mapping` is keyed by pairing rather than by option, and the
 * existing `map-response` / `match-correct` dispatch carries over unchanged. What does not
 * carry over is `correct`: the scorer has to require the pairings to be exactly the right ones,
 * because a mapping over pairs enumerates only the correct few out of |items| × |targets|.
 *
 * Worth one point per item by default and summed, the rule `text-entry` uses over its blanks, so
 * a four-item match gives partial credit and a conjunctive item around it does not.
 */
function pairingInteraction(type: string, words: PairWords, listField: string, itemField: string) {
  return function (this: any, node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      const err = ([] as any[]).concat(e0 || []);
      try {
        const attrs = mergeAttributes(toPlainObject(v0), type);
        assertKnownAttributes(type, attrs);

        const places = Array.isArray(attrs[listField]) ? attrs[listField] : [];
        const items = Array.isArray(attrs[itemField]) ? attrs[itemField] : [];
        if (!places.length) {
          throw new Error(
            `${type}: needs its ${words.list}, e.g. ${words.list} [[id "a" text "A"] [id "b" text "B"]] {}.`,
          );
        }
        if (!items.length) {
          throw new Error(
            `${type}: needs its ${words.itemList}, e.g. ` +
              `${words.itemList} [[text "France" assess [${words.key} "a"]]] {}.`,
          );
        }

        const paired = pair(items, places, words);
        const template = attrs.responseProcessing !== undefined ? attrs.responseProcessing : "map-response";
        const exactSet = template === "match-correct";

        resume(err, {
          interaction: {
            type,
            ...(attrs.prompt !== undefined ? { prompt: attrs.prompt } : {}),
            shuffle: resolveShuffle(attrs.shuffle, paired.items),
            items: paired.items,
            [listField]: paired.places,
          },
          validation: {
            responseProcessing: templateId(template),
            // A response is a set of pairings, so cardinality is `multiple` however many there
            // are, and the base type is QTI's own name for a pair of identifiers.
            cardinality: "multiple",
            baseType: "directedPair",
            points: exactSet ? 1 : paired.points,
            ...(exactSet ? { correctResponse: paired.correctResponse } : { mapping: paired.mapping }),
          },
        });
      } catch (e: any) {
        resume(err.concat(String((e && e.message) || e)), {});
      }
    });
  };
}

Transformer.prototype.MATCH = pairingInteraction(
  "match",
  { container: "match", key: "target", list: "targets", itemList: "match-items", place: "target", oneToOne: true },
  "targets",
  "matchItems",
);
Transformer.prototype.CLASSIFICATION = pairingInteraction(
  "classification",
  {
    container: "classification",
    key: "category",
    list: "categories",
    itemList: "classification-items",
    place: "category",
    oneToOne: false,
  },
  "categories",
  "classificationItems",
);

Transformer.prototype.TOKENS = memberList("token", "tokens", 'tokens [[id "moon" text "Moon"]] {}.');
Transformer.prototype.GAPS = memberList("gap", "gaps", 'gaps [[id "a" assess [token "moon"]]] {}.');

/**
 * A sentence filled from a shared bank: QTI's gap-match interaction.
 *
 * Assembled rather than invented. The sentence and its markers are `text-entry`'s and the key is
 * `match`'s — a mapping over pairs, `baseType "directedPair"` — so `scorePairs` scores it with
 * no case of its own. What makes it a separate word from `inline-choice` is the bank: one pool
 * shared across every gap, and a token spent in one gap is gone from the others.
 *
 * Worth a point per gap and summed, as text-entry is over its blanks.
 */
Transformer.prototype.GAP_MATCH = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    const err = ([] as any[]).concat(e0 || []);
    try {
      const attrs = mergeAttributes(toPlainObject(v0), "gap-match");
      assertKnownAttributes("gap-match", attrs);

      if (typeof attrs.text !== "string" || !attrs.text.trim()) {
        throw new Error(
          'gap-match: needs the sentence its gaps sit in, e.g. text "The {{a}} orbits the ' +
            '{{b}}." Put {{<id>}} where each gap goes.',
        );
      }
      if (!Array.isArray(attrs.tokens) || !attrs.tokens.length) {
        throw new Error(
          'gap-match: needs the bank its gaps are filled from, e.g. tokens [[id "moon" text "Moon"]] {}.',
        );
      }
      if (!Array.isArray(attrs.gaps) || !attrs.gaps.length) {
        throw new Error(
          'gap-match: needs at least one gap, e.g. gaps [[id "a" assess [token "moon"]]] {}.',
        );
      }

      const filled = fill(attrs.text, attrs.gaps, attrs.tokens);
      const template = attrs.responseProcessing !== undefined ? attrs.responseProcessing : "map-response";
      const exactSet = template === "match-correct";

      resume(err, {
        interaction: {
          type: "gap-match",
          ...(attrs.prompt !== undefined ? { prompt: attrs.prompt } : {}),
          // The bank shuffles like every other list a candidate reads. The sentence does not —
          // it is a sentence.
          shuffle: resolveShuffle(attrs.shuffle, filled.tokens),
          segments: filled.segments,
          tokens: filled.tokens,
        },
        validation: {
          responseProcessing: templateId(template),
          cardinality: "multiple",
          baseType: "directedPair",
          points: exactSet ? 1 : filled.points,
          ...(exactSet ? { correctResponse: filled.correctResponse } : { mapping: filled.mapping }),
        },
      });
    } catch (e: any) {
      resume(err.concat(String((e && e.message) || e)), {});
    }
  });
};

/**
 * A written response, scored by a person against a rubric.
 *
 * `responseProcessing: "human"` is the third template, and it is NOT the same as an unscored
 * poll. A poll has nothing to earn (`points: 0`); this has points that simply cannot be
 * awarded here. The scorer keeps them apart with `Score.pending`, so a written answer is never
 * reported as zero earned.
 */
Transformer.prototype.EXTENDED_TEXT = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    const err = ([] as any[]).concat(e0 || []);
    try {
      const attrs = mergeAttributes(toPlainObject(v0), "extended-text");
      assertKnownAttributes("extended-text", attrs);

      const bands: any[] = attrs.rubric || [];
      if (bands.length < 2) {
        throw new Error(
          "extended-text: needs a rubric of at least two bands, e.g. " +
            'rubric [[score 2 descriptor "…"] [score 0 descriptor "…"]] {}. ' +
            "A written response is scored by a person, and the rubric is what they score against.",
        );
      }
      const seen = new Map<number, number>();
      for (const [i, band] of bands.entries()) {
        if (typeof band.points !== "number") {
          throw new Error(`band ${i + 1}: needs \`points\`, e.g. [ points 2 descriptor "…" ].`);
        }
        if (typeof band.descriptor !== "string" || !band.descriptor.trim()) {
          throw new Error(
            `band ${i + 1}: needs a \`descriptor\` saying what earns ${band.points}. ` +
              "A bare score tells the person marking it nothing.",
          );
        }
        const prior = seen.get(band.points);
        if (prior !== undefined) {
          throw new Error(
            `band ${i + 1}: ${band.points} points is already band ${prior}. Each band scores differently.`,
          );
        }
        seen.set(band.points, i + 1);
      }

      const points = Math.max(...bands.map((b) => b.points));
      if (points <= 0) {
        throw new Error(
          "extended-text: no band earns anything, so the response cannot be scored. " +
            "Give the top band a score above zero.",
        );
      }

      resume(err, {
        interaction: {
          type: "extended-text",
          ...(attrs.prompt !== undefined ? { prompt: attrs.prompt } : {}),
        },
        validation: {
          responseProcessing: "human",
          points,
          // Ordered high to low, which is how a rubric is read.
          rubric: bands
            .slice()
            .sort((a, b) => b.points - a.points)
            .map((b) => ({ points: b.points, descriptor: b.descriptor })),
          ...(attrs.exemplar !== undefined ? { exemplar: attrs.exemplar } : {}),
        },
      });
    } catch (e: any) {
      resume(err.concat(String((e && e.message) || e)), {});
    }
  });
};

/**
 * Assemble the compiled item: `interaction` (safe to ship) and `validation` (the answer key)
 * as siblings, so a graded delivery can withhold the second and score server-side while a
 * practice item keeps it inline and self-checks.
 *
 * Points resolve here, at compile time, so the runtime never walks an inheritance chain and
 * the scorer's ceiling is the same number this computed. `validation.points` sums only the
 * options marked `correct`: a penalty must not be able to move the maximum, or a fully
 * correct response could never equal it.
 */
Transformer.prototype.CHOICE = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    const err = ([] as any[]).concat(e0 || []);
    try {
      const attrs = mergeAttributes(toPlainObject(v0), "choice");
      assertKnownAttributes("choice", attrs);

      const opts: any[] = attrs.options || [];
      if (!opts.length) {
        throw new Error('choice: needs at least one option, e.g. options [[text "A"]] {}.');
      }

      // Ids are auto-derived and written only when something else must reference one.
      const seen = new Map<string, number>();
      const withIds = opts.map((opt, i) => {
        const id = opt.id !== undefined ? opt.id : optionLabel(i);
        if (seen.has(id)) {
          throw new Error(
            `choice: two options share the id "${id}" (options ${seen.get(id)} and ${i + 1}). ` +
              "Ids must be unique; omit `id` to have them derived.",
          );
        }
        seen.set(id, i + 1);
        return { ...opt, id };
      });

      // QTI's two response-processing templates. `map-response` scores each selected option
      // and sums; `match-correct` is all-or-nothing against the correct set. Which one is in
      // force decides the SHAPE of `validation` — mapping and correctResponse are alternatives
      // in QTI and stay alternatives here, so no field's meaning depends on another's presence.
      const template = attrs.responseProcessing !== undefined ? attrs.responseProcessing : "map-response";
      const exactSet = template === "match-correct";

      const mapping: Record<string, any> = {};
      const correctResponse: string[] = [];
      const feedback: Record<string, string> = {};
      let points = 0;
      let assessed = 0;
      for (const opt of withIds) {
        const assess = opt.assess;
        if (assess === undefined) continue;
        assertAssessWords(assess, ["correct", "points", "rationale"], `option "${opt.id}"`);
        assessed += 1;
        const isCorrect = assess.correct === true;
        const hasPoints = typeof assess.points === "number";
        const hasRationale = typeof assess.rationale === "string";
        if (!isCorrect && !hasPoints && !hasRationale) {
          throw new Error(
            `option "${opt.id}": assess must say what it asserts — \`correct\`, \`points\`, or ` +
              "`rationale`. `assess [correct]` marks the answer; `assess [points -1]` penalizes a " +
              "distractor; `assess [rationale \"…\"]` explains one.",
          );
        }
        // Rationale is feedback, not scoring — QTI keeps them apart, and it has to survive under
        // `match-correct`, where there is no mapping to hang it on.
        if (hasRationale) feedback[opt.id] = assess.rationale;
        if (isCorrect) correctResponse.push(opt.id);

        if (exactSet) {
          // Per-option points under an all-or-nothing template would be a second, disagreeing
          // answer to what a correct response earns — the same reason `points` is refused on an
          // additive item. Refuse it rather than accept it and ignore it.
          if (hasPoints) {
            throw new Error(
              `option "${opt.id}": \`points\` is not meaningful under ` +
                '`response-processing "match-correct"`, which awards the item\'s points for exactly ' +
                "the correct set and nothing otherwise. Remove `points`, or use the default " +
                '`response-processing "map-response"` to score each option.',
            );
          }
          continue;
        }
        if (!isCorrect && !hasPoints) continue; // rationale alone asserts nothing about scoring
        // `correct` with no `points` is worth 1. A penalty carries its own negative points.
        const value = hasPoints ? assess.points : 1;
        mapping[opt.id] = isCorrect ? { correct: true, points: value } : { points: value };
        if (isCorrect) points += value;
      }
      const correctCount = correctResponse.length;
      if (assessed > 0 && correctCount === 0) {
        throw new Error(
          "choice: no option is marked `correct`, so the item cannot be scored. " +
            "Add `assess [correct]` to the right answer, or remove every `assess` for an unscored item.",
        );
      }
      if (exactSet && correctCount === 0) {
        throw new Error(
          'choice: `response-processing "match-correct"` scores against the correct set, but no ' +
            "option is marked `correct`. Add `assess [correct]` to every option that belongs in " +
            "the answer.",
        );
      }
      // Under match-correct the item is worth one point for the whole set, not the sum of its
      // options — there are no per-option points to sum.
      if (exactSet) points = 1;
      // `upper-bound` caps the mapping, which is how "any N of these" is said. Meaningless
      // under match-correct, where the whole set is the answer.
      const bounded = attrs.upperBound !== undefined && !exactSet;
      if (attrs.upperBound !== undefined && exactSet) {
        throw new Error(
          'choice: `upper-bound` is not meaningful under `response-processing "match-correct"`, ' +
            "which already requires exactly the correct set.",
        );
      }
      if (bounded) {
        if (attrs.upperBound > points) {
          throw new Error(
            `choice: upper-bound is ${attrs.upperBound} but the correct options are only worth ${points}. ` +
              "Lower `upper-bound`, or mark more options correct.",
          );
        }
        points = attrs.upperBound;
      }

      const maxChoices = attrs.maxChoices !== undefined ? attrs.maxChoices : 1;
      const minChoices = attrs.minChoices !== undefined ? attrs.minChoices : 0;
      if (correctCount > maxChoices && !bounded) {
        throw new Error(
          `choice: ${correctCount} options are marked \`correct\` but max-choices is ${maxChoices}. ` +
            "Raise `max-choices` for a multi-select item, or mark fewer options correct.",
        );
      }
      if (minChoices > maxChoices) {
        throw new Error(`choice: min-choices (${minChoices}) is greater than max-choices (${maxChoices}).`);
      }

      // Presentation, decided here so the renderer needs no rules of its own. An anchored
      // option ("All of the above") is marked and pinned; a list whose order is already
      // information (numbers in sequence, True/False) is not shuffled at all. An authored
      // `shuffle` beats both — the rules only decide what happens when nobody said.
      const options = withIds.map(({ id, text }) => {
        const label = text !== undefined ? text : "";
        return { id, text: label, ...(isAnchored(label) ? { anchored: true as const } : {}) };
      });
      const shuffle = resolveShuffle(attrs.shuffle, options);

      resume(err, {
        interaction: {
          type: "choice",
          ...(attrs.prompt !== undefined ? { prompt: attrs.prompt } : {}),
          minChoices,
          maxChoices,
          shuffle,
          options,
        },
        validation: {
          responseProcessing: templateId(template),
          // QTI keeps cardinality and baseType on the response declaration, which is this half.
          // Both are derived rather than authored: max-choices already says the first, and the
          // interaction type says the second.
          cardinality: maxChoices > 1 ? "multiple" : "single",
          baseType: "identifier",
          points,
          ...(exactSet ? { correctResponse } : { mapping }),
          ...(bounded ? { upperBound: attrs.upperBound } : {}),
          ...(Object.keys(feedback).length ? { feedback } : {}),
        },
      });
    } catch (e: any) {
      resume(err.concat(String((e && e.message) || e)), {});
    }
  });
};

/**
 * A member list of interactions. Its elements are whole interaction values — each already a
 * `{interaction, validation}` pair — rather than attribute lists, so nothing is merged here;
 * ITEM composes them.
 */
Transformer.prototype.PARTS = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    this.visit(node.elts[1], options, (e1: any, v1: any) => {
      const err = ([] as any[]).concat(e0 || [], e1 || []);
      const raw = toPlainObject(v0);
      if (!Array.isArray(raw) || !raw.length) {
        resume(
          err.concat("parts: expected at least one interaction, e.g. parts [ choice [ ... ] ] {}."),
          {},
        );
        return;
      }
      const bad = raw.findIndex((p: any) => !p || typeof p !== "object" || !(p.interaction || p.pending));
      if (bad >= 0) {
        resume(
          err.concat(
            `parts: entry ${bad + 1} is not an interaction. Each part is a whole interaction, ` +
              "e.g. parts [ choice [ ... ] hottext [ ... ] ] {}.",
          ),
          {},
        );
        return;
      }
      resume(err, { ...(toPlainObject(v1) || {}), parts: raw });
    });
  });
};

/**
 * An item: an optional stimulus plus one or more interactions scored together.
 *
 * Two scoring modes, and the difference is the whole reason the wrapper exists.
 * `additive` (the default) sums the parts, so the item is worth what its parts are worth.
 * `conjunctive` awards the item's points only when EVERY part is fully correct and nothing
 * otherwise — the shape a two-part evidence item needs, where picking the right claim while
 * citing the wrong line earns zero rather than half.
 */
Transformer.prototype.ITEM = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    const err = ([] as any[]).concat(e0 || []);
    try {
      const attrs = mergeAttributes(toPlainObject(v0), "item");
      assertKnownAttributes("item", attrs);

      const parts: any[] = attrs.parts || [];
      if (!parts.length) {
        throw new Error("item: needs at least one part, e.g. parts [ choice [ ... ] ] {}.");
      }

      // Paragraphs are addressed p1, p2, … and a hottext selecting `within "stimulus"` keys its
      // units off them, so they are built before anything reads a part's validation.
      const paragraphs: Paragraph[] = ((attrs.stimulus && attrs.stimulus.paragraphs) || []).map(
        (text: string, i: number) => ({ id: `p${i + 1}`, text }),
      );

      // Finish the parts that could not finish themselves. Children transform before parents, so
      // a `within "stimulus"` hottext reached here holding only its authored selections.
      let owner = -1;
      parts.forEach((part: any, i: number) => {
        if (!part.pending) return;
        if (!paragraphs.length) {
          throw new Error(
            `part ${i + 1}: hottext says \`within "stimulus"\` but the item has no stimulus. ` +
              "Add `stimulus [ paragraphs [ … ] ]`, or give the hottext its own `text`.",
          );
        }
        if (owner >= 0) {
          throw new Error(
            `part ${i + 1}: a second hottext selects \`within "stimulus"\`, but part ${owner + 1} ` +
              "already does. One passage cannot be two interactions; give this one its own `text`.",
          );
        }
        owner = i;
        const a = part.pending.attrs;
        const units =
          a.granularity === "word"
            ? wordUnits(paragraphs.map((p) => p.text).join(" "))
            : sentenceUnits(paragraphs);
        parts[i] = { ...assembleHottext(a, units, `part ${i + 1}`), within: "stimulus" };
      });

      const scoring = attrs.scoring !== undefined ? attrs.scoring : "additive";
      if (attrs.points !== undefined && scoring !== "conjunctive") {
        throw new Error(
          "item: `points` is only meaningful with `scoring \"conjunctive\"`. With additive " +
            "scoring the item is worth the sum of its parts, so setting it here would be a " +
            "second, disagreeing answer to what a correct response earns.",
        );
      }

      // Ids are 1-based and stable, and the response is keyed by them. Deliberately numeric so
      // a part id can never be mistaken for an option id, which is a letter.
      const ids = parts.map((_, i) => String(i + 1));
      const partValidation: Record<string, any> = {};
      let summed = 0;
      parts.forEach((p, i) => {
        const v = p.validation || { points: 0, options: {} };
        partValidation[ids[i]] = v;
        summed += typeof v.points === "number" ? v.points : 0;
      });

      if (scoring === "conjunctive") {
        const human = ids.filter((id) => partValidation[id]?.responseProcessing === "human");
        if (human.length) {
          throw new Error(
            `item: conjunctive scoring needs every part to be scoreable, but part ${human.join(", ")} ` +
              "is a written response scored by a person. Use the default additive scoring, so the " +
              "rest of the item scores while that part waits to be marked.",
          );
        }
        const unscored = ids.filter((id) => !(partValidation[id]?.points > 0));
        if (unscored.length) {
          throw new Error(
            `item: conjunctive scoring needs every part to be scoreable, but part ` +
              `${unscored.join(", ")} earns nothing. Mark a correct answer in it, or use the ` +
              "default additive scoring.",
          );
        }
      }

      const points = scoring === "conjunctive" ? (attrs.points !== undefined ? attrs.points : 1) : summed;

      const stimulus = attrs.stimulus
        ? {
            ...(attrs.stimulus.title !== undefined ? { title: attrs.stimulus.title } : {}),
            // Paragraphs are addressed p1, p2, … so a later span-selecting interaction can
            // point into the stimulus and have the reference survive into `validation`.
            paragraphs: (attrs.stimulus.paragraphs || []).map((text: string, i: number) => ({
              id: `p${i + 1}`,
              text,
            })),
          }
        : undefined;

      resume(err, {
        interaction: {
          type: "item",
          ...(stimulus ? { stimulus } : {}),
          parts: parts.map((p, i) => ({ id: ids[i], ...p.interaction, ...(p.within ? { within: p.within } : {}) })),
        },
        validation: { points, scoring, parts: partValidation },
      });
    } catch (e: any) {
      resume(err.concat(String((e && e.message) || e)), {});
    }
  });
};

/**
 * Activity-level attributes: arity 2, chaining.
 *
 * Takes its value AND the rest of the chain, and returns the chain's record with its own key
 * added — L0166's shape. That is what lets `items [...] navigation "linear" {}` build a
 * configuration record without brackets, terminating in the record literal.
 */
for (const [name, meta] of Object.entries(configFields)) {
  Transformer.prototype[name] = function (this: any, node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      this.visit(node.elts[1], options, (e1: any, v1: any) => {
        const err = ([] as any[]).concat(e0 || [], e1 || []);
        const raw = toPlainObject(v0);
        const typeError = checkValue(name, meta as any, raw);
        if (typeError) {
          resume(err.concat(typeError), {});
          return;
        }
        const rest = toPlainObject(v1);
        if (rest !== null && typeof rest === "object" && !Array.isArray(rest)) {
          if (Object.prototype.hasOwnProperty.call(rest, meta.field)) {
            resume(
              err.concat(`${wordOf(name)}: is given twice. Each activity setting may appear once.`),
              {},
            );
            return;
          }
          resume(err, { ...rest, [meta.field]: raw });
          return;
        }
        // The chain must terminate in a record — `{}` when there is nothing more to say.
        resume(
          err.concat(
            `${wordOf(name)}: the activity's settings must end in a record, e.g. ` +
              `items [ … ] ${wordOf(name)} … {}.`,
          ),
          {},
        );
      });
    });
  };
}

/**
 * The activity: a member list of items plus its own configuration record.
 *
 * A member is anything that compiled to an `interaction` — a bare `choice`, or an `item`
 * wrapping several parts over a stimulus. Nothing merges them; each was already assembled by
 * its own handler, and each keeps its own `validation`, so the split that lets a graded delivery
 * withhold the answer key survives one level up.
 */
Transformer.prototype.ITEMS = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    this.visit(node.elts[1], options, (e1: any, v1: any) => {
      const err = ([] as any[]).concat(e0 || [], e1 || []);
      const raw = toPlainObject(v0);
      if (!Array.isArray(raw)) {
        resume(
          err.concat(
            'items: expected a list of items, e.g. items [ choice [prompt "…" options [[text "A"]] {}] ] {}.',
          ),
          {},
        );
        return;
      }
      if (!raw.length) {
        resume(err.concat("items: an activity needs at least one item."), {});
        return;
      }
      const config = toPlainObject(v1);
      if (config === null || typeof config !== "object" || Array.isArray(config)) {
        resume(
          err.concat(
            "items: needs the activity's settings after the list, ending in a record — " +
              'e.g. items [ … ] navigation "linear" {}. Write `{}` when there are none.',
          ),
          {},
        );
        return;
      }
      const pending = raw.findIndex((i: any) => i.pending);
      if (pending >= 0) {
        resume(
          err.concat(
            'hottext: `within "stimulus"` needs the hottext to be a part of an item that has one. ' +
              "Wrap it in `item [ stimulus [ … ] parts [ … ] {} ]`, or give it its own `text`.",
          ),
          {},
        );
        return;
      }
      const bad = raw.findIndex(
        (i: any) => i === null || typeof i !== "object" || Array.isArray(i) || !i.interaction,
      );
      if (bad >= 0) {
        resume(
          err.concat(
            `items: entry ${bad + 1} is not an item. Each entry must be an interaction or an ` +
              '`item [ … ]`, e.g. items [ choice [prompt "…" options [[text "A"]] {}] ] {}.',
          ),
          {},
        );
        return;
      }
      try {
        resolveConfig(config);
        resume(err, buildActivity(raw, config));
      } catch (e: any) {
        resume(err.concat(String((e && e.message) || e)), {});
      }
    });
  });
};

/**
 * The program's value is its last expression.
 *
 * `data` is spread FIRST so the fresh compile wins. It carries the learner's response, but
 * after one round trip it also carries the previous compile's own `interaction` and
 * `validation` (the View merges a compile result back into the model), and letting those
 * shadow the newly compiled ones would render a stale item forever. L0179 spreads the other
 * way round on purpose — its learner edits live inside `interaction.cells` and must survive —
 * but here a response is a separate key and needs no such protection.
 */
Transformer.prototype.PROG = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    const data = options?.data || {};
    const val = v0.pop();
    if (val && typeof val === "object" && (val as any).pending) {
      resume(
        ([] as any[]).concat(e0 || [], [
          'hottext: `within "stimulus"` needs the hottext to be a part of an item that has one. ' +
            "Wrap it in `item [ stimulus [ … ] parts [ … ] {} ]`, or give it its own `text`.",
        ]),
        {},
      );
      return;
    }
    // Several questions written without `items` both compile clean and deliver wrong: bracketed,
    // to an array no renderer reads; unbracketed, to the last question alone. A generator asked
    // for a quiz writes exactly these, and only an error naming `items` gets it to try again.
    const isQuestion = (v: any) =>
      v !== null && typeof v === "object" && !Array.isArray(v) && (v.interaction || v.pending || v.activity);
    const dropped = Array.isArray(v0) ? v0.filter(isQuestion).length : 0;
    if ((Array.isArray(val) && val.some(isQuestion)) || (dropped && isQuestion(val))) {
      const count = Array.isArray(val) ? val.length : dropped + 1;
      resume(
        ([] as any[]).concat(e0 || [], [
          `A program is one item, and this one has ${count} questions side by side. ` +
            "Several questions are an activity: wrap them in `items [ … ] {}`, e.g. " +
            'items [ choice [prompt "…" options [[text "A"]] {}] choice [prompt "…" options [[text "B"]] {}] ] {}.',
        ]),
        {},
      );
      return;
    }
    const isObject = typeof val === "object" && val !== null && !Array.isArray(val);
    resume(e0, isObject ? { ...data, ...val } : val);
  });
};

export const compiler = new Compiler({
  langID: "0180",
  version: "v0.0.1",
  Checker,
  Transformer,
});
