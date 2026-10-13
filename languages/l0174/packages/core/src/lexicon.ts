// SPDX-License-Identifier: MIT
// L0174's lexicon = L0000's base vocabulary + L0174's forms additions (child keys win on merge).
//
// Idiom (cf. l0169 nodes/edges/relations): a form is a flat chain of top-level words
// terminated by `{}`. `fields` is a collection word wrapping a list of element words
// (one per field type); each element is built by chaining arity-2 prefix attribute
// functions. Example:
//
//   title 'Get in touch'
//   theme LIGHT
//   fields [
//     text  label 'Name'  required true {},
//     email label 'Email' required true {}
//   ]
//   submit 'Send' {}..
//
// Note: `min`/`max` intentionally override L0000's numeric builtins here — in a forms
// dialect they are field-range attributes, not math functions.
import { lexicon as base } from "@graffiticode/l0000";

// Field-type element words (arity 1): each wraps a chained attribute record and stamps `type`.
const elements = {
  text: { tk: 1, name: "TEXT", cls: "function", length: 1, arity: 1 },
  email: { tk: 1, name: "EMAIL", cls: "function", length: 1, arity: 1 },
  number: { tk: 1, name: "NUMBER", cls: "function", length: 1, arity: 1 },
  tel: { tk: 1, name: "TEL", cls: "function", length: 1, arity: 1 },
  url: { tk: 1, name: "URL", cls: "function", length: 1, arity: 1 },
  textarea: { tk: 1, name: "TEXTAREA", cls: "function", length: 1, arity: 1 },
  select: { tk: 1, name: "SELECT", cls: "function", length: 1, arity: 1 },
  radio: { tk: 1, name: "RADIO", cls: "function", length: 1, arity: 1 },
  checkbox: { tk: 1, name: "CHECKBOX", cls: "function", length: 1, arity: 1 },
  date: { tk: 1, name: "DATE", cls: "function", length: 1, arity: 1 },
};

// Attribute words (arity 2): value + continuation record; merge `{ ...rest, key: value }`.
const attributes = {
  label: { tk: 1, name: "LABEL", cls: "function", length: 2, arity: 2 },
  name: { tk: 1, name: "NAME", cls: "function", length: 2, arity: 2 },
  placeholder: { tk: 1, name: "PLACEHOLDER", cls: "function", length: 2, arity: 2 },
  help: { tk: 1, name: "HELP", cls: "function", length: 2, arity: 2 },
  required: { tk: 1, name: "REQUIRED", cls: "function", length: 2, arity: 2 },
  min: { tk: 1, name: "MIN", cls: "function", length: 2, arity: 2 },
  max: { tk: 1, name: "MAX", cls: "function", length: 2, arity: 2 },
  minLength: { tk: 1, name: "MINLENGTH", cls: "function", length: 2, arity: 2 },
  maxLength: { tk: 1, name: "MAXLENGTH", cls: "function", length: 2, arity: 2 },
  pattern: { tk: 1, name: "PATTERN", cls: "function", length: 2, arity: 2 },
  options: { tk: 1, name: "OPTIONS", cls: "function", length: 2, arity: 2 },
};

// Collection word (arity 2): list of field elements + continuation (shared defaults).
const collections = {
  fields: { tk: 1, name: "FIELDS", cls: "function", length: 2, arity: 2 },
};

// Top-level words (arity 2): value + continuation; merge into the flat program record.
const toplevel = {
  title: { tk: 1, name: "TITLE", cls: "function", length: 2, arity: 2 },
  theme: { tk: 1, name: "THEME", cls: "function", length: 2, arity: 2 },
  submit: { tk: 1, name: "SUBMIT", cls: "function", length: 2, arity: 2 },
  metadata: { tk: 1, name: "METADATA", cls: "function", length: 2, arity: 2 },
};

// Theme tags (reused from the inherited UI vocabulary).
const tags = {
  DARK: { tk: 22, name: "TAG", cls: "val", length: 0, arity: 0 },
  LIGHT: { tk: 22, name: "TAG", cls: "val", length: 0, arity: 0 },
};

const additions = {
  ...elements,
  ...attributes,
  ...collections,
  ...toplevel,
  ...tags,
};

export const lexicon = { ...base, ...additions };
