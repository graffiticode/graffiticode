<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0003 RAG Training Examples

130 example prompts for training a RAG model on the L0003 core language.

## Category 1: Basic Expressions and Literals (1–20)

1. Adds 7 and 5.
2. Multiplies 6 by 4.
3. Subtracts 3 from 10.
4. Returns the number 42.
5. Returns the string "hello".
6. Adds 3, 4, and 5 together.
7. Multiplies 2 by the sum of 3 and 4.
8. Computes the remainder when 17 is divided by 5.
9. Computes 10 minus the product of 2 and 3.
10. Computes the sum of 8 and the product of 2 and 5.
11. Doubles the number 9.
12. Triples the number 7.
13. Squares the number 6.
14. Adds 100 and -5.
15. Multiplies -3 by 8.
16. Subtracts 4 from -10.
17. Adds three numbers: 1, 2, and 3.
18. Multiplies three numbers: 2, 3, and 4.
19. Adds the result of 4x5 to 6.
20. Multiplies the result of 2+3 by 4.

## Category 2: Lists (21–35)

21. Returns the list `[1 2 3]`.
22. Returns the list `[10 20 30 40]`.
23. Returns the first element of `[5 6 7]`.
24. Returns the tail of `[5 6 7 8]`.
25. Checks if the list `[1 2 3]` is empty.
26. Returns the last element of `[2 4 6 8]`.
27. Takes the first three elements of `[1 2 3 4 5]`.
28. Drops the first two elements of `[1 2 3 4 5]`.
29. Returns the third element of `[10 20 30 40]`.
30. Concatenates `[1 2 3]` and `[4 5]` into a single list.
31. Adds the number 1 to the front of `[2 3 4]`.
32. Creates the list of numbers from 1 to 5 using `range`.
33. Creates the list of numbers from 0 to 10 with step 2.
34. Creates the list from 5 to 20 with step 5.
35. Returns the length of `[1 2 3 4]`.

## Category 3: Map / Filter / Reduce (36–50)

36. Doubles every number in `[1 2 3 4]`.
37. Triples every number in `[2 4 6]`.
38. Adds 1 to every element of `[5 6 7]`.
39. Squares every number in `[1 2 3 4]`.
40. Keeps only the even numbers in `[1 2 3 4 5 6]`.
41. Keeps only numbers greater than 5 in `[3 5 7 9]`.
42. Filters out negative numbers from `[3 -1 4 -2 5]`.
43. Sums all numbers in `[1 2 3 4]`.
44. Multiplies all numbers in `[2 3 4]`.
45. Counts the number of elements in `[5 6 7 8]`.
46. Adds all numbers in the range from 1 to 10.
47. Doubles numbers from 1 to 10.
48. Squares numbers from 1 to 5.
49. Filters even numbers from the range 1 to 10.
50. Sums the squares of `[1 2 3 4]`.

## Category 4: Lambdas and Higher-Order Functions (51–65)

51. Defines a function `double` that multiplies a number by 2.
52. Defines a function `square`.
53. Defines a function `addOne`.
54. Defines a function `increment` and uses it on 5.
55. Defines a function `triple` and maps it over `[1 2 3]`.
56. Defines a function `double` and uses it with `map`.
57. Defines a function that adds two numbers.
58. Defines a function that multiplies two numbers.
59. Defines a function that subtracts two numbers.
60. Defines a function `sum3` that adds three numbers.
61. Maps a lambda that doubles numbers over `[3 6 9]`.
62. Maps a lambda that squares numbers over `[2 3 4]`.
63. Filters numbers greater than 3 from `[1 2 3 4 5]`.
64. Reduces `[1 2 3 4]` using addition.
65. Reduces `[2 3 4]` using multiplication.

## Category 5: Pattern Matching (66–80)

