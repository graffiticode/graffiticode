<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0179 RAG Training Examples

122 example prompts for training a RAG model on L0179, the interactive-spreadsheet language —
covering display spreadsheets, assessed spreadsheets, parameterized templates, and whether an
assessed sheet marks answers as the learner types or only when they check.

Each numbered line is a prompt in the author's own voice. Prompts describe WHAT to build, never
how to write it, so this list is inherited from L0166 unchanged: L0179 differs only in source
syntax and compiles to the same form, so every prompt here means the same thing in both
languages. Where the two diverge, this file diverges with them: Category 13 (when feedback
shows) is L0179's alone.
## Category 1: Minimal / Structural Basics (1–10)

1. Create a spreadsheet with a single empty cell.
2. Make a 2 by 2 empty grid.
3. Create a spreadsheet with cell A1 containing the text "Hello".
4. Make a single column spreadsheet with a bold header that says "Name".
5. Create a spreadsheet with two columns. Column A header is "Item" and column B header is "Price". Make both headers bold.
6. Create a vertical list in column A with three items: Apple, Banana, Cherry.
7. Put three values in a single row: Red, Green, Blue.
8. Create a spreadsheet with the title "Monthly Report" and an empty grid.
9. Create a spreadsheet titled "Quiz Instructions" with these instructions: "Read each question carefully. Enter your answer in the blank cell. Press submit when finished." Leave the grid empty.
10. Create a minimal empty spreadsheet template.

## Category 2: Column Configuration (11–20)

11. Make a spreadsheet with one column that is 200 pixels wide.
12. Create a two-column spreadsheet where column A is 150 wide and column B is 250 wide.
13. Make a spreadsheet with a single center-aligned column.
14. Create a spreadsheet with a column B that is right-aligned for displaying dollar amounts.
15. Create a three-column spreadsheet where column A is left-aligned, column B is center-aligned, and column C is right-aligned.
16. Make a two-column layout where the first column is narrow (80px) for labels and the second column is wide (300px) for content.
17. Create a four-column spreadsheet with columns A through D, all 100 pixels wide.
18. Make a spreadsheet with column A styled in italic.
19. Create a spreadsheet where column B has a light yellow background color.
20. Make a spreadsheet with column A having a 1px solid gray border.

## Category 3: Cell Text & Content (21–30)

21. Create a spreadsheet with three cells in column A containing the numbers 10, 20, and 30.
22. Make a two-column spreadsheet with labels in column A (Name, Age, City) and values in column B (Alice, 30, Denver).
23. Create a data table with 5 rows. Column A has names: Tom, Sara, Mike, Lily, Jake. Column B has ages: 25, 32, 28, 19, 41.
24. Make a spreadsheet with three empty input cells in column A for user entry.
25. Create a cell in A1 that contains the text "The quick brown fox jumps over the lazy dog".
26. Make a spreadsheet with three cells containing the decimal values 3.14, 2.718, and 1.618.
27. Create a spreadsheet with cells containing -50, -100, and -150.
28. Make a spreadsheet with cells showing $1,000 and $2,500 and $10,000.
29. Create a two-column spreadsheet where column A has category labels and column B has corresponding numeric values. Include 4 rows.
30. Make a spreadsheet with a header row and 3 data rows. Column A is "Product", column B is "Qty", column C is "Price".

## Category 4: Cell Formatting (31–45)

31. Create a spreadsheet where the entire first row is bold.
32. Make a cell with red text that says "Warning".
33. Create a cell with a light blue background color.
34. Make a cell with 16 pixel font size that says "Big Text".
35. Create a cell that displays text in a monospace font.
36. Make a cell with underlined text that says "Click Here".
37. Create a cell with a solid black border on all sides.
38. Make a cell that only has borders on the top and bottom.
39. Create a header cell that is bold, blue text, 18px font size, with a light gray background.
40. Make a 6-row spreadsheet where even rows (2, 4, 6) have a light gray background and odd rows are white.
41. Create a header row with bold white text on a dark navy background, with 14px font size.
42. Make a cell that has italic text with a strikethrough decoration.
43. Create a cell with vertically centered content.
44. Make a spreadsheet where cell A1 is protected from editing.
45. Create a cell formatted to display numbers with two decimal places and thousand separators.

## Category 5: Row Formatting (46–52)

46. Create a spreadsheet where row 1 is bold.
47. Make a spreadsheet where row 2 has a light gray background.
48. Create a spreadsheet where the first row has a larger 14px font.
49. Make a spreadsheet where row 3 text is colored red.
50. Create a spreadsheet where row 2 content is vertically aligned to the middle.
51. Make a spreadsheet where row 1 has bold blue text and row 3 has italic red text.
52. Create a spreadsheet with a dark bold header row and five plain data rows beneath it.

