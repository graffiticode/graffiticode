<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# L0182

L0182 is a **survey record**: a program names a survey the language server holds and carries at
most one response to it. A survey has one of two styles, and the survey declares which:

- **ranked-choice** — a set of options; a response chooses some, in priority order, and may add
  one write-in that was not in the set.
- **rating** — a list of items, each answered on a scale: Likert agreement, frequency,
  importance, satisfaction and likelihood scales, numeric scales such as NPS and stars, and
  semantic differentials. A response rates the items and may add a comment.

An L0182 program is one taking of one survey and at most one response to it.

## Structure

```
survey [
  id "civic-priorities"
  session-id get-val-public "itemId"
]..
```

That is a whole program. What a survey asks is **given, never written**: it belongs to the survey,
which the compiler reads when the program compiles. Nothing in the language describes an option,
an item, a scale, a title, an instruction line or a bound — a survey cannot be authored here at
all, and whoever takes one has not seen it before the first compile. What is written afterwards is
the response.

There is no flow in this language either. It does not describe screens, steps, navigation or
submission, and nothing in it takes a participant through anything. The code is the interface: a
person writes it in the console's editor, an agent writes it through `update_item`, and both
produce the same record.

## Taking a survey

`id` names a survey the language server holds — `civic-priorities`, `team-retro`, `city-budget`,
`product-features` and `school` are ranked-choice; `course-feedback`, `customer-satisfaction`,
`app-usability` and `workplace-pulse` are rating surveys. An id that does not exist is a compile
error listing the ones that do.

A survey may have **several versions**, one per file: `civic-priorities-1`, `civic-priorities-2`,
and so on, each a different set drawn from the same subject. Naming the survey takes one of them at
random; which one is recorded as `instance` in the compiled record. Versions are drawn without
replacement, so successive takings work through them rather than piling onto one.

```
survey [ id "civic-priorities-7" ]..
```

Naming a version outright takes exactly that one, with no draw.

### The session

`session-id` identifies one taking of the survey, and every program should carry it, written
exactly as:

```
survey [ id "workplace-pulse" session-id get-val-public "itemId" ]..
```

`get-val-public` resolves at parse time, so the program carries the value from then on. A survey
is drawn once per session: the turn that adds a response comes back to the same session and gets
the same version, which is what keeps the answer with the survey its taker actually saw.

That memory lives in the language server's process. A restart, or a second server instance, loses
it and the session is drawn for again. Naming the version as the id is what makes an answer
immune.

## What a survey holds

A survey is one JSON file per version, and everything the survey is lives in it. Every file says
its `style`, and carries a `title` and `instructions` — the words a participant reads.

### A ranked-choice survey

```json
{
  "style": "ranked-choice",
  "title": "What Matters Most?",
  "instructions": "Select the issues that matter most to you and put them in priority order.",
  "minChoices": 1,
  "maxChoices": 3,
  "options": [
    { "id": "a3", "text": "protect voting rights" },
    { "id": "b7", "text": "affordable housing" }
  ]
}
```

An option is a line of text, or a record naming the id the originating service knows it by. An
entry that names its own id keeps it — a ranking of positional ids would mean nothing back at that
service — and one that does not is numbered by position, `o0` upward. A set needs at least two
options, and no two may repeat the same text or share an id. An option's id is always a string,
even when it looks like a number.

`minChoices` and `maxChoices` are optional. They default to 1 and 5 — or to one fewer than the set
when the set is smaller, so a default never lets a response name every option there is. Choosing
everything is not choosing.

### A rating survey

```json
{
  "style": "rating",
  "title": "Course Feedback",
  "instructions": "Tell us how far you agree with each statement.",
  "scales": {
    "agree": { "preset": "agreement-5", "optOut": "Not applicable" },
    "ease": { "min": 1, "max": 7 }
  },
  "items": [
    { "id": "goals", "text": "The course met its stated goals", "scale": "agree" },
    {
      "id": "portal",
      "text": "Using the course portal was",
      "scale": "ease",
      "anchors": ["very difficult", "very easy"]
    },
    { "id": "recommend", "text": "Would you recommend it?", "scale": "nps", "required": false }
  ],
  "comment": { "prompt": "Anything else?" }
}
```

An **item** is a line of text, or a record with its `text` and optionally an `id` (numbered `q0`
upward where absent), a `scale`, `required` (default true) and `anchors`. An item with no `scale`
uses the survey's own `scale`.

A **scale** is written as one of:

- a **preset** — `agreement-5`, `agreement-7`, `frequency-5`, `importance-5`, `satisfaction-5`,
  `likelihood-5`, `nps` (0–10, its ends labelled) or `stars-5`; by name, or as `{"preset": …}`;
- **labelled points** — `{"points": ["Never", "Sometimes", "Always"]}`, valued 1 upward, or
  `{"points": [{"value": 0, "label": "No"}, …]}`;
- a **numeric range** — `{"min": 0, "max": 10, "anchors": ["low", "high"]}`, with words for its
  two ends if it has them.

