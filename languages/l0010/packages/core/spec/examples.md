<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0010 Examples

Seed `prompt → plan` examples for the composition planner. Each maps a request to the language sequence (head first; each id consumes the next).

## Atomic (single language)

1. "make an mcq about France" → `plan ["0158"]..`
2. "a short-answer question about photosynthesis" → `plan ["0158"]..`
3. "a fill-in-the-blank cloze about the water cycle" → `plan ["0158"]..`
4. "build a budget tracker spreadsheet" → `plan ["0166"]..`
5. "a spreadsheet that sums a column of expenses" → `plan ["0166"]..`
6. "a flashcard deck for Spanish verbs" → `plan ["0159"]..`
7. "a concept web of the cell organelles" → `plan ["0169"]..`

## Composed (head + upstream)

8. "create a simple spreadsheet assessment for learnosity" → `plan ["0158" "0166"]..`
9. "a learnosity item where students use the spreadsheet to compute totals" → `plan ["0158" "0166"]..`
10. "a table-based assessment in learnosity" → `plan ["0158" "0166"]..`
11. "embed a flashcard interaction as a learnosity item" → `plan ["0158" "0159"]..`
12. "a learnosity concept-web assessment" → `plan ["0158" "0169"]..`

## No composition

13. "just a spreadsheet, no assessment" → `plan ["0166"]..`