66. Matches the number 1 and returns "one".
67. Matches numbers 1, 2, or anything else and returns a string.
68. Matches a list and returns the head.
69. Matches a pair `(x, y)` and returns their sum.
70. Matches a pair `(x, y)` and returns their product.
71. Matches a record `{name, age}` and formats a string.
72. Matches `{x, y}` and returns `x + y`.
73. Matches `{width, height}` and returns the area.
74. Matches a list and returns 0 if it is empty.
75. Matches a list and returns the first element if present.
76. Matches `(x, y)` and returns the larger value.
77. Matches `(x, y)` and returns the smaller value.
78. Matches a number and returns "positive", "negative", or "zero".
79. Matches a record `{first, last}` and returns the full name.
80. Matches `{x, y, z}` and returns their sum.

## Category 6: Mixed Programs (81–100)

81. Doubles numbers in `[1 2 3 4]` and then sums them.
82. Squares numbers from 1 to 10 and filters even results.
83. Adds the elements of a pair `(3, 7)`.
84. Sums numbers in `[1 2 3 4 5]` using reduce.
85. Filters numbers greater than 10 from `[5 12 7 20]`.
86. Creates numbers 1 to 10 and doubles them.
87. Creates numbers 1 to 10 and sums them.
88. Counts how many numbers in `[1 2 3 4 5]` are even.
89. Finds the largest number in `[3 9 2 7]`.
90. Finds the smallest number in `[3 9 2 7]`.
91. Doubles numbers in `[1 2 3 4]` and keeps only those greater than 5.
92. Sums the even numbers in `[1 2 3 4 5 6]`.
93. Squares numbers and then sums them.
94. Takes the first three numbers from `range 1 10 1`.
95. Drops the first three numbers from `range 1 10 1`.
96. Returns the third number from `range 1 10 1`.
97. Adds the first and last numbers of `[2 4 6 8]`.
98. Multiplies the first two numbers of `[3 5 7]`.
99. Sums numbers in a list using reduce and a lambda.
100. Defines a function `double`, maps it over `[1 2 3 4]`, and sums the result.

## Category 7: Tags and Tag Pattern Matching (101–110)

101. Defines a tag value `red` using the `tag` keyword.
102. Defines two tags `red` and `blue` and binds `red` to a variable `color`.
103. Defines tags `red` and `blue`, then uses `case` to return "warm" for `red` and "cool" for `blue`.
104. Defines tags `on` and `off`, binds one to a variable, and matches it with a wildcard fallback returning "unknown".
105. Defines two tags and uses `equiv` to check if they are the same.
106. Defines a tag `red` and uses `equiv` to compare it to itself.
107. Defines three tags `small`, `medium`, and `large`, binds one to a variable, and uses `case` to return a number for each.
108. Defines two tags and puts them in a list.
109. Defines tags `cat` and `dog`, creates a list of them, and maps a lambda that uses `case` to convert each to a string.
110. Defines tags `yes` and `no` and uses `case` to return `true` for `yes` and `false` for `no`.

## Category 8: Comparison Operators (111–118)

111. Checks if 5 equals 5 using `eq`.
112. Checks if 3 is not equal to 7 using `ne`.
113. Checks if 10 is greater than 4 using `gt`.
114. Checks if 2 is less than 9 using `lt`.
115. Checks if 5 is greater than or equal to 5 using `ge`.
116. Checks if 3 is less than or equal to 8 using `le`.
117. Filters numbers greater than 5 from `[2 4 6 8 10]` using `gt`.
118. Filters numbers equal to 3 from `[1 2 3 3 4]` using `eq`.

## Category 9: New Built-in Functions (119–130)

119. Computes 2 raised to the power of 10 using `pow`.
120. Squares a number using `pow`.
121. Concatenates the strings "hello " and "world" using `concat`.
122. Concatenates two lists `[1 2]` and `[3 4]` using `concat`.
123. Prepends the number 0 to the list `[1 2 3]` using `cons`.
124. Appends the number 4 to the list `[1 2 3]` using `append`.
125. Returns the last element of `[10 20 30]` using `last`.
126. Returns the length of `[5 6 7 8 9]` using `length`.
127. Returns the length of the string "hello" using `length`.
128. Takes the first three elements of `[1 2 3 4 5]` using `take`.
129. Drops the first two elements of `[1 2 3 4 5]` using `drop`.
130. Parses the string `"{\"x\": 1}"` using `json`.