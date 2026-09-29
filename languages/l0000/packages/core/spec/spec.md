# Graffiticode Core Language Specification

```
Version: 0.1.5
Date: 2026-03-26
```

# Introduction

This document defines the **Graffiticode Core Language Specification**, covering syntax, semantics, and the base library. It excludes dialect-specific constructs, runtime behavior, and extended libraries.

# Lexical Structure

## Tokens

- **Identifiers**: Alphanumeric symbols beginning with a letter.
- **Numbers**: Integers and floats. Negative numbers start with `-`.
- **Strings**: Double-quoted UTF-8 strings.
- **Keywords**: `let`, `case`, `of`, `end`, `tag`, `true`, `false`
- **Symbols**: `(`, `)`, `[`, `]`, `{`, `}`, `:`, `..`, `<`, `>`, `,`

## Comments

- **Block Comments**: Enclosed in `/* ... */`, C-style. Can span multiple lines.

# Syntax

## Programs

A **Graffiticode program** is zero or more `let` declarations followed by an
**expression block** — one or more top-level expressions — and terminated with
`..`. The block's expressions are evaluated in order and the value of the last
one is the program's result.

```
let double = <x: mul 2 x>..
map (double) [1 2 3]..
```

Internally this is a `PROG` node wrapping a single `EXPRS` node whose elements
are the block's expressions; the compiler evaluates each in turn and returns the
last. A program with several expressions is the normal case, not a special one:

```
set-var "greeting" "hello"
print get-var "greeting"..
```

parses to `PROG → EXPRS(2): [SET_VAR, PRINT]`.

Expressions within a block carry **no separator**. An expression ends when its
arity is satisfied, and the next begins immediately; `add 1 2 add 3 4` is two
expressions, not one.

`..` terminates the program, and additionally each `let` binding. It is not an
expression terminator, and it does not appear between the expressions of a
block. Parsing stops at the program's `..`: any text after it is discarded
without raising an error, so a stray `..` after the first expression silently
truncates the program to that expression.

## Expressions

### Function Application

Function application is written in prefix style:
```
add 1 2
```

Functions have fixed arity, so applications can be parsed unambiguously without grouping syntax. For example, `add 1 mul 2 3` parses as `add(1, mul(2, 3))` because the parser knows `add` takes 2 arguments and `mul` takes 2 arguments.

Parentheses are used to defer application:
```
map (double) [1 2 3]
```

Parentheses only group; they build no value of their own. `(1 2)` means the same as `1 2`: two expressions, whose value is the last. Commas are not allowed inside parentheses.

### Lists
```
[1 2 3]
```

### Records

Records may use **shorthand syntax** for fields where the value is a reference to a variable of the same name.

```gc
let foo = 10..
{foo}         | equivalent to {foo: 10}
```

This provides a concise way to construct records using in-scope variable names as field keys and values.

You can also mix shorthand and explicit fields:

```gc
let x = 1..
let y = 2..
{x y z: 3}    | equivalent to {x: 1, y: 2, z: 3}
```

```gc
{ name: "Alice", age: 30 }
```

### Tags

A **tag value** is a symbolic value used to represent constants for pattern matching or other symbolic forms. Tags are identified by their name. Any two tags with the same name are equivalent.

The `tag` keyword followed by an identifier constructs a tag value:

```gc
let red = tag red..
```

Tag values:

- Have value semantics — same name means same tag
- Can be used anywhere a value is expected

```gc
let red = tag red..
let blue = tag blue..
let color = red..
case color of
  red: "warm"
  blue: "cool"
  _: "other"
end..
```

### Strings and templates

A string is written in double or single quotes. A template, written in backticks, interpolates
expressions: `` `${name} is ${age}` ``. Each `${…}` is converted to text with `str`, so any value
can be interpolated; a function application inside `${…}` works as anywhere else.

`concat` stays strict: `concat "age: " 30` is an error. Write `concat "age: " (str 30)` or use a
template.

### Lambdas
```
<x: add x 1>
```
Multiple parameters:
```
<x y: add x y>
```

### Let Bindings
```
let double = <x: mul 2 x>..
```

## Pattern Matching

Pattern matching is done using `case`:

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
variables are bound in the body:

```
<[x y] z: add add x y z> [10 20] 30..        | 60
map (<{name age: years}: years>) people..
```

A `let` or parameter pattern may only bind variables (and use `_`), and never fails to match:
a missing element or field is undefined. Use `case` when a value's shape varies. Parameters of
a named function (`let f [a b] = ...`) cannot be patterns.

# Type System