Any of them may add `optOut` — words for an answer outside the scale, such as "Not applicable" —
and `display: "stars"`, a hint to the renderer. A scale has 2 to 11 points, its values are whole
numbers that rise from the first point to the last, and no two points share a label. Named scales
live under `scales` and are referred to by name.

An item's `anchors` are its own words for the two ends of its scale. That is what a **semantic
differential** is: one numeric scale shared by every item, each item placing it between its own
pair of opposite words.

`comment` is `true`, or a record with the `prompt` to ask. Without it, a response cannot carry one.

## The response to a ranked-choice survey

```
survey [
  id "team-retro"
  session-id get-val-public "itemId"
  response [
    choices ["cut the build time in half" "write smaller pull requests"]
    write-in "give every service a named owner"
  ]
]..
```

`choices` names the options chosen, and **the order is the ranking** — first is most important.
No option may appear twice.

An option may be named three ways: by **its exact text**, by **its id**, or by **its position,
counting from 0**. All three resolve to ids in the compiled record, so they differ only in the
source.

Which to use is not a matter of taste. The options live in the survey, so whoever writes a
response has not seen the ids or the positions, and the text is the only thing they can know.
Naming a position there is a guess, and a guess that lands in range compiles cleanly and records
the wrong options. Once the compiled survey has been read back, the id is the better key: it
survives the set being reordered.

Text matching ignores case and surrounding whitespace. A number is always a position and a string
never is, so those cannot collide even when a set's ids look like numbers — `choices [1]` is the
second option, `choices ["1"]` is the option whose id is `1`. Between the two string forms, an id
wins.

`write-in` is one new option, contributed by whoever answered. It must not repeat an option
already in the set; that is what makes it new. It may stand alone, with nothing chosen, where the
survey's floor allows it.

## The response to a rating survey

```
survey [
  id "app-usability"
  session-id get-val-public "itemId"
  response [
    ratings [
      [item "Finding my way around" rating "clear"]
      [item "Getting a task done" rating 5]
      [item "The look of the screens" rating 6]
      [item "How it responds when I make a mistake" rating 3]
      [item "Learning something new in it" rating "easy"]
      [item "How it makes me feel" rating 5]
    ]
  ]
]..
```

`ratings` holds one `[item … rating …]` list per answer. `item` names an item the same three ways
an option is named, for the same reasons — by its text first.

`rating` is the answer on the item's scale. It may be a point's **label**, the item's **anchor**
for one end, the scale's **opt-out**, or a **number** — and a number here is **the scale's own
value, never a position**: `9` on a 0–10 scale is 9, `4` on a five-point agreement scale is
"Agree" because its values run 1–5. Labels match as option text does, forgiving case and spacing.

Every required item must be answered, by a value or by the opt-out; no item may be rated twice.
The order of the entries is free, and the compiled record lists them in the survey's order.

`comment` is free text, accepted only where the survey asks for a comment.

A response uses its survey's words — `choices`/`write-in` for ranked choice, `ratings`/`comment`
for rating — and the other style's words are refused by name.

`response` is written inside the survey's brackets and lifted to the top level of the compiled
record. A survey with no `response` is one awaiting an answer. Because there is no player, the
survey's rules are enforced only here: the compiler is what refuses a response that breaks them.

## Compiled output

A ranked-choice survey and its response:

```json
{
  "survey": {
    "id": "team-retro",
    "sessionId": "7gMeEzUYkHqm3PDRrI8i",
    "instance": "team-retro-1",
    "style": "ranked-choice",
    "title": "What Should We Fix First?",
    "instructions": "These came out of last sprint's retro…",
    "options": [
      { "id": "t1", "text": "fix the flaky tests before adding features" },
      { "id": "t2", "text": "cut the build time in half" },
      { "id": "t3", "text": "write smaller pull requests" }
    ],
    "minChoices": 1,
    "maxChoices": 3
  },
  "response": { "choices": ["t2", "t3"], "writeIn": "give every service a named owner" }
}
```

A rating survey and its response, with every scale resolved to points on its item:

```json
{
  "survey": {
    "id": "course-feedback",
    "instance": "course-feedback-1",
    "style": "rating",
    "title": "Course Feedback",
    "instructions": "…",
    "items": [
      {
        "id": "goals",
        "text": "The course met its stated goals",
        "scale": {
          "name": "agree",
          "points": [
            { "value": 1, "label": "Strongly disagree" },
            { "value": 2, "label": "Disagree" },
            { "value": 3, "label": "Neither agree nor disagree" },
            { "value": 4, "label": "Agree" },
            { "value": 5, "label": "Strongly agree" }
          ],
          "optOut": "Not applicable"
        },
        "required": true
      }
    ],
    "comment": { "prompt": "Is there anything else you would like to tell the instructors?" }
  },
  "response": {
    "ratings": [
      { "item": "goals", "value": 4 },
      { "item": "pace", "optOut": true }
    ],
    "comment": "More worked examples, please."
  }
}
```

The renderer shows a ranked-choice survey side by side — the set as it was drawn on the left, and
the choices in priority order with the write-in on the right — and a rating survey as one row per
item, its scale laid out with the answer marked on it.
