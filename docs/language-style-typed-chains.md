# Language style: typed members and attribute chains

The surface L0183 (concept webs) moved to on 2026-09-24, and the style to start a new dialect
from. It keeps what `language-authoring-style.md` got right — generated handlers, a hand-kept
legality table per container, error messages that say where a word belongs, docs that must
compile — and changes how one thing is described: a **chain** of arity-2 words instead of a
bracket list of arity-1 words, with every member of a list **typed** by its own word.

Reference implementation: `l0183/packages/core/src/` (`attributes.ts`, `compiler.ts`,
`web.ts`). The dialects built on the attribute-list style (L0176, L0179, L0180, L0182) are not
wrong and are not being converted; §8 says when that style still fits.

---

## 1. The style in one program

```
concept-web [
  hub text "The Cell" {}
  nodes [
    node text "Nucleus" {}
    node text "Ribosome" assess [expected points 2] {}
    node text "Chlorophyll" assess [distractor points -1] {}
  ] tray-align left {}
  edges [
    edge from "The Cell" to "Nucleus" label "contains" {}
  ] {}
] title "Parts of a cell" theme DARK {}..
```

Four constructs, and nothing else:

| Construct | Arity | Example | Evaluates to |
| :-------- | :---- | :------ | :----------- |
| **chain word** | 2 — value, rest of chain | `text "Nucleus" color "blue" {}` | the chain's record plus its key |
| **typed member** | 1 — a chain | `node text "Nucleus" {}` | `{node: {...}}` |
| **container** | 2 — a list, then a settings chain | `nodes [ … ] tray-align left {}` | the typed members, and the settings |
| **flag** | 0 | `expected`, `distractor` | `{expected: true}` |

A chain ends in a record, so `{}` is where every description stops. The last row is a bracket
list's vocabulary only: the one bracket list left inside a description (`assess [ … ]`) holds a
**set of flags and scalars**, never a description of a thing.

---

## 2. Why

**One way to write a property, everywhere.** A node's `text`, a container's `tray-align` and
the program's `title` are the same kind of word: arity 2, value then rest. Under the
attribute-list style, attributes were arity 1 and settings arity 2, so every word had a
position it was *not* allowed in, and the most common generator mistake was writing a setting
inside the brackets. That whole error class is gone: a word can still be written in the wrong
chain, but never in the wrong *form*.

**Members say what they are.** `nodes [ node … {} node … {} ]` lets the container reject a
member of the wrong kind by name — "member 2 is an `edge`, not a `node`" — where an untyped
`[ [ … ] [ … ] ]` could only accept whatever merged.

**The answer lives where it is shown.** A blank carries its own answer as its text,
`node text "Ribosome" assess [expected] {}`, and the compiler moves it into the answer key and
strips it from what is drawn. A wrong answer is a member too, `assess [distractor]`, in the
list whose tray it joins. There is no parallel structure — no `expected "…"` string repeating
the text, no `distractors [...]` list per tray — for the generator to keep in sync, and nothing
that can drift.

**Descriptions read as prose.** `edge from "Grass" to "Rabbit" label "eaten by" {}` is one line
a reviewer can check against the prompt by eye, with no bracket nesting to count.

---

## 3. The rules

1. **Everything that describes one thing is a chain ending in `{}`.** Descriptions of members,
   the hub, and every settings record. Order within a chain does not matter; a word may appear
   once per chain.
2. **A member list is typed.** Its elements are all written with the same member word. The
   container is arity 2 and takes the list *and* its settings chain — `{}` when there are none.
3. **The program is a container too.** `concept-web [ parts ] settings {}..` — its list holds
   its parts (`hub`, `nodes`, `edges`), each written with its own word.
4. **Bracket lists hold sets of flags and scalars, not things.** `assess [expected points 2]`.
   Their words are arity 0 (flags) and arity 1 (scalars), and they merge into one object.
5. **Closed sets are bare tags.** `theme DARK`, `tray-align left`. A tag can be lowercase: it is
   just a lexicon entry `{tk: 22, name: "TAG", cls: "val", arity: 0}`, and reaches the
   Transformer as `{tag: "left"}`.
6. **Name every word for the field it emits**, kebab-case (`tray-align` emits `trayAlign`), and
   keep a field→word map so error messages print the source spelling.

---

## 4. The machinery

Three tables in `attributes.ts` drive the lexicon, the Checker and the Transformer. Adding a word
is a row; never hand-write a handler.

```ts
export const chainFields  = { TEXT: {field: "text", expects: "text"}, TRAY_ALIGN: {…}, … };  // arity 2
export const memberFields = { HUB: {field: "hub", expects: "record"}, NODE: {…}, EDGE: {…} }; // arity 1
export const assessFields = { EXPECTED: {expects: "flag"}, POINTS: {expects: "number"}, … };  // 0 or 1
```

**The chain word** checks its value, requires the rest to be a record, and adds its key:

