// SPDX-License-Identifier: MIT
/* Copyright (c) 2023, ARTCOMPILER INC */
//
// L0174 — the forms hook language. Inherits L0000: its Checker/Transformer extend L0000's.
//
// Surface idiom (cf. l0169 nodes/edges/relations): a form is a flat chain of arity-2
// top-level words terminated by `{}`. `fields` is a collection word wrapping a list of
// arity-1 element words (one per field type); each element is built by chaining arity-2
// prefix attribute functions. The program compiles to a flat form-definition record:
//
//   { title, theme, fields: [ { type, name, label, required, ... } ], submit, metadata }
//
// Unhandled tags fall through to L0000's base handlers / CATCH_ALL.
import {
  Checker as BaseChecker,
  Transformer as BaseTransformer,
  Compiler,
} from "@graffiticode/l0000";

// L0000 represents `{ ... }` literals as a Record ({ _type, _entries: Map }) with keys
// encoded "tag:foo" / "str:foo" / "num:0". A continuation record reaches a handler as one
// of these; convert it to a plain object before spreading. (Nested Record *values* we keep
// as-is — the base Renderer's deepConvertRecords flattens them at render time.)
function isRecordLike(v: any) {
  return v != null && typeof v === "object" && v._type === "record" && v._entries instanceof Map;
}
function plainify(v: any): any {
  if (!isRecordLike(v)) {
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  }
  const out: any = {};
  for (const [encKey, val] of v._entries) {
    const i = encKey.indexOf(":");
    const key = i >= 0 ? encKey.slice(i + 1) : encKey;
    out[key] = isRecordLike(val) ? plainify(val) : val;
  }
  return out;
}

// label -> field name: lowercased, non-alphanumerics collapsed to "_".
function slug(s: any): string {
  const out = String(s == null ? "" : s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return out || "field";
}

// Tag -> { transform key } for the repetitive arity-2 attribute / top-level words.
const ATTR_KEYS: Record<string, string> = {
  LABEL: "label",
  NAME: "name",
  PLACEHOLDER: "placeholder",
  HELP: "help",
  REQUIRED: "required",
  MIN: "min",
  MAX: "max",
  MINLENGTH: "minLength",
  MAXLENGTH: "maxLength",
  PATTERN: "pattern",
  OPTIONS: "options",
  TITLE: "title",
  METADATA: "metadata",
};

// Tag -> field `type` for the arity-1 element words.
const ELEMENT_TYPES: Record<string, string> = {
  TEXT: "text",
  EMAIL: "email",
  NUMBER: "number",
  TEL: "tel",
  URL: "url",
  TEXTAREA: "textarea",
  SELECT: "select",
  RADIO: "radio",
  CHECKBOX: "checkbox",
  DATE: "date",
};

// Field types that require a non-empty `options` list.
const OPTION_REQUIRED = new Set(["select", "radio"]);

export class Checker extends BaseChecker {
  [key: string]: any;
  // Semantic validation lives in the Transformer, which fully traverses the chain (the base
  // Checker's CATCH_ALL does not recurse into unknown tags). The Checker passes L0174 tags
  // through to CATCH_ALL.
}

export class Transformer extends BaseTransformer {
  [key: string]: any;

  constructor(code: any) {
    super(code);
    // Wire the repetitive handlers: arity-2 attribute/top-level words merge a key into the
    // continuation record; arity-1 element words stamp a field `type`.
    for (const [tag, key] of Object.entries(ATTR_KEYS)) {
      this[tag] = (node: any, options: any, resume: any) => this._attr(key, node, options, resume);
    }
    for (const [tag, type] of Object.entries(ELEMENT_TYPES)) {
      this[tag] = (node: any, options: any, resume: any) => this._element(type, node, options, resume);
    }
  }

  // Arity-2 attribute / top-level: merge `{ ...continuation, key: value }`.
  _attr(key: string, node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      this.visit(node.elts[1], options, (e1: any, v1: any) => {
        resume([].concat(e0 || [], e1 || []), { ...plainify(v1), [key]: v0 });
      });
    });
  }

  // Arity-1 element: take the chained attribute record, stamp the type and derive a name.
  _element(type: string, node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      const attrs = plainify(v0);
      const err = [].concat(e0 || []);
      if (OPTION_REQUIRED.has(type) && !(Array.isArray(attrs.options) && attrs.options.length > 0)) {
        err.push({
          message: `The ${type} field "${attrs.label || attrs.name || type}" requires a non-empty options list.`,
          ...(node.coord || {}),
        });
      }
      const name = attrs.name || slug(attrs.label || type);
      resume(err, { type, name, ...attrs });
    });
  }

  // Collection: list of field elements + continuation. Fields merge into the program record.
  FIELDS(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      this.visit(node.elts[1], options, (e1: any, v1: any) => {
        const fields = Array.isArray(v0) ? v0 : v0 != null ? [v0] : [];
        resume([].concat(e0 || [], e1 || []), { ...plainify(v1), fields });
      });
    });
  }

  // Submit affordance: a bare string is the button label; a record passes through.
  SUBMIT(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      this.visit(node.elts[1], options, (e1: any, v1: any) => {
        const submit = typeof v0 === "string" ? { label: v0 } : plainify(v0);
        resume([].concat(e0 || [], e1 || []), { ...plainify(v1), submit });
      });
    });
  }

  // Theme: a DARK / LIGHT tag becomes "dark" / "light".
  THEME(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      this.visit(node.elts[1], options, (e1: any, v1: any) => {
        const tag = v0 && v0.tag;
        const err = [].concat(e0 || [], e1 || []);
        if (tag !== "DARK" && tag !== "LIGHT") {
          err.push({
            message: `theme expects the tag DARK or LIGHT. Got ${tag ? "tag " + tag : JSON.stringify(v0)}.`,
            ...(node.coord || {}),
          });
        }
        resume(err, { ...plainify(v1), theme: tag ? String(tag).toLowerCase() : undefined });
      });
    });
  }

  PROG(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, (e0: any, v0: any) => {
      const data = options?.data || {};
      // The program body is a single flat-chain expression (EXPRS yields a one-item list).
      const val = Array.isArray(v0) ? v0[v0.length - 1] : v0;
      const isObject = typeof val === "object" && val !== null && !Array.isArray(val);
      resume(e0, isObject ? { ...val, ...data } : val);
    });
  }
}

export const compiler = new Compiler({
  langID: "0174",
  version: "v0.0.2",
  Checker,
  Transformer,
});
