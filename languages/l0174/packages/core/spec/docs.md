<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0174 User Manual

**L0174** is the Graffiticode *forms* language. A program describes a web form; compiling it
produces a form-definition record that the L0174 `<Form>` renders as a hosted, themed,
single-page form. Submissions are native task composition (an L0000 data tail under the form
head) and can be delivered to a webhook bound via `config` (see the forms hook spec). The data
tail carries submitted answers namespaced under `values` (e.g. `{ "values": { "email": "a@b.c" } }`),
keeping them separate from the form-definition keys; the `<Form>` reads `data.values` to
pre-populate controls on load.

## Program shape

A program is a flat chain of top-level words terminated by `{}`:

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

compiles to:

```json
{
  "title": "Get in touch",
  "theme": "light",
  "fields": [
    { "type": "text",     "name": "name",    "label": "Name",    "required": true },
    { "type": "email",    "name": "email",   "label": "Email",   "required": true },
    { "type": "textarea", "name": "message", "label": "Message", "required": true, "minLength": 20 }
  ],
  "submit": { "label": "Send" }
}
```

## Vocabulary

| Word | Kind | Arity | Meaning |
|---|---|---|---|
| `title` | top-level | 2 | Form title |
| `theme` | top-level | 2 | `DARK` / `LIGHT` → `"dark"` / `"light"` |
| `fields` | collection | 2 | Ordered list of field elements |
| `submit` | top-level | 2 | Submit button label (or a `{ label, thankyou, redirect }` record) |
| `metadata` | top-level | 2 | Reserved form-level metadata |
| `text` `email` `number` `tel` `url` `textarea` `select` `radio` `checkbox` `date` | element | 1 | A field of that type |
| `label` `name` `placeholder` `help` `required` `min` `max` `minLength` `maxLength` `pattern` `options` | attribute | 2 | Field attributes (chain before the field's `{}`) |

## Notes

- A field's submission `name` defaults to a slug of its `label` (`"Full name"` → `full_name`); override with `name`.
- `select` and `radio` require a non-empty `options` list; a bare `checkbox` is a single boolean.
- The webhook binding is supplied as `config.webhook`, not in the program text.