Graffiticode includes a implicit structural type system. Every expression has
a statically inferred type, and type errors are detected at compile time.
Explicit type annotations are not included in the grammar.

## Primitive Types

- `number` – Represents integers or floating-point numbers.
- `string` – Represents UTF-8 strings.
- `bool` – Represents Boolean values: `true` and `false`.
- `json` – Represents any JSON-compatible value (opaque, untyped).
- `any` – Used internally to denote an unconstrained type (e.g., during inference).

## Composite Types

- **Lists** – Written as `[T]` where `T` is any type.
  ```
  [string]       | list of strings
  [number]       | list of numbers
  [[bool]]       | list of lists of booleans
  ```

- **Records** – Key-value maps with known keys and types.
  ```
  { name: string, age: number }
  ```

There is no separate tuple type. Values are immutable and a list may hold elements of different types, so a fixed-length list such as `[1 "a" true]` serves as a tuple.

## Function Types

Functions are written using Graffiticode lambda signature syntax:
```
<number number: number>   | function taking two numbers and returning a number
<string: [string]>        | function taking a string and returning a list of strings
<list record: record>     | common signature for structural transformation
```

Function types are curried by default. That means:
```
<number number: number>
```
is equivalent to a function that returns another function:
```
<number: <number: number>>
```

## Tag Type

Tag values are symbolic constants identified solely by their name. The same tag name refers to the same value regardless of where it appears. Tag values have the type `tag`.

```gc
let red = tag red..
let blue = tag blue..
let c = red..
case c of
  red: "warm"
  blue: "cool"
  _: "other"
end..
```

In this case, `red` and `blue` are tag patterns, and `case` matches by identity.

# Semantics

## Evaluation Model

- **Purely functional**: no side effects
- **Strict evaluation**: arguments evaluated before function application
- **Immutable data**: all values are immutable

Many built-in functions in Graffiticode follow a model-threading pattern. In this pattern, functions are defined to take one or more arguments followed by a model, which represents the current state of the program or view. The function uses the earlier arguments to compute an update to the model and returns a new model as its result.

This style enables a declarative and order-independent composition of functions. Since each function call returns a new model, multiple calls can be reordered without changing the final result, provided the functional dependencies are preserved.

This approach draws inspiration from **Model-View-Update** (MVU) architectures, in which the model represents the application state and functions describe pure, deterministic transformations of that state.



## Functions

- **Fixed arity**: every function has a known number of parameters
- **Curried by default**: partial application supported

## Scoping

- **Lexical scoping**
- **Shadowing** allowed within nested scopes

## Errors

- **Syntax errors**: raised during parsing
- **Undefined reference errors**: raised during parsing when an identifier is not a known keyword, builtin, bound variable, or tag
- **Type errors**: raised during compilation
- **Runtime errors**: e.g., out-of-bounds access

# Base Library

## Types

- `number`
- `string`
- `bool`
- `list`
- `record`
- `json`

## Built-in Functions

