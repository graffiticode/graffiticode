<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0174 Vocabulary

These functions extend the L0000 core language with the vocabulary for authoring web
**forms**. An L0174 program is a flat chain of top-level words terminated by `{}`, where
`fields` wraps a list of field elements, each built by chaining attribute words.

## Top-level words

A program assembles a flat form-definition record. Each top-level word takes a value and
the rest of the program (a continuation), terminated by `{}`.

- `title <string>` — the form title.
- `theme <DARK|LIGHT>` — light or dark theme (a tag, lowercased in the output).
- `fields [ <field> ... ]` — the ordered list of fields (see below).
- `submit <string>` — the submit button label. A record value carries `{ label, thankyou, redirect }`.
- `metadata <record>` — reserved form-level metadata (e.g. a campaign attribute).

## Field elements

Each field type is an element word taking a chained attribute record. The element stamps the
field `type` and derives a submission `name` from the label (unless `name` is given).

`text`, `email`, `number`, `tel`, `url`, `textarea`, `select`, `radio`, `checkbox`, `date`

## Field attributes

Attributes chain in front of the field's closing `{}`:

- `label <string>` — the field label.
- `name <string>` — override the auto-derived submission key.
- `placeholder <string>` — input placeholder.
- `help <string>` — help text shown beneath the field.
- `required <boolean>` — whether the field is required (`required true`).
- `min <number>` / `max <number>` — value range (number, date).
- `minLength <number>` / `maxLength <number>` — text length bounds.
- `pattern <string>` — a regular expression the value must match.
- `options [ <string> ... ]` — choices for `select`, `radio`, `checkbox`.

`select` and `radio` require a non-empty `options` list.

## Example

```
title 'Get in touch'
theme LIGHT
fields [
  text     label 'Name'    required true {},
  email    label 'Email'   required true {},
  textarea label 'Message' required true minLength 20 {}
]
submit 'Send' {}..
```
