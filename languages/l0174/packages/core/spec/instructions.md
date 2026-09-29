<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0174 Dialect Extensions

L0174 is the Graffiticode forms dialect. On top of the L0000 core it adds vocabulary for
authoring web forms: a flat chain of top-level words (`title`, `theme`, `fields`, `submit`,
`metadata`) terminated by `{}`, where `fields` wraps a list of field elements.

## L0174 field elements (arity 1)

`text` `email` `number` `tel` `url` `textarea` `select` `radio` `checkbox` `date` — each
takes a chained attribute record and stamps the field `type`.

## L0174 field attributes (arity 2, chainable)

`label` `name` `placeholder` `help` `required` `min` `max` `minLength` `maxLength` `pattern`
`options` — each takes a value and the rest of the field, e.g. `required true`.

## L0174 top-level words (arity 2)

`title` `theme` (`DARK`/`LIGHT`) `submit` `metadata`, plus the `fields` collection.

## Examples

A contact form:

```
title 'Get in touch'
theme LIGHT
fields [
  text     label 'Name'    required true {},
  email    label 'Email'   required true {},
  text     label 'Company' {},
  textarea label 'Message' required true minLength 20 {}
]
submit 'Send' {}..
```

Choice fields (`select`/`radio` need `options`; a bare `checkbox` is a boolean):

```
fields [
  select   label 'Topic'     options ['Sales' 'Support' 'Other'] required true {},
  radio    label 'Rating'    options ['1' '2' '3' '4' '5'] {},
  checkbox label 'Subscribe' {}
] {}..
```
