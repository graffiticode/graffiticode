<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# Graffiticode Examples with Explanations

Graffiticode is a functional language with minimal no infix syntax. Here are examples demonstrating core language features:

## Basic Declarations

```gc
let x = 42..
```
Binds the value `42` to the variable `x`.

## Data Structures

### Lists

```gc
let emptyList = []..
let numbers = [1 2 3 4 5]..
let nested = [1 [2 3] 4]..
```
Lists can contain any values including other lists. Comma separators are optional. Access elements using index notation: `nth 0 numbers` returns `1`.

### Records

```gc
let point = {x: 10, y: 20}
let person = {
  name: "Alice"
  age: 30
  address: {
    street: "123 Main St"
    city: "Anytown"
  }
}
```
Records are key-value structures. Comma separators are optional. Access using dot notation: `get person "name"` returns `"Alice"`.

## Functions

### Lambda Expressions

```gc
let identity = <x: x>..
let add2 = <a b: add a b>..
let double = <x: add x x>..
```
Functions are defined using the `<parameters: body>` syntax.

### Function Application

```gc
let sum = add2 3 4..   // Returns 7
let twice = double 5..   // Returns 10
```
Functions are applied by listing arguments after the function name.

## Higher-Order Functions

```gc
let map = <fn arr: <i: fn nth i arr>>..
let filter = <pred arr: <i: if pred arr[i] then arr[i] else []>>..
let reduce = <fn acc arr: if isEmpty arr then acc else reduce (fn) fn acc hd arr tl arr>..

let doubled = map (double) [1, 2, 3]   // Returns [2, 4, 6]
let evens = filter (<x: eq mod x 2 0>) [1, 2, 3, 4, 5]   // Returns [2, 4]
let sum = reduce (add2) 0 [1, 2, 3, 4]   // Returns 10
```
Functions that take other functions as arguments or return functions. Wrap function
arguments in parens to avoid eager evaluation.

## Conditional Logic

```gc
let max = <a b: if gt a b then a else b>
let abs = <x: if lt x 0 then -x else x>
```
The if-then-else expressions `if condition then trueValue else falseValue` is used for conditionals.

## Recursion

```gc
let factorial = <n: if le n 1 then 1 else mul n factorial sub n 1>
let fibonacci = <n: if le n 1 then n else add fibonacci sub n 1 fibonacci sub n 2>
```
Functions can call themselves to create recursive algorithms.

## Composition

```gc
let compose = <f g: f g>..
let addThenDouble = compose (double) (add)..
let result = addThenDouble 5 7..   // double(add(5, 7)) = double(12) = 24
```
Functions can be composed to create new functions.

## Real-World Example: Data Processing

```gc
let products = [
  {id: 1, name: "Laptop", price: 1200, stock: 5},
  {id: 2, name: "Phone", price: 800, stock: 10},
  {id: 3, name: "Tablet", price: 500, stock: 7},
  {id: 4, name: "Headphones", price: 100, stock: 15}
]..

let inStock = <item: get item "stock" > 0>..
let applyDiscount = <item discount: {
  id: item.id
  name: item.name
  price: mul get item "price" sub 1 discount
  stock: get item "stock"
}>..

let calculateTotal = <items:
  reduce (<item total: add total get item "price">) 0 items
>..

// Filter in-stock items, apply 10% discount, calculate total
let availableItems = filter (inStock) products..
let discountedItems = map (<item: applyDiscount item 0.1>) availableItems..
let total = calculateTotal discountedItems..
```
A more complex example showing how to process a collection of products.
