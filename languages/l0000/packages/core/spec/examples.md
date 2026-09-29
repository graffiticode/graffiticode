<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0000 RAG Training Examples

Natural-language prompts for training a RAG model on the L0000 root Graffiticode language. Organized progressively from atomic operations to idiomatic compositions, then to upstream data (`data` / `use`) and ancillary features. Every base-library builtin and every syntactic feature called out in the spec is exercised at least once directly, with additional prompts for common compositions.

## 1. Arithmetic

1. Adds 7 and 5.
2. Subtracts 3 from 10.
3. Multiplies 6 by 4.
4. Divides 20 by 4 using `div`.
5. Computes the remainder when 17 is divided by 5 using `mod`.
6. Raises 2 to the power of 10 using `pow`.
7. Squares the number 6 using `pow`.
8. Returns the larger of 5 and 10 using `max`.
9. Returns the smaller of 5 and 10 using `min`.
10. Adds 100 and -5.
11. Multiplies -3 by 8.
12. Adds three numbers: 1, 2, and 3.
13. Multiplies 2 by the sum of 3 and 4.
14. Computes 10 minus the product of 2 and 3.
15. Adds 6 to the product of 4 and 5.

## 2. Comparisons and Boolean Logic

16. Checks whether 5 equals 5 using `eq`.
17. Checks whether 3 is not equal to 7 using `ne`.
18. Checks whether 10 is greater than 4 using `gt`.
19. Checks whether 2 is less than 9 using `lt`.
20. Checks whether 5 is greater than or equal to 5 using `ge`.
21. Checks whether 3 is less than or equal to 8 using `le`.
22. Returns the logical AND of `true` and `false` using `and`.
23. Returns the logical OR of `true` and `false` using `or`.
24. Negates `true` using `not`.
25. Returns the logical AND of `gt 5 3` and `lt 2 10`.
26. Returns the logical OR of `eq 1 2` and `lt 1 2`.
27. Checks structural equivalence of `"abc"` and `"abc"` using `equiv`.

## 3. Lists — Access and Inspection

28. Returns the literal list `[1 2 3]`.
29. Returns the first element of `[5 6 7]` using `hd`.
30. Returns the tail of `[5 6 7 8]` using `tl`.
31. Returns the last element of `[2 4 6 8]` using `last`.
32. Returns the element at index 1 of `[10 20 30]` using `nth`.
33. Returns the length of `[1 2 3 4]`.
34. Checks whether `[]` is empty using `isempty`.
35. Checks whether `[1 2 3]` is empty using `isempty`.

## 4. Lists — Construction and Transformation

36. Generates the list `[1 3 5 7 9]` using `range`.
37. Generates the integers from 0 to 10 with step 2 using `range`.
38. Generates the integers from 5 to 20 with step 5 using `range`.
39. Prepends 1 to `[2 3 4]` using `cons`.
40. Appends 4 to `[1 2 3]` using `append`.
41. Concatenates `[1 2 3]` and `[4 5]` using `concat`.
42. Takes the first three elements of `[1 2 3 4 5]` using `take`.
43. Drops the first two elements of `[1 2 3 4 5]` using `drop`.

## 5. Records

44. Builds the record `{name: "Alice", age: 30}`.
45. Builds a record using shorthand: given `let foo = 10..`, returns `{foo}`.
46. Mixes shorthand and explicit fields: given `let x = 1..` and `let y = 2..`, returns `{x y z: 3}`.
47. Retrieves the value of field `name` from `{name: "Alice", age: 30}` using `get`.
48. Retrieves the value of field `b` from `{a: 1, b: 2}` using `get`.
49. Returns a new record with field `a` set to 2 in `{a: 1}` using `set`.
50. Updates the `count` field of `{count: 1, name: "a"}` to 5 using `set`.

## 6. Strings

51. Returns the string `"hello"`.
52. Concatenates `"hello "` and `"world"` using `concat`.
53. Returns the length of `"hello"` using `length`.
54. Parses the JSON string `"{\"x\": 1}"` using `json`.
55. Parses the JSON string `"[1, 2, 3]"` using `json`.

## 7. Tags

56. Defines a tag value `red` using the `tag` keyword.
57. Defines two tags `red` and `blue` and binds `red` to a variable `color`.
58. Compares `tag red` to itself using `equiv`.
59. Compares `tag red` to `tag blue` using `equiv`.
60. Puts the tags `cat` and `dog` into a list.
61. Defines tags `on` and `off`, binds `on` to `state`, and matches it with `case` to return `"active"` or `"inactive"`.

## 8. Lambdas and `let`

62. Defines the lambda `<x: mul 2 x>`.
63. Defines the two-argument lambda `<x y: add x y>`.
64. Defines the three-argument lambda `<x y z: add x add y z>`.
65. Defines `let double = <x: mul 2 x>..` and applies it to 9.
66. Defines `let square = <x: mul x x>..` and applies it to 6.
67. Defines `let inc = <x: add x 1>..` and applies it to 5.
68. Defines `let add3 = <a b c: add a add b c>..` and applies it to 1, 2, and 3.
69. Defines `let addOne = <x: add 1 x>..` by partially applying `add` to 1, and applies `addOne` to 4.
70. Defines `let compose = <f g x: f (g x)>..` and uses it to compose `inc` with `double` over the value 3.

## 9. Higher-Order Functions

