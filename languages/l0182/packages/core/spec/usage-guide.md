<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Using L0182

## Overview

L0182 is a survey record. A program names the survey being taken and — once something has
answered — carries the response to it. A survey has one of two styles. A ranked-choice survey is a
set of options: the response chooses some in priority order and may add one write-in that was not
in the set. A rating survey is a list of items, each answered on a scale — Likert agreement,
frequency, importance or satisfaction scales, NPS and other numeric scales, star ratings, and
semantic differentials — and the response rates the items, opting out where a scale allows it and
adding a comment where the survey asks for one. The survey itself is NOT written in the program.
Its options or items, its scales, its title, its instructions and its bounds come from the back
end, which the compiler reads when the program compiles, so whoever takes a survey has not seen it
beforehand and cannot edit it. A survey may hold several versions, and taking it draws one of them
at random; the version drawn is recorded in the compiled record. L0182 describes no flow at all:
no screens, no steps, no navigation, no submission, and nothing that aggregates across
respondents. The code is the interface — a person edits the program in the console's editor, an
agent edits it through `update_item`, and both produce the identical record, which the renderer
shows beside the survey it answers.

## Getting started

The smallest program is the survey's id and the session taking it:

```
survey [ id "civic-priorities" session-id get-val-public "itemId" ]..
```

That is a survey awaiting a response. `id` says which survey this is, and the compiled record
comes back with its style, its title, its instructions and what it asks.

Write `session-id get-val-public "itemId"` verbatim in every program. It names one taking of the
survey, and it is what brings the same version back on the turn that answers.

## The surveys you can take

| `id`                    | Style         | The survey                                               |
| :---------------------- | :------------ | :------------------------------------------------------- |
| `civic-priorities`      | ranked-choice | civic priorities — twelve versions, one drawn per taking |
| `team-retro`            | ranked-choice | eight engineering-team retro options                     |
| `city-budget`           | ranked-choice | ten neighbourhood projects a council could fund          |
| `product-features`      | ranked-choice | nine features customers have asked for                   |
| `school`                | ranked-choice | seven school improvements                                |
| `course-feedback`       | rating        | course feedback: agreement, ease of use, NPS, a comment  |
| `customer-satisfaction` | rating        | a store visit: satisfaction, stars, NPS                  |
| `app-usability`         | rating        | six semantic-differential lines about an app             |
| `workplace-pulse`       | rating        | a pulse survey — three versions, one drawn per taking    |

An id that does not exist is a compile error listing the ones that do. A survey's versions are
numbered — `civic-priorities-1`, `civic-priorities-2`, … — and naming one takes it outright, with
no draw.

## Answering a ranked-choice survey

```
survey [
  id "team-retro"
  session-id get-val-public "itemId"
  response [
    choices ["cut the build time in half" "fix the flaky tests before adding features"]
    write-in "give every service a named owner"
  ]
]..
```

`choices` names the options chosen and **the order is the ranking** — first is most important.
Name each option by its **exact text**: the options live in the survey, so the ids are not
something you can know when you write the response, and a guessed position compiles cleanly while
recording the wrong option. An id or a position counting from 0 is accepted only when the compiled
survey is in front of you. `write-in` is one new option that must not already be in the set; that
is what makes it new, and it may stand alone with nothing chosen.

## Answering a rating survey

```
survey [
  id "course-feedback"
  session-id get-val-public "itemId"
  response [
    ratings [
      [item "The course met its stated goals" rating "Agree"]
      [item "The pace of the course was right for me" rating "Disagree"]
      [item "The course materials were clear" rating "Agree"]
      [item "Feedback on my work was timely and useful" rating "Strongly agree"]
      [item "The lab sessions helped me apply what I learned" rating "Not applicable"]
      [item "Using the course portal was" rating 6]
    ]
    comment "The labs felt rushed."
  ]
]..
```

`ratings` holds one `[item … rating …]` list per answer. Name each item by its exact text, for the
same reason as an option. The `rating` is a label on the item's scale, the item's own word for one
end, the scale's opt-out, or a number — and a number is **the scale's value, never a position**:
`9` on a 0–10 scale is 9. Every required item must be answered; an optional one, like the
recommendation question above, may be left out. `comment` is accepted only where the survey asks
for one.

Keep `session-id` when you add the response. Without it the survey may be drawn again, and the
answer checked against a version its taker never saw.

## Bounds and scales, and why they matter here

`minChoices` and `maxChoices` belong to a ranked-choice survey, not to the program. They default to
1 and 5 — or to one fewer than the set when the set is smaller, so a default never lets a response
name every option there is. Choosing everything is not choosing. A rating survey's scales, its
opt-outs and which items are required are likewise the survey's.

Nothing enforces these at delivery, because there is no delivery. The compiler is the only check
there is, which is why it refuses a response that breaks them rather than clamping it.

## What you do not write

The survey. There is no word for an option, an item, a scale, a title, an instruction line or a
bound, and writing one is a compile error rather than an override — the survey is the back end's,
and a survey its taker could edit would not be one.

A flow, either. L0182 has no ordering, no navigation or submission modes, and no results screen —
it does not aggregate anything across respondents. If a survey-taking flow is wanted, that is a
different language or a different client reading this record.
