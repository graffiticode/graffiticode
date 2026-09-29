<!-- SPDX-License-Identifier: CC-BY-4.0 -->
**Note:** This document trains the dialect-specific code-generation model. It is not a guide for client AI agents. Client agents must not write Graffiticode directly — describe the intended behavior in natural language and let the Graffiticode backend generate the code.

# Core Graffiticode Instructions

This is the core Graffiticode language — a functional language with prefix notation, first-class lambdas, pattern matching, and immutable data.

## Response Requirements

- **IMPORTANT**: Whatever the user request is, the response should always be a complete Graffiticode program ending with `..`.
- A program is zero or more `let` declarations followed by an **expression block**: one or more expressions evaluated in order. The value of the last expression is the program's result.

## Program Structure

```
let name = value..
expression
expression..
```

A program has exactly one `..` at the very end, plus one after each `let`
binding. **Everything after the program's final `..` is discarded — silently,
with no error.** Writing `..` after an expression that is not a `let` therefore
throws away the rest of the program.

### Minimal example

```
add 1 2..
```

### With let bindings

```
let double = <x: mul 2 x>..
map (double) [1 2 3]..
```

### An expression block

Expressions in a block are written one after another with **no separator
between them** — no `..`, no comma. An expression ends as soon as its arguments
are supplied, and the next expression simply follows:

```
set-var "greeting" "hello"
print get-var "greeting"..
```

That is two expressions: `set-var` takes 2 arguments and is complete after
`"hello"`, then `print …` follows as the next expression and its value is the
program's result. Writing `set-var "greeting" "hello"..` instead would end the
program at that point and discard the `print` line.

A complete expression is **not** a complete program. When a program needs
several steps — bind a variable, then build the result — write them as
consecutive expressions in one block and terminate only at the end.

## Syntax Rules

- **Prefix notation**: Functions are applied by writing the function name followed by its arguments: `add 1 2`
- **Fixed arity**: Every function has a known number of parameters, so applications parse unambiguously without grouping: `add 1 mul 2 3` parses as `add(1, mul(2, 3))`
- **Parentheses defer application**: `map (double) [1 2 3]` passes `double` as a value rather than applying it
- **Parentheses only group**: `(1 2)` means `1 2`. There are no tuples and no commas inside parentheses; use a list (`[1 "a"]`) instead
- **Built-ins as values**: Parenthesize a built-in to pass it as a function: `apply (add) [1 2]`, `reduce (max) 0 xs`, `map (not) xs`. Without parentheses it is applied, so `apply add [1 2]` is a parse error ("Too few arguments for ADD")
- **Program terminator**: A program ends with `..`, and `..` appears nowhere else except after `let` bindings. It terminates the whole program, not an expression — text following it is dropped without an error.
- **Let terminator**: Every `let` binding ends with `..`
- **No expression separator**: Consecutive expressions in a block are juxtaposed. Argument boundaries come from arity alone, so `add 1 2 add 3 4` is two complete expressions, not one
- **Comments**: Block comments are enclosed in `/* ... */`
- **Templates**: Backtick strings interpolate, converting each `${…}` with `str`: `` `${name} is ${age}` ``. `concat` only accepts two strings or two lists, so `concat "age: " 30` is an error; use a template or `str`

## Data Types

- **Numbers**: `42`, `3.14`, `-1`
- **Strings**: `"hello"`
- **Booleans**: `true`, `false`
- **Lists**: `[1 2 3]`
- **Records**: `{name: "Alice", age: 30}`
- **Tags**: `tag red`, `tag foo`
- **Lambdas**: `<x: add x 1>`, `<x y: add x y>`

## Tags

Tag values are symbolic constants created with the `tag` keyword:

```
let red = tag red..
let blue = tag blue..
```

Tags have value semantics — same name means same tag. Tags can be matched in `case` expressions:

```
let color = tag red..
case color of
  red: "warm"
  blue: "cool"
  _: "other"
end..
```