```ts
this.visit(node.elts[0], options, (e0, v0) => {
  this.visit(node.elts[1], options, (e1, v1) => {
    const rest = toPlainObject(v1);
    if (!isRecord(rest)) /* "a chain must end in a record — write `{}` after the last word" */;
    if (meta.field in rest) /* "is given twice" */;
    resume(err, { ...rest, [meta.field]: value });
  });
});
```

**The typed member** checks that its argument is a record and returns `{[word]: record}`.

**A flag** is an arity-0 function (`{tk: 1, cls: "function", arity: 0}`); the parser emits
`{tag: "EXPECTED", elts: []}`, and its handler returns `{expected: true}` without visiting
anything. Its Checker method must not visit children either.

**The container** (`memberList`) checks each member's type and, member by member, that member's
words against `validAttributes` — see trap 5.2 for why in that order. Web-level rules (ids,
references, blanks, trays) live after it, in plain code over plain objects (`web.ts`).

**Legality** is still two hand-kept tables — `validAttributes` (what each description accepts)
and `validSettings` (what each settings record accepts) — and still the highest-value check in
the language: a chain builds whatever record it is handed, so a misplaced word compiles clean
and does nothing unless something rejects it. One `hintFor(word, container)` serves both, and
says where the word belongs: "is a setting and goes after the `]` of nodes", "belongs inside
`assess [ … ]`", "is a member of `nodes`".

Unchanged from the attribute-list style: value checking lives in the Transformer, because
`Checker.LIST` visits only `elts[0]` (`language-authoring-style.md` §7.1), and every arity-2
Checker method visits **both** children.

---

## 5. The traps

### 5.1 A missing `{}` before `]` is a parse error

```
nodes [ node text "B" ] {}        →  Too few arguments for TEXT. Expected 2.
```

The chain word swallows the `]` as its second argument and the parser gives up before the
compiler runs, so **no compiler message can improve this**. It is the price of the style. Pay
it in the docs: `instructions.md` says, near the top and in bold, that every member ends in
`{}`, and every example follows it. The old bracket form, `node [text "B"]`, dies the same way.

### 5.2 An arity-1 word in a chain strands the `{}`

```
node text "B" points 2 {}
```

`points` is arity 1, so the chain ends at `points 2` and the `{}` becomes the list's next
member. Checked in the wrong order, the error blames the stray `{}` ("member 2 is a record, not
a `node`"). Validate each member's words **as you reach it**, before looking at the next one,
and the error lands on the word that caused it: "`points` belongs inside `assess [ … ]`, e.g.
assess [expected points 2]". Say "a stray `{}`" when an empty record is what you find.

### 5.3 The answer must not reach the view

When a blank carries its answer in its text, the compiler must strip it from the drawn node and
keep it only in the answer key. A graded delivery withholds the key; it cannot withhold a field
it does not know is the answer. Test it: assert the interaction JSON does not contain the
answer string.

### 5.4 A member that is not drawn must not be referenceable

A distractor is a member of `nodes` but not a node in the web. Build the reference table
(what `from`/`to` resolve against) from the drawn members only, and say so in the error.

---

## 6. Errors

The rule from `language-authoring-style.md` §7.3 holds unchanged, and matters more here because
the chain syntax gives the generator fewer structural cues: every message names what is legal,
where the misplaced word belongs, and an example written in the new syntax. `errors.test.ts`
asserts the exact wording, because the generator reads it and retries.

---

## 7. Checklist for a new language

1. Name the things (members) and give each a word: arity 1, taking a chain.
2. Name each thing's properties as chain words: arity 2, kebab-case of the emitted field.
3. Name each list of things as a container: arity 2, a typed list then a settings chain.
4. Use a bracket list only for a set of flags and scalars; flags are arity 0.
5. Put answers where they are shown, marked by a flag; derive keys, trays and similar
   structures from them in the compiler. Never make the author repeat a value.
6. Write the three tables and the two legality tables; generate every handler.
7. In the container, check member type and member words in order (§5.2).
8. Make `instructions.md` say, prominently, that every member ends in `{}` (§5.1).
9. Compile every program in the docs in a test (`docs.test.ts`), and hold the docs' tables equal
   to the legality tables.
10. Rebuild the RAG corpus from `examples.md` after any surface change. Delete the old vectors
    first: generation retrieves from them, and old-syntax examples are copied into new programs.

---

## 8. When the attribute-list style still fits

`language-authoring-style.md` describes the arity-1 attribute-list style of L0176, L0179,
L0180 and L0182. It remains the better fit when the target is a **deep, heterogeneous
document** whose nesting the source should mirror field for field — Learnosity question JSON is
the example — and where the same property word appears at many depths. Typed chains fit when
the program is **a few kinds of thing, each with a flat set of properties** — nodes, edges,
cells, options — and the author's mistakes are about *which* thing a property belongs to.

Do not mix the two within a dialect: one word has one arity in the lexicon, and a language whose
descriptions are sometimes chains and sometimes lists is a rule the generator has to remember
rather than apply.
