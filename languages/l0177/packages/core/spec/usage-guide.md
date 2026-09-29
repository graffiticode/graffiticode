<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0177 Usage Guide

Agent-facing guide for the Learnosity **Author API integration** oracle. Read this before composing a `create_item` prompt.

## Overview

This is an empirical integration oracle. Its knowledge combines Learnosity's published documentation with observations from direct API experiments. It checks the integration design and returns a host-language-neutral recipe that identifies known behavior, documented expectations, and remaining verification work.

When handling a recipe request, the oracle does not sign or send Learnosity API requests. The caller implements the recipe using their own credentials and environment. A complete design means the modeled inputs are present; it does not mean the integration has been verified in that environment.

L0177 is a developer-integration oracle for the Learnosity **Author API**: it does not author assessment content — it produces a precise, host-language-neutral **recipe** for embedding and configuring an integrated **authoring experience** (the Learnosity item/activity editor or browser) in your own app. You describe the integration *design* — which experience to embed and how it's configured — L0177 validates it, flags any **holes** (missing required properties) as steering warnings, and via `get_spec` returns the recipe: goal, preconditions, procedure, gotchas, and runnable **verification steps**. You fill the holes over a few turns and implement the result in your own stack (Node, PHP, Ruby, .NET). L0177 never writes item content (that is L0176) and never emits runnable code.

**The recipe states how sure it is, and you must not upgrade it.** The Author API **fails open on
`config`**: an unrecognized key is silently ignored — the editor still initializes, `readyListener`
still fires, and the page looks correct while enforcing nothing.

What that means in practice differs by property. **`question-type-groups` is enforced** — restricting
the picker to named question-type groups was verified differentially against the live API, and the
recipe states it as fact. **`allow-widgets` is not**: it names finer-grained question types, and no
confirmed config key restricts at that granularity, so the recipe carries it as intent plus a check.
Ask for `question-type-groups` when a client wants authors limited to particular kinds of question;
`allow-widgets` alone changes nothing in the editor, and the compiler will say so.

For the same fail-open reason, some **verification steps are differential** — they ask you to load
the editor twice, once with the key omitted, because simply observing the behaviour you wanted
proves nothing. That is not pedantry: the widget-type restriction was misread as broken for exactly
this reason, because a config that *added* a group left the picker looking untouched.

## Workflow

1. `list_languages(domain: "learnosity")` and pick L0177 when the task is *how to integrate a Learnosity authoring experience* — not authoring an item's content.
2. `create_item("L0177", "<the integration design, with your specifics>")` — name the experience and the details you have (domain, author id, item reference, allowed question types, editor options).
3. `get_item(item_id)` — returns the normalized design plus `warnings` (design holes first, then specificity advisories). Refine with `update_item` until the warnings clear.
4. `get_spec(item_id)` — returns the recipe. Implement it, then work the verification steps. A clean render is **not** proof: the editor initializing and `readyListener` firing tell you the page loaded, not that your `config` took effect. Checks that assert config-driven behaviour require a **control run** with the key omitted.

## The four experiences (view functions)

The view function you use *is* the mode (there's no in-UI switch — each is a separate page/integration):

| View | Author API view | Notes |
|------|-----------------|-------|
| `item-edit` | Item editor (create/edit one item) | needs a `reference` |
| `item-list` | Item browser/list | modeled: list columns and link-out URL, result restrictions, toolbar/search controls, page size |
| `activity-edit` | Activity editor | `reference` optional; modeled: item rows, item search, assessment-player settings (playback, time, administration, text, scoring), save, metadata |
| `activity-list` | Activity browser/list | modeled: list columns, result restrictions, toolbar create buttons, page size |

## Writing a good design

Everything is expressed in natural language — the generator writes the DSL. Give the details you have:
- **Name the experience** (edit an item? browse items? build an activity?).
- **The serving domain** — the signature binds to it; a mismatch is the #1 401.
- **The author's user id** — recorded in the item-bank audit trail.
- For editing, **the item/activity reference**.
- **Which kinds of question authors may add** — say it plainly ("only multiple choice and cloze") and the design will set `question-type-groups`, a picker restriction observed at group granularity.
- Optionally: the specific question types intended, editor options (edit/delete widgets, tags, dynamic content, shared passage), a **specific item bank**, container sizing.

The compiler validates each property, so under-specified or inconsistent designs come back as clear steering warnings to refine.

**A design being expressible is not a promise that Learnosity enforces it.** `question-type-groups`
is verified and may be promised. The widget edit/delete permissions are verified too. `allow-widgets`
(question types) is the one that is **not** — ask for it, and the recipe carries it as *intent*
plus a check that can falsify it. Do not promise a restriction
that has not been observed in a running editor.

## Out of scope

- Authoring item **content** → L0176.
- Programmatic item-bank CRUD (Data API), assessment delivery (Items API), analytics (Reports API)
  → separate sibling dialects, none of which exists yet. Not future L0177 modes: L0177 covers the
  Author API, and that coverage is complete. If you are asked for one of these, say no dialect
  covers it rather than stretching this one.
- Runnable host-language code — the recipe is a language-neutral procedure you implement yourself.