71. Doubles every number in `[1 2 3 4]` using `map`.
72. Adds 1 to every element of `[5 6 7]` using `map`.
73. Squares every number in `[1 2 3 4]` using `map`.
74. Maps a named lambda `double` over `[1 2 3]`.
75. Keeps only the even numbers in `[1 2 3 4 5 6]` using `filter` with `eq (mod x 2) 0`.
76. Keeps only numbers greater than 5 in `[3 5 7 9]` using `filter` and `gt`.
77. Removes negative numbers from `[3 -1 4 -2 5]` using `filter` and `ge`.
78. Sums all numbers in `[1 2 3 4]` using `reduce` with addition.
79. Multiplies all numbers in `[2 3 4]` using `reduce` with multiplication.
80. Finds the maximum of `[3 9 2 7]` using `reduce` with `max`.
81. Finds the minimum of `[3 9 2 7]` using `reduce` with `min`.
82. Counts how many numbers in `[1 2 3 4 5]` are even using `filter` and `length`.
83. Applies the function `add` to the argument list `[1 2]` using `apply`.
84. Applies the function `mul` to the argument list `[3 4]` using `apply`.

## 10. Pattern Matching

85. Matches the number 1 and returns `"one"`, otherwise returns `"other"`.
86. Matches a number against 0, 1, and a wildcard returning `"many"`.
87. Matches a number and returns `"positive"`, `"negative"`, or `"zero"`.
88. Matches the list `[x y]` and returns their sum.
89. Matches the list `[x y]` and returns the larger value.
90. Matches the record `{name, age}` and formats `"<name> is <age>"`.
91. Matches the record `{width, height}` and returns the area.
92. Matches the record `{first, last}` and returns `"<first> <last>"`.
93. Matches a list and returns 0 if empty, otherwise returns its head.
94. Matches a list with cases `[]`, `[x]`, and `_` (wildcard).
95. Matches tags `yes` and `no` and returns `true` or `false`.
96. Matches tags `small`, `medium`, `large` and returns 1, 2, or 3.

## 11. Mixed Compositions

97. Doubles every number in `[1 2 3 4]` and sums the result.
98. Squares each number in `range 1 6 1` and keeps those greater than 10.
99. Generates `range 1 11 1` and sums the elements.
100. Generates `range 1 11 1` and doubles every element.
101. Sums the squares of `[1 2 3 4]`.
102. Doubles every number in `[1 2 3 4]` and keeps only results greater than 5.
103. Sums the even numbers in `[1 2 3 4 5 6]` using `filter` then `reduce`.
104. Adds the first and last elements of `[2 4 6 8]`.
105. Returns the third element of `range 1 11 1` using `nth`.
106. Defines `double`, maps it over `[1 2 3 4]`, and sums the result.
107. Builds the record `{nums: [1 2 3], total: 6}` from the literal list and its sum.
108. Partitions `[1 2 3 4 5 6]` into a record `{evens, odds}` using two `filter` calls.
109. Computes the average of `[2 4 6 8]` by dividing the sum by the length.

## 12. Upstream Data and Self-Composition

110. Returns the upstream task data, falling back to `{}` when no upstream is bound, using `data {}`.
111. Returns the upstream task data, falling back to `{x: 0, y: 0}` when none is bound, using `data {x: 0, y: 0}`.
112. Two L0000 programs. This program binds `data use "0000"` and returns the bound record unchanged. The data program it binds returns `{x: 1, y: 2}`; it computes nothing.
113. Two L0000 programs. This program binds `data use "0000"` and returns the `title` field, or `"untitled"` when nothing is bound. The data program it binds returns `{title: "Report"}`; it computes nothing.
114. Retrieves the `title` field of the upstream task data by calling `get "title"` on `data {title: "Quarterly Report"}`, so an unbound compile returns `"Quarterly Report"`.
115. Doubles every element of the upstream `items` list by mapping a lambda over `get "items" (data {items: [1 2 3]})`, so an unbound compile returns `[2 4 6]`.
116. Uses `data use "0000"` once to bind upstream data, then sums the `score` fields from the `students` list.
117. Two L0000 programs. This program binds `data use "0000"` and returns the highest `score` in the `students` list. The data program it binds returns `{students: [...]}`, a record whose `students` value is a list of records each having a `score` field, with the scores 85, 92, 78, 95 and 88; it computes nothing.
118. Two L0000 programs. This program binds `data use "0000"`, keeps the items in the `items` list whose `price` is over 10, and returns them in a record under `expensive`. The data program it binds returns `{items: [...]}`, a record whose `items` value is a list of records each having a `name` and a `price`, with the prices 5, 12, 8, 20 and 15; it computes nothing.

## 13. Output and Logging

119. Prints the record `{x: 1, y: 2}` to the form using `print`.
120. Sets a variable `"x"` to 10, then reads it back with `get-var`.
121. Sets `"a"` to 5 and `"b"` to 7, then returns their sum via `get-var`.
122. Logs the result of `mul 3 4` and uses the logged value as the program's result.

## 14. Variable Resolution

123. Reads the value of the variable named `"count"` using `get-var`.
124. Sets the variable `"count"` to 42 using `set-var`.
125. Resolves the public variable `"itemId"` using `get-val-public`.

## 15. Comments

126. Adds 1 and 2 with the block comment `/* sum two numbers */` placed before the expression.
127. Defines a `double` lambda preceded by a multi-line block comment that explains its purpose.
