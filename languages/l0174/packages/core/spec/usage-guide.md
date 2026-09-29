<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0174 Usage Guide

Agent-facing guide for authoring L0174 programs. Read this before composing a `create_item` prompt or an `update_item` modification.

## Overview

L0174 is the Graffiticode forms language. It compiles a natural-language description of a web form into a hosted, themed, single-page form: a title, a light or dark theme, an ordered list of typed fields, and a submit affordance. Field types are `text`, `email`, `number`, `tel`, `url`, `textarea`, `select`, `radio`, `checkbox`, and `date`; each field can carry a label, placeholder, help text, a `required` flag, and validation (`min`/`max`, `minLength`/`maxLength`, `pattern`). It is the right tool when the job is "stand up a working form" — collecting contact details, RSVPs, feedback, signups. It is not the tool for tabular input or grading (use L0166), charts (L0173), or reshaping collected submissions (L0170). Where a submission should be delivered — the webhook URL and signing secret — is supplied as structured `config`, never described in prose.

## Composing a request

Name the form first (its title and purpose), then list the fields in order. For each field give its type, its label, whether it is required, and any validation. Pick a theme (light or dark) and a submit button label; optionally a thank-you message or a redirect URL after submit. Example intent: *"A contact form titled 'Get in touch' with Name (text, required), Email (email, required) and Message (textarea, required, at least 20 characters); submit reads 'Send'; light theme; show a thank-you after submit."*

The compiled form is a flat record: `{ title, theme, fields: [ { type, name, label, required, … } ], submit, metadata }`. Each field's `name` (its submission key) defaults to a slug of the label unless you specify one.

## What L0174 cannot express

No multi-page or branching logic, conditional fields, file uploads, payments, e-signatures, or calculated fields. For tabular input/grading use L0166; for charts use L0173; to reshape collected submissions use L0170. The webhook binding is data, not part of the form description — supply it as `config.webhook`.
