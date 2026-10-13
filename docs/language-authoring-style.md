# Language style: attribute lists, not chained attributes

> **Newer style:** L0183 (2026-09-24) uses typed members and attribute chains —
> `nodes [ node text "A" {} ]` — described in `language-style-typed-chains.md`, which is the
> style to start a new dialect from. This document remains the reference for L0176, L0179,
> L0180 and L0182, and for the parts both styles share (generated handlers, §7's traps).

How to encode a language's attributes when you are building a new `l0NNN` dialect. This is the
style L0176 uses and the one to copy; L0166 shows the older chained style, which is still
correct for what it does. The audience is whoever (or whatever) is authoring a new language —
the decision described here is made once, early, and is expensive to reverse, because it
changes every program the dialect will ever have in its RAG corpus.

Companion to `language-routing-and-composition.md`, which covers what a language must publish
(`scope.json`, `composesWith`) rather than how its source looks.

---

## 1. The two encodings

**Chained (arity 2).** Every attribute word takes its value *and the rest of the chain*, so a
program is a right-nested chain terminated by `{}`. L0166:

```
cell "A1" text "Total" background-color "#eee" font-weight "bold" assess [
  method "value" expected "836" points 2
] {}
```

`cell`, `text`, `background-color`, `font-weight`, `assess` are all `arity: 2`. Only the three
words inside the `assess` brackets — `method`, `expected`, `points` — are `arity: 1`.

**Attribute lists (arity 1).** Every attribute word takes exactly one argument and evaluates to
a single-key record. A `[...]` list of them merges into one object. L0176:

```
choicematrix [
  stimulus "Mark each statement True or False."
  stems [ "The Bill of Rights is the first ten amendments" "The President can declare war" ]
  options [ "True" "False" ]
  validation [
    scoring-type "partialMatch"
    valid-response [ score 1 value [[0] [1]] ]
  ]
]
```

Nothing here is chained. `stimulus`, `stems`, `options`, `validation`, `scoring-type`,
`valid-response`, `score`, `value` are all `arity: 1`, and the same word means the same thing
at any depth.

---

## 2. Two kinds of list — the distinction to get right first

Both are written `[...]`, and the grammar cannot tell them apart. What differs is whether the
elements are *the same kind of thing* or *different named properties*, and nearly everything
else about the design follows from that.

**Attribute list — heterogeneous.** A list of attribute expressions. Each element is a
different word applied to a value, each computes a single-key record, and the enclosing word
merges them into one object. This is the `choicematrix [...]` body above, and the
`validation [...]` inside it.

```
validation [ scoring-type "partialMatch" valid-response [ score 1 value [[0]] ] ]
```

The enclosing word is **arity 1**: it takes the list and nothing else.

**Member list — homogeneous.** A list of child elements, all the same kind. The enclosing word
does not merge them; it keeps them as a sequence.

```
questions [q1 q2 q3] {a1 a2 a3}
```

Here the word is **arity 2**, because it needs a second argument role: the children *and* its
own configuration. The braces compute a configuration record for the container itself, which
L0176's `QUESTIONS` merges with what it built:

```js
const continuation = toPlainObject(v1);                 // the {…} record
const val = { ...continuation, ...questionsResult };    // computed fields win
```

`{}` is therefore the *empty* configuration, not a terminator — which is why real programs are
full of `items [...] {}` and `questions [...] {}`.

**The two nest freely, and usually do.** A member list's elements are very often attribute
lists — `options [ [label "Mercury" value "0"] [label "Venus" value "1"] ]` is a homogeneous
list of children, each of which is a heterogeneous attribute list.

| | attribute list | member list |
| :--- | :--- | :--- |
| elements | heterogeneous — different named properties | homogeneous — the same kind of child |
| computes | one merged object | a sequence |
| enclosing word | arity 1 | arity 2 |
| second argument | — | an expression computing a configuration record |
| example | `validation [scoring-type "…" valid-response […]]` | `questions [q1 q2 q3] {…}` |

**A member list always takes a configuration record; an attribute list never does.** Keep this
uniform even where the record is empty — `cells [...] {}` reads as "these children, no
configuration", and a word that sometimes takes the slot and sometimes does not is a rule the
generator has to remember rather than apply. (L0176 predates this convention and has arity-1
member lists such as `options [...]`; new languages should adopt the uniform rule.)

That second argument is *any expression computing a record*, not only a literal — see §3, where
a chain of arity-2 attribute functions builds one without brackets.

Naming note for anyone reading the reference implementation: L0176's code calls the attribute
machinery `memberFields` and `mergeMembers`, which predates this distinction. In a new
language name them for what they are — `attributeFields`, `mergeAttributes` — and reserve
"member" for the children of a member list.

**Binding is the other reason for arity 2.** `set-var` takes a name and a value and writes
`options[name] = value`:

```js
SET_VAR(node, options, resume) {
  this.visit(node.elts[0], options, (e0, v0) => {       // the name
    this.visit(node.elts[1], options, (e1, v1) => {     // the value
      options[v0] = v1;
      resume([...e0, ...e1], v1);
    });
  });
}
```

The scope comes from `options` being one mutable object threaded through the entire traversal,
over a program that is a *sequence* of expressions — not from the word swallowing what follows.

```
set-var "lrn-id" get-val-public "itemId"
items [ item [ questions [ mcq [ … ] ] {} ] ] {}..
```

Descendants read `options["lrn-id"]`. You need this for anything the whole program must see —
ids, credentials, render-time parameters — and it cannot be an attribute, because an
attribute's value lands in the record its list merges into, never in the environment. Reuse the
base language's `set-var` rather than minting a dialect word: L0176 carried an `id` alias for
exactly this key, it went unused in all 169 training examples, and it has been removed.

**A keyed entry is the third reason for arity 2.** A member list of addressable things needs
each element to carry both its key and its attributes, which is a positional key plus an
attribute list:

```
cells [
  cell A1 [text "Total" font-weight "bold"]
  cell B1 [text "" assess [method "value" expected "836"]]
]
```

`cell` is arity 2 — `(address, attribute list)`. Nothing merges the address into the attributes;
the container keys the entry by it.

**The rule.** A word is arity 1 unless it needs a second argument role, and there are three:
children *plus* configuration, a key *plus* its attribute list, or a name *plus* a value to bind.

For contrast, in the chained style the second argument is the *accumulating record*: L0166's
`TEXT` returns `{ ...v1, text: v0 }`, so each attribute prepends itself onto the record built
by the words after it, and `{}` closes the chain. Same `(value, record)` grammar, entirely
different meaning — and it is why every attribute word in that dialect must be arity 2.

---

## 3. Attribute functions, and their two forms

An **attribute function** computes one named property. It has two forms, and which one a word
takes is decided by where the word is used.

**Arity 1 — an element of an attribute list.** It evaluates to a single-key record, and the
enclosing container merges the list:

```
text "Total"        ->  { text: "Total" }
```

This is the form the whole style is built on, and the one to reach for by default.

**Arity 2 — chaining into a configuration record.** It takes its value *and a continuation*,
and returns the continuation's record with its own key added:

```js
// L0166's TEXT, the canonical shape.
TEXT(node, options, resume) {
  this.visit(node.elts[0], options, (e0, v0) => {       // the value
    this.visit(node.elts[1], options, (e1, v1) => {     // the rest of the chain
      resume([...e0, ...e1], { ...v1, text: v0 });      // prepend onto the accumulating record
    });
  });
}
```

which is what lets a record be accumulated without brackets:

```
sheets [ sheet "s1" [ … ] ] params {
  A1: "Fees earned"
} {
  v: "0.0.1"
}..
```

Read that as `sheets(list, params({…}, {v: "0.0.1"}))`: the chain terminates in a record literal,
and the whole tail computes the configuration record the member list takes as its second
argument. `cells [...] {}` is the same shape with an empty literal and no chain.

**A chaining attribute is not obliged to merge, and one in L0166 does not.** Its contract is
only "compute a record from your value and your continuation"; merging is the normal way to
honour it. `PARAMS` instead visits `elts[0]` alone and returns `{templateVariablesRecords: …}`,
discarding the continuation entirely — which is why the trailing `{v: "0.0.1"}` never reaches
the output. That is a deliberate transform (params expand into generated rows), but it means a
reader cannot assume the tail of a chain survives. If a chaining attribute in your language
replaces rather than merges, say so where it is documented.

**This is the chained style, surviving in one place.** In L0166 every attribute word is arity 2
and the entire program is one such chain. Here it is confined to the configuration slot, where
there is no container to merge an attribute list and a chain is the natural way to build the
record. Everywhere else, attributes are arity 1.

**Choosing.** The lexicon gives a word exactly one arity, so an attribute belongs to one form or
the other — decide by position, not taste:

- Does it describe the thing its container is building? Arity 1, inside an attribute list.
- Does it configure the program or a whole member list, sitting outside any attribute list?
  Arity 2, chaining.

Keep the set of arity-2 attributes small and stated. Each one is a word the generator must
place outside the brackets, which is exactly the kind of thing it gets wrong — and a misplaced
one lands in a record nothing reads, which §7.2 covers.

---

## 4. The whole surface syntax, in three rules

An author (usually an LLM) needs exactly this much to write any attribute:

| Target shape | How it is written |
| :----------- | :---------------- |
| object | an attribute list — `validation [scoring-type "exactMatch"]` |
| array of objects | a member list of attribute lists — `alt-responses [[value ["a"]] [value ["b"]]]` |
| scalar, or array of scalars | the value itself — `case-sensitive false`, `options ["True" "False"]` |

Three rules, no per-attribute syntax to memorize. That is the payoff of the style and the
reason to prefer it: the instructions file states the mapping once instead of documenting a
shape per word, and the generator's job collapses to "name the field, give it its value."

---

## 5. Why this style

- **One word, any depth.** `value` inside `valid-response` and `value` inside an mcq option are
  the same arity-1 word. Under chaining they would be separate positional constructs.
- **The source mirrors the target 1:1.** Each word is the kebab-case spelling of the field it
  emits, nesting the way that field nests. There is no translation table for the generator to
  get wrong, and a reviewer can diff source against target by eye.
- **Handlers are generated, not written.** Adding an attribute is a row in a data table, not a
  new Checker method plus a new Transformer method. L0176 carries 132 attribute words this
  way; hand-writing pairs for them would be 264 near-identical methods.
- **It makes attribute legality checkable.** Because every attribute is a single-key record
  keyed by field name, a container can compare the keys it received against the set it
  accepts. That check is the single highest-value thing in this document — see §7.

---

## 6. The machinery

Reference implementation: `l0176/packages/core/`. Four pieces.

**6.1 Lexicon — a flat global vocabulary.** Every attribute is
`{ tk: 1, name: "UPPER_SNAKE", cls: "function", length: 1, arity: 1 }`. The lexicon is *not*
where you scope which container accepts which word; it is global on purpose, so the same word
works everywhere it legitimately appears. (`lexicon.ts`)

**6.2 An attribute table — name → field + shape.** One row per word:

```ts
export const attributeFields: Record<string, { field: string; shape?: Shape }> = {
  STIMULUS:       { field: "stimulus" },                            // scalar, pass through
  VALIDATION:     { field: "validation",    shape: "object" },      // merge the attribute list
  ALT_RESPONSES:  { field: "alt_responses", shape: "objectArray" }, // merge each attribute list
  OPTIONS:        { field: "options",       shape: "infer" },       // decided by element type
};
```

`infer` exists for words the target gives different types on different containers. L0176 uses
it for `options` and `value`; the readings are mutually exclusive by element type (attributes →
one object, attribute lists → array, lists of attribute lists → array of arrays), so nothing is
guessed. Reach for it only when the target forced your hand. (`question-types.ts`)

**6.3 Generated handlers.** Loop the table and install both methods:

```ts
// Checker: walk the child expression only. Value validation does NOT go here — see §7.1.
for (const name of Object.keys(attributeFields)) {
  Checker.prototype[name] = function (node, options, resume) {
    this.visit(node.elts[0], options, (e0) => resume([].concat(e0 || []), node));
  };
}

// Transformer: return a single-key record; whatever encloses it merges the list.
for (const [name, meta] of Object.entries(attributeFields)) {
  Transformer.prototype[name] = function (node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      /* apply meta.shape to v0 */
      resume(err, { [meta.field]: value });
    });
  };
}
```

**6.4 `mergeAttributes` — merge, or throw.** Containers fold an attribute list into one object.
Malformed entries must be a compile error, never a silent drop:

```ts
export function mergeAttributes(attrs: any, where: string) {
  if (!Array.isArray(attrs)) {
    throw new Error(`${where}: expected an attribute list in [brackets], e.g. [score 1 value "x"].`);
  }
  const out = {};
  for (const a of attrs) {
    if (a == null || typeof a !== "object" || Array.isArray(a)) {
      throw new Error(`${where}: every entry must be an attribute applied to a value, e.g. [score 1 value "x"].`);
    }
    Object.assign(out, a);
  }
  return out;
}
```

Note `Object.assign`: a repeated key silently wins. Decide deliberately whether a duplicate
attribute is an error in your dialect; if it is, check before assigning.

Telling the two list kinds apart at runtime, where a word can take either, is a test on the
elements: every element a single-key record means an attribute list; anything else is a member
list. L0176's `isMemberList` does exactly this, and the readings do not overlap.

---

## 7. The three traps

Each of these has actually bitten a shipped language. They are properties of the style, not
mistakes anyone made twice.

### 7.1 `Checker.LIST` visits only the first element

In the base compiler (`basis/src/compiler.js`, and identically in L0000):

```js
LIST(node, options, resume) {
  if (node.elts.length === 0) { resume([], node); }
  else { this.visit(node.elts[0], options, (e0) => resume([].concat(e0), node)); }
}
```

`Transformer.LIST` visits every element; `Checker.LIST` visits **only `elts[0]`**. So a
validation rule written as a Checker method fires only for the first element of any list —
which, in a style built on lists, means almost nowhere. L0166 hit this exactly: a Checker rule
rejecting negative `points` did nothing in `assess [method … expected … points -1]`, which
compiled clean with `points: -1`.

**Consequence for the style: put value validation in the Transformer**, where the values are
known and every element is visited. L0176's generated Checker methods deliberately do nothing
but walk the child.

If you truly need a Checker-time rule, have the *container's* Checker walk its own list.
Do not override `LIST` globally to visit all elements: it will newly surface errors that were
previously swallowed everywhere else in the language, and existing programs that compiled will
stop compiling.

### 7.2 Open records swallow misplaced attributes

An attribute list merges whatever it is handed. An attribute written one level too high lands
in the wrong object, and most targets ignore unknown fields silently — so it compiles, renders,
and quietly does not do what it says. L0176 shipped this for a while at the block levels:
`item [instant-feedback true questions [...] {}]` compiled clean and had no effect.

**The fix is an explicit allowed-set per container, and an error that names it:**

```ts
function assertKnownAttributes(type, key, attrs) {
  const allowed = validAttributes[key];
  if (!allowed) return;
  const unknown = Object.keys(attrs).filter((k) => !allowed.includes(k));
  if (!unknown.length) return;
  throw new Error(`${type}: \`${unknown[0]}\` is not an attribute of ${type}. It takes: ${allowed.join(", ")}.`);
}
```

Do this for block levels too, not just leaf containers — that is where it was missed.

### 7.3 The compiler's error message is a product surface

The generator is an LLM that reads your compiler's output and tries again. A message that
names what is legal, and where the misplaced attribute belongs, is worth more than any amount
of prompt text. L0176's:

> choicematrix: `scoring-type` is not an attribute of choicematrix. It takes: feedback-attempts,
> instant-feedback, …, validation. `scoring-type` belongs inside `validation`, e.g.
> validation [valid-response [score 1 value "x"]].

That message plus a one-line correction to the instructions took a deterministic failure
(0 of 3 trials on a fast model) to 10 of 10, permanently and for every model. Budget real
effort here: the "misplaced, and here is where it goes" hint is the highest-leverage half.

---

## 8. Checklist for a new language

1. For each word, decide which list it takes: heterogeneous attributes (arity 1, merged) or
   homogeneous children (a sequence). Then decide arity — a word is arity 1 unless it needs one
   of the three second-argument roles: children *plus* configuration, a key *plus* its attribute
   list, or a name *plus* a value to bind. Reuse the base language's `set-var` rather than
   minting your own binding word.
2. Decide which attributes chain (§3). Keep that set small, state it in `instructions.md`, and
   default everything else to the arity-1 form inside an attribute list.
3. Name every attribute word as the kebab-case spelling of the field it emits. Do not invent
   friendlier names — the 1:1 mapping is the feature.
4. Write the attribute table (`field` + `shape`); generate Checker and Transformer methods from
   it. Do not hand-write per-attribute pairs.
5. Put value validation in the Transformer (§7.1).
6. Define an allowed-attribute set for every container, blocks included, and make the
   violation message name the legal set and the likely correct location (§7.2, §7.3).
7. Document the three shape rules once in `instructions.md`, then document per-word meaning —
   not per-word syntax.
8. Add a spec test that compiles (not merely parses) every program fragment in your docs.
   L0176's `docs.test.ts` catches stale examples before the generator learns them; a wrong
   example in `instructions.md` is reproduced verbatim into generated programs.

---

## 9. When the chained style is still right

This is not a blanket deprecation, and note the new style keeps chaining in one place already:
the configuration slot of a member list (§3). Beyond that, chaining suits a **flat stream of
positioned elements**,
which is what L0166 is: cells, rows, and columns in sequence, each with a handful of
presentation attributes and no deep nesting. Twenty-five chained words there are perfectly
legible.

Attribute lists win when the target is a **nested document with a different attribute set per
node** — Learnosity items, and most JSON APIs. If you find yourself wanting the same attribute
word at two different depths, or writing a positional construct per nesting level, you want
attribute lists.

Conversion can be incremental: L0176 converted one question type at a time, with the lexicon
carrying both the old flat spellings and the aligned vocabulary during the transition, and
`validAttributes` enforcing only the converted types. A dialect does not have to switch in one
change — but a *new* dialect should start here.