## Category 6: Simple Formulas (53–62)

53. Create a spreadsheet with values 10, 20, 30, 40, 50 in cells A1 through A5, and put a SUM formula in A6 that totals them.
54. Put values 5, 10, and 15 in cells A1, B1, and C1. Add a SUM formula in D1 that adds the three values.
55. Create a spreadsheet with test scores 85, 92, 78, 95, 88 in cells B2 through B6, and put an AVERAGE formula in B7.
56. Put the value 3.14159 in cell A1 and add a ROUND formula in A2 that rounds it to 2 decimal places.
57. Put "Pass" in B1 and "Fail" in C1. Add an IF formula in D1 that displays B1 if A1 is true and C1 if false.
58. Put 150 in A1 and 250 in A2. Add a SUM formula in A3.
59. Put values 10.333, 20.667, and 30.111 in A1 through A3. Add a formula in A4 that sums them and rounds to 1 decimal place.
60. Put 80, 90, and 70 in cells A1, A2, and A3. Calculate the average in A4.
61. Create a spreadsheet with prices in column A (10, 20, 30) and quantities in column B (2, 3, 1). In column C, put the formula to multiply each price by its quantity.
62. Create a spreadsheet with values 5, 10, 15, 20 in cells A1 through A4. In column B, create a running total where each cell sums all values in column A from row 1 to the current row.

## Category 7: Assessment / Validation (63–78)

63. Create a cell where the student must enter the value 100. Validate their answer.
64. Create two input cells. Cell A1 should expect the answer "Hello" and cell A2 should expect "World".
65. Create an input cell that is initially blank. The student must type 42 to get it correct.
66. Put 100 in A1 and 200 in A2. Create a SUM formula cell in A3 and assess that the total equals 300.
67. Create a row of five input cells where the expected answers are 2, 4, 6, 8, 10.
68. Create a column of five input cells where the expected answers are Mon, Tue, Wed, Thu, Fri.
69. Create a cell assessed with the value method where the expected answer is "Springfield".
70. Create a 3 by 3 grid where every cell is assessed. The expected values are 1 through 9 reading left to right, top to bottom.
71. Create a spreadsheet with a mix of display-only cells showing instructions and assessed input cells. Column A has the labels "2+3=", "7-4=", and "3x2=". Column B has blank assessed cells expecting 5, 3, and 6.
72. Create an assessed cell where the expected answer is 3.14.
73. Create an assessed cell where the expected answer is -25.
74. Create two cells with values 10 and 20. Add a third cell assessed with the formula method where the student must enter the correct SUM formula.
75. Put values 10, 20, and 30 in A1 through A3. Assess cell A4 expecting the student to enter the formula =SUM(A1:A3).
76. Put test scores 80, 90, 70, 85, 95 in B1 through B5. Assess cell B6 expecting the student to enter =AVERAGE(B1:B5).
77. Create a spreadsheet where cell A3 is assessed for the value "30" and cell B3 is assessed for the formula =SUM(B1:B2).
78. Create an assessed cell where acceptable answers are in the range 100 to 200 with a step of 50.

## Category 8: Params / Templates (79–85)

79. Create a spreadsheet with a parameter that populates cell A1 with "Hello".
80. Create a spreadsheet with parameters that fill in four cells: A1 gets "Name", B1 gets "Score", A2 gets "Alice", B2 gets "95".
81. Create a parameterized spreadsheet where A1 gets the number 42 and A2 gets 100 from parameters.
82. Create a spreadsheet template where cells display parameter values using template syntax.
83. Create a spreadsheet with parameters providing two input numbers in A1 and A2, and a SUM formula in A3 that adds them.
84. Create a parameterized spreadsheet where A1 and A2 are filled by params and A3 is an assessed SUM formula cell expecting the correct total.
85. Create a parameterized quiz where param values provide the questions in column A and the assessed answer cells in column B expect specific values.

## Category 9: Structural Compositions (86–95)

