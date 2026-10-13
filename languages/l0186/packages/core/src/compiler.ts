// SPDX-License-Identifier: MIT
/* Copyright (c) 2026, ARTCOMPILER INC */
//
// L0186 inherits L0000: its Checker/Transformer extend L0000's. Property and member handlers are
// GENERATED from the tables in `attributes.ts` — never hand-write one. The containers, the
// `save-to-figjam` statement and PROG are written out, because each assembles something the
// tables cannot express. Unhandled tags fall through to L0000's handlers, so every L0000
// expression still works inside a program.
import { Checker as BaseChecker, Transformer as BaseTransformer, Compiler } from "@graffiticode/l0000";

import {
  SAVE_HINT,
  SAVE_TO_FIGJAM,
  assertKnownAttributes,
  assertKnownSettings,
  chainFields,
  checkValue,
  containerFields,
  containerMembers,
  exampleOf,
  hintFor,
  isRecord,
  memberFields,
  showValue,
  sourceWord,
  toPlainObject,
  validSettings,
  wordOf,
} from "./attributes.js";
import { buildBoard, nodeName, parseFileKey, toNode } from "./board.js";

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
Checker.prototype[SAVE_TO_FIGJAM.name] = checkChild;

/** The node tags L0186's own descriptions produce, plus a bare `{}`. `save-to-figjam` is a statement and may stand alone. */
const OWN_TAGS = new Set([...Object.keys(chainFields), ...Object.keys(memberFields), ...Object.keys(containerFields), "RECORD"]);

/**
 * A `{}` written before the end of a description ends it there, and the words after it parse as
 * a SECOND top-level expression — well formed, and silently dropped. That is the one mistake the
 * parser cannot report, so it is caught here: the board is the only top-level expression built
 * from L0186's description words, so a second one is an early-closed description. A
 * `save-to-figjam` statement and L0000 expressions (`set-var`, `print`, …) may stand beside it.
 */
Checker.prototype.PROG = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any) => {
    const errs = [...(e0 || [])];
    const exprs = this.nodePool[node.elts[0]];
    const elts: any[] = (exprs && exprs.elts) || [];
    const own = elts.filter((e) => OWN_TAGS.has(this.nodePool[e]?.tag));
    if (own.length > 1) {
      const next = this.nodePool[own[1]];
      errs.push({
        message:
          `A \`{}\` ended a description early: the program has ${own.length} top-level descriptions where one ` +
          "`board [ … ] {}` was expected, and the words after the early `{}` started a new one. " +
          "Every description ends in exactly one `{}`, after its last word: write " +
          '`sticky text "A" x 0 {}`, not `sticky text "A" {} x 0 {}`.',
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
  if (owner === "board") return `board [ … ] ${word} … {}`;
  if (owner === "page") return `page [ … ] ${word} … {}`;
  return `sticky ${word} … {}`;
};

/** The marker `save-to-figjam` evaluates to, found where a description was expected. */
const isSaveMarker = (v: any): boolean => isRecord(v) && Object.prototype.hasOwnProperty.call(v, SAVE_TO_FIGJAM.field);

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
        if (isSaveMarker(rest)) {
          resume(err.concat(`${word}: save-to-figjam cannot end a description.${SAVE_HINT}`), {});
          return;
        }
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
        resume(err, { [meta.field]: value, ...rest });
      });
    });
  };
}

/** Members, arity 1: `sticky <description>` evaluates to `{sticky: {...}}`. */
for (const [name, meta] of Object.entries(memberFields)) {
  Transformer.prototype[name] = function (this: any, node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      const err = ([] as any[]).concat(e0 || []);
      const raw = toPlainObject(v0);
      if (isSaveMarker(raw)) {
        resume(err.concat(`${wordOf(name)}: save-to-figjam cannot be a description.${SAVE_HINT}`), {});
        return;
      }
      const { value, error } = checkValue(name, meta, raw);
      if (error) {
        resume(err.concat(error), {});
        return;
      }
      resume(err, { [meta.field]: value });
    });
  };
}

/** `save-to-figjam "<link>"` — a statement: evaluates to a marker PROG merges into the board. */
Transformer.prototype[SAVE_TO_FIGJAM.name] = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    const err = ([] as any[]).concat(e0 || []);
    try {
      resume(err, { [SAVE_TO_FIGJAM.field]: parseFileKey(toPlainObject(v0)) });
    } catch (e) {
      resume(err.concat(message(e)), {});
    }
  });
};

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
 * When a list item is a bare property (`x …`, `text …`), the usual cause is a `{}` that ended the
 * previous description early, so the rest of it became an item of its own.
 */