## Pattern Matching

```
case x of
  0: "zero"
  1: "one"
  _: "other"
end
```

| Pattern | Matches | Binds |
| :------ | :------ | :---- |
| `_` | anything | nothing |
| `x` | anything | `x` |
| `1`, `"s"`, `true`, `null` | an equal value | nothing |
| `tag red` | the tag `red` | nothing |
| `[p1 p2]` | a list of exactly that many elements, each matching | what each `p` binds |
| `{k}` | a record with field `k` | `k` |
| `{k: p}` | a record whose field `k` matches `p` | what `p` binds |

Lists match exactly their length: `[x y]` does not match `[1 2 3]`. Records are open: `{name}`
matches any record with a `name` field, whatever else it holds. Patterns nest, and literals,
tags and `_` work at any depth. A pattern's variables are bound in its clause only, and a
variable may appear once per pattern. The first matching clause wins; if none matches, the
result is `{}`.

```
case shape of
  {kind: tag circle r}: mul 3 mul r r
  {kind: tag rect w h}: mul w h
  [x y]: add x y
  _: 0
end
```

`let` destructures with the same list and record patterns, binding every variable for the
rest of the program:

```
let [a b] = [1 2]..
let {name age: years} = person..
```

Lambda parameters destructure the same way. A pattern parameter takes one argument, and its
variables are bound in the body. The first line below evaluates to 60:

```
<[x y] z: add add x y z> [10 20] 30..
map (<{name age: years}: years>) people..
```

A `let` or parameter pattern may only bind variables (and use `_`), and never fails to match:
a missing element or field is undefined. Use `case` when a value's shape varies. Parameters of
a named function (`let f [a b] = ...`) cannot be patterns.

## Record Shorthand

Fields where the value is a variable of the same name can use shorthand:

```
let x = 1..
let y = 2..
{x y z: 3}..
```

This is equivalent to `{x: 1, y: 2, z: 3}`.

## Available Functions

| Function | Signature | Description |
| :------- | :-------- | :---------- |
| `add` | `<number number: number>` | Adds two numbers |
| `and` | `<bool bool: bool>` | Logical AND |
| `append` | `<any list: list>` | Appends an element to the end of a list |
| `apply` | `<function list: any>` | Applies a function to a list of arguments |
| `concat` | `<string\|list string\|list: string\|list>` | Concatenates two strings or two lists |
| `cons` | `<any list: list>` | Prepends an element to a list |
| `data` | `<record: record>` | Returns upstream task data, or the argument if none. Argument may be a record literal (e.g. `data {x: 1}`) or `use "<lang>"` to declare the upstream language |
| `div` | `<number number: number>` | Divides numbers |
| `drop` | `<integer list: list>` | Returns a list with the first n elements removed |
| `eq` | `<number number: bool>` | Numeric equality |
| `equiv` | `<any any: bool>` | Semantic equivalence for any type, including tags |
| `filter` | `<function list: list>` | Keeps items matching predicate |
| `ge` | `<number number: bool>` | Greater than or equal |
| `get` | `<string record: any>` | Retrieves a value from a record by key |
| `get-val-private` | `<string: string>` | Resolves a named variable, encrypted at parse time and decrypted at compile time |
| `get-val-public` | `<string: string>` | Resolves a named variable as plain text |
| `get-var` | `<string: any>` | Gets the value of a named variable |
| `gt` | `<number number: bool>` | Greater than |
| `hd` | `<list: any>` | First item of list |
| `isempty` | `<list: bool>` | Returns true if the list is empty |
| `json` | `<string: any>` | Parses a string as JSON |
| `str` | `<any: string>` | Converts any value to display text; lists and records in Graffiticode syntax |
| `last` | `<list: any>` | Returns the last element of a list |
| `le` | `<number number: bool>` | Less than or equal |
| `length` | `<list\|string: integer>` | Returns the length of a list or string |
| `log` | `<any: any>` | Logs to console and returns the value |
| `lt` | `<number number: bool>` | Less than |
| `map` | `<function list: list>` | Applies function to each item |
| `max` | `<number number: number>` | Returns the larger of two numbers |
| `min` | `<number number: number>` | Returns the smaller of two numbers |
| `mod` | `<number number: number>` | Remainder of division |
| `mul` | `<number number: number>` | Multiplies numbers |
| `ne` | `<number number: bool>` | Not equal |
| `not` | `<bool: bool>` | Logical NOT |
| `nth` | `<number list: any>` | Nth element of list (0-based) |
| `or` | `<bool bool: bool>` | Logical OR |
| `pow` | `<number number: number>` | Raises first number to the power of second |
| `print` | `<any: record>` | Outputs a value to the form |
| `range` | `<number number number: list>` | Generates a range list (start, end, step) |
| `reduce` | `<function any list: any>` | Combines list using a reducer with initial value |
| `set` | `<string any record: record>` | Returns a new record with a key set to a value |
| `set-var` | `<string any: any>` | Sets a named variable to a value |
| `sub` | `<number number: number>` | Subtracts numbers |
| `take` | `<integer list: list>` | Returns the first n elements of a list |
| `tl` | `<list: list>` | All items except first |
| `use` | `<string: record>` | Inside `data`, declares the upstream language whose output is expected (e.g. `data use "0000"`). Evaluates to `{}` when no upstream is bound; see Pipeline Composition |