| Function | Signature | Description |
| :------- | :-------- | :---------- |
| `add` | `<number number: number>` | Adds two numbers |
| `and` | `<bool bool: bool>` | Logical AND operation |
| `append` | `<any list: list>` | Appends an element to the end of a list |
| `apply` | `<function list: any>` | Applies a function to a list of arguments |
| `concat` | `<string|list string|list: string|list>` | Concatenates two strings or two lists |
| `cons` | `<any list: list>` | Prepends an element to the front of a list |
| `data` | `<record: record>` | Returns upstream task data, or the argument if no input exists. Argument may be a record literal (e.g. `data {x: 1}`) or `use "<lang>"` to declare the upstream language |
| `div` | `<number number: number>` | Divides numbers |
| `drop` | `<integer list: list>` | Returns a list with the first n elements removed |
| `eq` | `<number number: bool>` | Numeric equality |
| `equiv` | `<any any: bool>` | Semantic equivalence for any type, including tags |
| `filter` | `<function list: list>` | Keeps items matching predicate |
| `ge` | `<number number: bool>` | Returns true if first value is greater than or equal to second |
| `get` | `<string record: any>` | Retrieves a value from a record by key |
| `get-var` | `<string: any>` | Gets the value of a named variable |
| `get-val-private` | `<string: string>` | Resolves a named variable, encrypted at parse time and decrypted at compile time |
| `get-val-public` | `<string: string>` | Resolves a named variable as plain text |
| `gt` | `<number number: bool>` | Returns true if first value is greater than second |
| `hd` | `<list: any>` | First item of list |
| `isempty` | `<list: bool>` | Returns true if the list is empty |
| `json` | `<string: any>` | Parses a string as JSON |
| `str` | `<any: string>` | Converts any value to display text |
| `last` | `<list: any>` | Returns the last element of a list |
| `le` | `<number number: bool>` | Returns true if first value is less than or equal to second |
| `length` | `<list|string: integer>` | Returns the length of a list or string |
| `log` | `<any: any>` | Logs the value to console and returns it (identity function) |
| `lt` | `<number number: bool>` | Returns true if first value is less than second |
| `map` | `<function list: list>` | Applies function to each item |
| `max` | `<number number: number>` | Returns the larger of two numbers |
| `min` | `<number number: number>` | Returns the smaller of two numbers |
| `mod` | `<number number: number>` | Remainder of division |
| `mul` | `<number number: number>` | Multiplies numbers |
| `ne` | `<number number: bool>` | Returns true if the two values are not equal |
| `not` | `<bool: bool>` | Logical NOT operation, inverts a boolean value |
| `nth` | `<number list: any>` | Nth element of list |
| `or` | `<bool bool: bool>` | Logical OR operation |
| `pow` | `<number number: number>` | Raises first number to the power of second |
| `print` | `<any: record>` | Outputs a value to the form |
| `range` | `<number number number: list>` | Generates a range list |
| `reduce` | `<function any list: any>` | Combines list using a reducer with initial value |
| `set` | `<string any record: record>` | Returns a new record with a key set to a value |
| `set-var` | `<string any: any>` | Sets a named variable to a value |
| `sub` | `<number number: number>` | Subtracts numbers |
| `take` | `<integer list: list>` | Returns the first n elements of a list |
| `tl` | `<list: list>` | All items except first |
| `use` | `<string: record>` | Inside `data`, declares the upstream language whose output is expected (e.g. `data use "0166"`). Evaluates to `{}` when no upstream is bound |

### add

Add two numbers.

```
add 2 3  | returns 5
```

### append

Append an element to the end of a list

```
append 4 [1 2 3]  | returns [1 2 3 4]
append 1 []       | returns [1]
```

### and

Logical AND operation

```
and false false  | returns false
and false true   | returns false
and true false   | returns false
and true true    | returns true
```

### apply

Apply a function to an argument list. Parenthesize a built-in to pass it as a value: `(add)`, not `add`.

```
apply (add) [1 2]  | returns 3
```

### concat

Concatenate two strings or two lists

```
concat "hello " "world"  | returns "hello world"
concat [1 2] [3 4]       | returns [1 2 3 4]
```

### cons

Prepend an element to the front of a list

```
cons 1 [2 3]  | returns [1 2 3]
cons 0 []     | returns [0]
```

### data

Returns the data from the upstream task, or the argument value if no input exists. `data` is arity-1; its argument is either a record literal supplying defaults, or `use "<lang>"` declaring the language of the expected upstream. The two forms are alternatives — `data` takes exactly one argument.

```
data {x: 1, y: 2}    | returns {x: 1, y: 2} when no upstream is bound; otherwise returns the upstream merged onto the defaults
data use "0166"      | declares L0166 as the upstream language; returns {} when no upstream is bound
```

### div

Divide the first number by the second

```
div 10 2  | returns 5
```

### drop

Returns a list with the first n elements removed

```
drop 2 [1 2 3 4 5]  | returns [3 4 5]
drop 0 [1 2 3]       | returns [1 2 3]
```

### eq

Numeric equality

```
eq 1 1  | returns true
eq 1 2  | returns false
```

### equiv

Semantic equivalence for any type, including tags

```
equiv 1 1        | returns true
equiv "a" "a"    | returns true
equiv true true  | returns true
equiv 1 2        | returns false
equiv "a" "b"    | returns false
```

Tags can be compared with `equiv`:

```gc
let red = tag red..
let blue = tag blue..
equiv red red    | returns true
equiv red blue   | returns false
```

### filter

Filter elements matching predicate

### ge

Returns true if the first value is greater than or equal to the second

```
ge 5 3  | returns true
ge 3 3  | returns true
ge 2 3  | returns false
```

```
filter (<x: mod x 2>) [1 2 3 4]  | returns [1 3]
```

### get

Retrieve a record field

### get-var

Gets the value of a named variable.

```
get-var "count"..
```

### get-val-private

Resolves a named variable, encrypted at parse time and decrypted at compile time. Used for secrets that should not appear as plain text in the stored AST.

```
{secret: get-val-private "learnosity:secret"}  | encrypted in AST, decrypted at compile time
```