86. Create a four-column spreadsheet with a header row, 4 data rows, and a SUM total row. Column D computes row totals. Use bold headers and a bottom border on the header row.
87. Create a two-column label/value layout with 4 rows. Column A has bold labels, column B has values. The last row uses a formula to compute a result from the rows above.
88. Create a spreadsheet with a title, 4 columns (Description, Qty, Unit Price, Line Total), 3 data rows with cross-column multiplication formulas in column D, and a SUM grand total. Use bold headers and right-align the numeric columns.
89. Create a two-column spreadsheet where column A has display-only labels and column B has blank assessed cells. Include 4 rows. Assess each B cell with the value method.
90. Create a spreadsheet with two factors in columns A and B, and blank assessed product cells in column C. Include 4 rows. The assessed cells expect the correct multiplication result.
91. Create a spreadsheet with a bold header row, data rows with values in column B, and an AVERAGE formula at the bottom. Center-align column B and format it with one decimal place.
92. Create a two-column label/value spreadsheet with 3 input rows and a formula row. Use bold labels in column A, right-align column B, and add a border below the last input row to separate it from the total.
93. Create a spreadsheet with a title, markdown instructions, two columns of given values, and a third column with assessed blank cells expecting computed results. Style the header row bold and center-align the value columns.
94. Create a spreadsheet with row formatting on row 1 (bold, background color) and column formatting on column B (right-aligned, number format). Fill in a 4-row data set with a SUM at the bottom.
95. Create a spreadsheet with two sections separated by a border row. The top section has 3 data rows with a SUM subtotal. The bottom section has 2 data rows with a SUM subtotal. Add a final row that sums both subtotals. Bold the subtotal and total rows.

## Category 10: Feature Combinations (96–101)

96. Create a spreadsheet with a title, instructions, 4 columns with custom widths, a bold header row with background color, 4 data rows with alternating row colors, AVERAGE formulas in the last column, assessed blank cells for missing values, and center-aligned score columns.
97. Create a spreadsheet with a title, instructions, 3 sections with borders between them, SUM formulas for section subtotals, a final total row using SUM of subtotals, an IF formula that displays "Positive" or "Negative" based on the result, number formatting on value cells, bold on total rows, and an assessed cell on the final total.
98. Create a spreadsheet with a title, instructions, params providing input values for 3 rows, AVERAGE formulas in the last column, ROUND to 2 decimal places on the averages, assessed average cells, a bold header row with background color, and center-aligned columns.
99. Create a spreadsheet with a title, instructions, params for two input values displayed in row 1, two assessed blank cells in rows 2 and 3 expecting computed results, protected cells on the instruction labels, and a light yellow background on the input cells.
100. Create a spreadsheet with a title, instructions, params for 5 rows of question text in column A, blank assessed cells in column B with expected answers, a formula row at the bottom computing a percentage, a bold header row, borders between each question row, right-aligned score column, and number format on the percentage cell.
101. Create an assessed addition spreadsheet — two input values in row 1 and an assessed blank cell in row 2 expecting their sum — and hide the formula bar so students only see the cells.

## Category 11: Weighted Scoring / Partial Credit (102–107)

102. Create a 3-question arithmetic quiz where each assessed cell is worth 2 points.
103. Create a quiz with four assessed cells where the first three are worth 1 point each and the last one is worth 5.
104. Create an assessed spreadsheet with a practice row at the top that is checked but worth 0 points, followed by three scored rows worth 2 points each.
105. Create a column of five assessed cells expecting 2, 4, 6, 8, 10, all worth 2 points each, set once on the row rather than per cell.
106. Create an assessed spreadsheet worth 10 points total, split across four questions, where students get partial credit for each cell they answer correctly.
107. Create a spreadsheet with a title, instructions, five word-problem rows with blank assessed cells in column B, each worth 2 points, and a bold header row.

## Category 12: Multiple Sheets (108–115)

108. Create a workbook with two sheets, one named Revenue and one named Costs, each with a small table.
109. Make a spreadsheet with three tabs, one for each of January, February, and March, each listing daily sales.
110. Create a two-sheet workbook where the first sheet holds the data and the second is a blank worksheet for the student to fill in.
111. Build a workbook with a Data tab showing prices and a Practice tab with assessed cells worth 3 points each.
112. Create a three-sheet workbook titled "Quarterly Review" with a shared set of instructions shown above every tab.
113. Make a two-sheet assessment worth 10 points total, split evenly between the two sheets.
114. Create a single-sheet spreadsheet named Summary that shows its name in the sheet menu.
115. Make a two-sheet workbook where each sheet has its own bold header row and a total row at the bottom.

## Category 13: When Feedback Shows (116–122)

116. Make an assessed multiplication table where each answer turns green or red as soon as the student enters it.
117. Create a practice budget spreadsheet with instant feedback on the total and average cells, so students can correct themselves as they go.
118. Build a unit conversion worksheet that tells students immediately whether each converted value is right.
119. Make a graded tax calculation spreadsheet where students only see which answers are right after they press Check.
120. Create a quiz-style spreadsheet on percentages with no hints while students work; feedback only when they check.
121. A self-study grade book where students fill in each student's average and see right away if it is correct, worth 1 point per cell.
122. Make a two-sheet practice workbook, Fractions and Decimals, that marks every answer right or wrong as students type it.
