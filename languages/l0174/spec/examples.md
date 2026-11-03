<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0174 RAG Training Examples

Example prompts paired with the L0174 program they should produce. Each program is a flat
chain of top-level words terminated by `{}`.

## Contact / lead capture

**Prompt:** A contact form titled "Get in touch" with Name (required), Email (required),
Company, and Message (required, at least 20 chars). Submit reads "Send". Light theme.

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

## RSVP

**Prompt:** RSVP form for a launch event: Full name (required), Email (required), Number of
guests (0–5, required), Dietary notes. Dark theme.

```
title 'Launch RSVP'
theme DARK
fields [
  text     label 'Full name'        required true {},
  email    label 'Email'            required true {},
  number   label 'Number of guests' min 0 max 5 required true {},
  textarea label 'Dietary notes'    {}
]
submit 'RSVP' {}..
```

## Feedback with choices

**Prompt:** Feedback form: Topic dropdown (Sales, Support, Other; required), Rating radio
(1–5), Subscribe checkbox. Submit reads "Submit".

```
title 'Feedback'
fields [
  select   label 'Topic'     options ['Sales' 'Support' 'Other'] required true {},
  radio    label 'Rating'    options ['1' '2' '3' '4' '5'] {},
  checkbox label 'Subscribe' {}
]
submit 'Submit' {}..
```

## Minimal signup

**Prompt:** Newsletter signup with just an Email field (required) and a "Join" button, dark theme.

```
theme DARK
fields [
  email label 'Email' required true {}
]
submit 'Join' {}..
```

## Validation: pattern + length

**Prompt:** Account form: Username (3–20 chars, required), Phone (tel, pattern for digits),
Website (url).

```
title 'Create account'
fields [
  text label 'Username' required true minLength 3 maxLength 20 {},
  tel  label 'Phone'    pattern '[0-9 +()-]+' {},
  url  label 'Website'  {}
]
submit 'Create' {}..
```

## Post-submit redirect

**Prompt:** Waitlist form with Email (required); after submit, send them to /thanks.

```
title 'Join the waitlist'
fields [
  email label 'Email' required true {}
]
submit { label: 'Join', redirect: '/thanks' } {}..
```