The parser calls back to the invoker to resolve the variable name and encrypt the value. The compiler decrypts it at runtime. Requires `GRAFFITICODE_SECRET_KEY` environment variable on both parser and compiler sides. Without the key, the value passes through unchanged.

### get-val-public

Resolves a named variable as plain text. Used for non-sensitive values like item IDs that the compiler needs at runtime.

```
{itemId: get-val-public "itemid"}  | resolved at parse time, plain text in AST
```

The parser calls back to the invoker to resolve the variable name. The value is stored as-is in the AST.

### set-var

Sets a named variable to a value.

```
set-var "count" 42..
```

### gt

Returns true if the first value is greater than the second

```
gt 5 3  | returns true
gt 3 3  | returns false
```

```
get "b" {a: 1, b: 2}  | returns 2
```

### hd

Return the first item

```
hd [10 20 30]  | returns 10
```

### json

Parses a string as JSON

```
json "{\"a\": 1}"  | returns {a: 1}
```

### last

Returns the last element of a list

```
last [1 2 3]  | returns 3
```

### le

Returns true if the first value is less than or equal to the second

```
le 3 5  | returns true
le 3 3  | returns true
le 5 3  | returns false
```

### isempty

Return true if list is empty, otherwise return false

```
isempty []  | returns true
```

### length

Return the length of a list or string

```
length [1 2 3]    | returns 3
length "hello"    | returns 5
length []         | returns 0
```

### lt

Returns true if the first value is less than the second

```
lt 3 5  | returns true
lt 3 3  | returns false
```

### log

Log a value to the console and return the value unchanged

```
log "Hello"  | prints "Hello" to console and returns "Hello"
log (add 1 2)  | prints 3 to console and returns 3
```

### map

Apply a function to each element

```
map (<x: add x 1>) [1 2 3]  | returns [2 3 4]
```

### max

Return the larger of two numbers

```
max 5 10  | returns 10
```

### min

Return the smaller of two numbers

```
min 5 10  | returns 5
```

### mod

Compute the remainder

```
mod 10 3  | returns 1
```

### mul

Multiply two numbers

```
mul 4 3  | returns 12
```

### ne

Returns true if the two values are not equal

```
ne 1 2  | returns true
ne 1 1  | returns false
```

### not

Logical NOT that inverts a boolean value

```
not true   | returns false
not false  | returns true
```

### nth

Get the nth item (0-based)

```
nth 1 [10 20 30]  | returns 20
```

### or

Logical OR operation

```
or false false  | returns false
or false true   | returns true
or true false   | returns true
or true true    | returns true
```

### print

Outputs a value to the form

```
print {x: 1, y: 2}  | outputs the record to the form
```

### pow

Raise the first number to the power of the second

```
pow 2 3  | returns 8
pow 5 2  | returns 25
```

### range

Produce a range list from start to end (exclusive) with step

```
range 1 10 2  | returns [1 3 5 7 9]
```

### reduce

Reduce a list to a single value, starting with an initial value

```
reduce (<a b: add a b>) 0 [1 2 3 4]  | returns 10
```

### set

Return a new record with an updated field

```
set "a" 2 {a: 1}  | returns {a: 2}
```

### str

Converts any value to display text. A string is itself; a number, boolean, null or tag is written
as is (`red` for a tag); a list or record is written in Graffiticode syntax, with strings inside it
quoted and tags written `tag red`. Never fails. Number formatting (fixed decimals) is not
provided by `str`.

```
str 30                     | returns "30"
str tag red                | returns "red"
str [1 "a" tag red]        | returns "[1 \"a\" tag red]"
str {name: "Ann" age: 30}  | returns "{name: \"Ann\" age: 30}"
```

### sub

Subtract the second number from the first

```
sub 5 2  | returns 3
```

### take

Returns the first n elements of a list

```
take 2 [1 2 3 4 5]  | returns [1 2]
take 0 [1 2 3]       | returns []
```

### tl

Return all but the first item

```
tl [10 20 30]  | returns [20 30]
```

### use

Declares the language of the upstream task expected by `data`. Used only inside `data` (e.g. `data use "0166"`); the argument is a language id string. Evaluates to `{}` when no upstream is bound, so `data use "<lang>"` falls back to the empty record. Consumers (e.g. the console) read this annotation at write time to drive composition, fetching `L<lang>/schema.json` and inlining the schema on the `use` node.

```
data use "0166"  | declares L0166 upstream; returns the upstream record at runtime, or {} if none
```

# Program Examples

```
let double = <x: mul 2 x>..
map (double) [1 2 3]..
```

```
case age of
  18: "adult"
  _: "other"
end..
```

---