const earlyClose = (m: any): string => {
  const keys = isRecord(m) ? Object.keys(m) : [];
  if (keys.length !== 1 || ITEM_WORDS.has(sourceWord(keys[0]))) return "";
  return ` If \`${sourceWord(keys[0])}\` belongs to the description before it, a \`{}\` ended that description early: a description ends in exactly one \`{}\`, after its last word.`;
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
 * A typed list: every entry is one of the container's member words, and each member's words are
 * checked as it is reached, so an error lands on the member that caused it.
 */
function members(word: string, list: any[], where: string): { member: string; rec: any; where: string }[] {
  const allowed = containerMembers[word];
  return list.map((m, i) => {
    const keys = isRecord(m) ? Object.keys(m) : [];
    const member = keys.length === 1 ? sourceWord(keys[0]) : undefined;
    if (member === SAVE_TO_FIGJAM.word) throw new Error(`${where}: item ${i + 1} is save-to-figjam, which is not a member of ${word}.${SAVE_HINT}`);
    if (isRecord(m) && !keys.length) {
      throw new Error(
        `${where}: item ${i + 1} is a stray \`{}\`. A description ends in exactly one \`{}\`, after its last word: write ${exampleOf(allowed[0])}, not ${exampleOf(allowed[0]).replace(/ \{\}$/, " {} {}")}.`,
      );
    }
    if (!member || !allowed.includes(member)) {
      const hint = member ? hintFor(member, word) : "";
      throw new Error(
        `${where}: item ${i + 1} is ${describe(m)}, which is not a member of ${word}. It holds: ${allowed.join(", ")}.${hint}${i > 0 ? earlyClose(m) : ""}`,
      );
    }
    const rec = m[keys[0]];
    const itemWhere = `${where}: ${nodeName(member, rec, i)}`;
    if (validSettings[member] === undefined) assertKnownAttributes(member, rec, itemWhere);
    return { member, rec, where: itemWhere };
  });
}

/** Members of a page or section, as the nodes the plugin draws. A section arrives already built. */
const toNodes = (word: string, list: any[], where: string): any[] =>
  members(word, list, where).map(({ member, rec, where: w }) => (member === "section" ? rec : toNode(member, rec, w)));

/** `section [ nodes ] settings {}` — a titled area holding nodes. */
Transformer.prototype.SECTION = container("section", (list, settings) => {
  const where = settings.name !== undefined ? `section ${JSON.stringify(settings.name)}` : "section";
  assertKnownSettings("section", settings, where);
  return { section: { type: "section", ...settings, nodes: toNodes("section", list, where) } };
});

/** `page [ nodes ] settings {}` — one page. Its name waits for the board, which knows how many pages there are. */
Transformer.prototype.PAGE = container("page", (list, settings) => {
  const where = settings.name !== undefined ? `page ${JSON.stringify(settings.name)}` : "page";
  assertKnownSettings("page", settings, where);
  return { page: { nodes: toNodes("page", list, where), settings } };
});

/** `board [ pages ] settings {}` — the FigJam file. */
Transformer.prototype.BOARD = container("board", (list, settings) => {
  assertKnownSettings("board", settings);
  const pages = members("board", list, "board").map(({ rec }) => rec);
  return buildBoard(pages, settings);
});

const PROGRAM_EXAMPLE = 'board [ page [ sticky text "Hello" {} ] {} ] {}';

/**
 * The program is one board, and optionally one `save-to-figjam` statement in either order, which
 * adds the board's `fileKey`. Upstream `options.data` is never spread into the output: it is
 * exactly what this program compiled.
 */
Transformer.prototype.PROG = function (this: any, node: any, options: any, resume: any) {
  this.visit(node.elts[0], options, (e0: any, v0: any) => {
    const err = ([] as any[]).concat(e0 || []);
    if (err.length) {
      resume(err, {});
      return;
    }
    const vals = (Array.isArray(v0) ? v0 : [v0]).map(toPlainObject);
    const boards = vals.filter((v) => isRecord(v) && v.type === "board");
    const saves = vals.filter(isSaveMarker);
    if (boards.length !== 1) {
      resume([`A program is one board, ending in \`..\`: e.g. ${PROGRAM_EXAMPLE}..${saves.length ? " save-to-figjam names where to draw it, and needs the board beside it." : ""}`], {});
      return;
    }
    if (saves.length > 1) {
      resume(["save-to-figjam is given twice. A board is drawn into one FigJam file: keep one save-to-figjam line."], {});
      return;
    }
    const board = { ...boards[0] };
    if (saves.length) board.fileKey = saves[0][SAVE_TO_FIGJAM.field];
    resume([], board);
  });
};

export const compiler = new Compiler({ langID: "0186", version: "v0.1.0", Checker, Transformer });