## Pipeline Composition

An L0000 program can consume the output of **another L0000 program** — its upstream. The only
upstream L0000 may bind is L0000 itself: `data use "0000"`. Never write `use` with any other
language id.

**When to bind.** Only when the request explicitly describes two programs: one that *produces*
data and one that *consumes* it — e.g. "an upstream program that builds X, and a program that
computes Y from it", "compute Y over the output of another L0000 program", "as a pipeline". A
request that supplies its data inline, or does not mention a separate producer, is a single
program: author the data as a literal and emit no binding.

**When you bind, the binding is REQUIRED.** Write `data use "0000"` in the program you return —
it is what causes the platform to generate the upstream program. Describing the upstream data
without the binding yields an empty input.

**Write only the consumer.** The upstream program is generated separately; do not author it
here. Assume it returns a **record** whose keys name its content (e.g. `{students: [...]}`), and
read those keys from the bound value.

**Guard for no upstream.** When nothing is chained, `data use "0000"` evaluates to `{}`, so a
bare `get "students"` returns nothing and `map` over it fails. Destructure with `case` and give
a fallback:

```
let roster = data use "0000"..
let scores = case roster of
  {students}: map (<s: get "score" s>) students
  _: []
end..
let total = reduce (<a b: add a b>) 0 scores..
let count = length scores..
{count total average: case count of 0: 0 _: div total count end}..
```

**Finish-time check.** If the request describes a separate producer program, confirm your
program contains `data use "0000"` exactly once and contains no other `use`. If it does not
describe one, confirm your program contains no `use` at all.

## Examples

### Arithmetic
```
add 1 mul 2 3..
```

### List operations
```
let nums = [1 2 3 4 5]..
let evens = filter (<x: eq 0 mod x 2>) nums..
reduce (<a b: add a b>) 0 evens..
```

### Record manipulation
```
let person = {name: "Alice", age: 30}..
set "age" 31 person..
```

### Pattern matching with tags
```
let red = tag red..
let blue = tag blue..
let color = red..
case color of
  red: "warm"
  blue: "cool"
  _: "unknown"
end..
```

### Higher-order functions
```
let double = <x: mul 2 x>..
let inc = <x: add x 1>..
map (double) map (inc) [1 2 3]..
```

### Processing lists of pairs
```
/* To apply a binary function to each pair, use `apply` to spread the list */
let pairs = [[1 2] [3 4] [5 6]]..
map (<pair: apply (mul) pair>) pairs..
```
