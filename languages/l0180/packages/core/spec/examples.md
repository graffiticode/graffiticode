<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0180 RAG Training Examples

164 example prompts for training a RAG model on L0180, the web-based assessment language —
covering multiple choice, true/false, multi-select, exact-set scoring, weighted scoring,
penalized distractors, presentation and option order, unscored polls, per-option rationale, clicking
sentences and words inside a passage, fill-in-the-blank including numeric answers and the form they must be written in, dropdown
cloze, word-bank cloze, sequencing, matching, classification, written responses marked against a rubric, multi-part items over a reading passage, and activities that deliver several items together.

Each numbered line is a prompt in the author's own voice. Prompts describe WHAT to build,
never how to write it: an author asks for a question, not for a `choice [...]` program. When
L0180 grows further interaction types, this file grows categories with them.

## Category 1: Basic Multiple Choice (1–12)

1. A multiple-choice question asking what 2 + 2 is, with options 3, 4 and 5, where 4 is correct.
2. Ask which planet is closest to the Sun. Options: Mercury, Venus, Earth, Mars. Mercury is correct.
3. Create a question asking for the capital of France, with Paris, Lyon, Marseille and Nice as options.
4. Which gas do plants absorb during photosynthesis? Offer oxygen, carbon dioxide, nitrogen and hydrogen. Carbon dioxide is right.
5. A reading comprehension question: which word best describes the narrator's mood — anxious, cheerful, bored or angry? Anxious is correct.
6. Ask who wrote "Romeo and Juliet", with Shakespeare, Dickens, Austen and Chaucer as choices.
7. Make a question about the water cycle asking what evaporation turns liquid water into. Options: vapour, ice, rain, snow.
8. Which of these is a prime number: 4, 6, 9 or 7? Seven is the answer.
9. A history question asking in which year the Second World War ended — 1943, 1945, 1947 or 1950.
10. Ask what the chemical symbol for gold is. Offer Au, Ag, Gd and Go, with Au correct.
11. Create a multiple-choice question on the largest organ in the human body, with skin as the correct answer among liver, heart and skin.
12. Which of these shapes has four equal sides? Give square, rectangle, triangle and circle as options.

## Category 2: True/False (13–20)

13. True or false: the Pacific is the largest ocean. True is correct.
14. A true/false question stating that spiders are insects. The answer is false.
15. True or false — the Great Wall of China is visible from the Moon with the naked eye. False.
16. Ask whether water boils at 100 degrees Celsius at sea level, as a true/false item. True.
17. True or false: Australia is both a country and a continent. Correct answer is true.
18. Present the claim "all mammals lay eggs" as true or false. It is false.
19. A true/false item on whether the Amazon is the longest river in the world. False — the Nile is longer.
20. True or false: a triangle's interior angles always sum to 180 degrees. True.

## Category 3: Multi-Select (21–32)

21. Select all the prime numbers from 2, 4, 5, 9 and 11 — 2, 5 and 11 are correct.
22. Which of these are mammals? Blue whale, great white shark, bat, sea turtle. Whale and bat are right.
23. Select all that apply: which of these countries are in South America — Brazil, Peru, Mexico, Chile?
24. Ask which of six words are nouns: run, table, quickly, mountain, sing, courage. Table, mountain and courage.
25. Choose every renewable energy source from solar, coal, wind, natural gas and hydroelectric.
26. Which of these are noble gases? Helium, oxygen, neon, argon, chlorine. Three are correct.
27. Select all the even numbers from 3, 8, 12, 15 and 20.
28. Pick every state of matter listed: solid, gravity, liquid, gas, density.
29. Which of these authors wrote novels in the nineteenth century? Dickens, Austen, Orwell, Brontë.
30. Select all the primary colours from red, green, blue, yellow and orange, allowing up to three selections.
31. Ask which of five foods are good sources of protein: eggs, lettuce, beans, chicken, apples.
32. Which of these are programming languages — Python, HTML, Java, CSS, Ruby? Allow three answers.

## Category 4: Weighted Answers and Partial Credit (33–42)

33. Which planet is closest to the Sun? Mercury is right and worth 2 points.
34. A question on the causes of the Civil War where the best answer earns 3 points.
35. Ask for the derivative of x squared, with the correct option worth 5 points.
36. Which sentence best states the central idea? Make the correct choice worth 2 points rather than 1.
37. Select all the prime numbers from 2, 4, 5, 9 and 11, where 2 is worth 1 point, 5 is worth 2 and 11 is worth 2.
38. A multi-select on renewable energy where each correct source earns 2 points.
39. Ask which two events happened before 1900, awarding 3 points for one and 1 for the other.
40. Which of these are noble gases? Give helium 1 point, neon 1 point and argon 2 points.
41. A question where the best answer is worth 4 points and a partially right answer is worth 1.
42. Make a five-option question where three options are correct and together they total 6 points.

## Category 5: Penalized Distractors (43–48)

43. Which planet is closest to the Sun? Mercury is right; penalize "The Moon" by a point.
44. Ask which of these is a mammal, and take a point off for choosing the great white shark.
45. A question on prime numbers where selecting 9 costs a point.
46. Make a multi-select on noble gases where each wrong selection loses a point.
47. Which word is spelled correctly? Deduct a point for the common misspelling.
48. Ask a chemistry question where the plausible-but-wrong answer carries a one-point penalty.

## Category 6: Presentation — Order and Ids (49–56)

49. Select all the prime numbers from 2, 4, 5, 9 and 11, keeping them in numeric order.
50. A multiple-choice question on the capital of Japan.
51. Ask which of four animals is a mammal and give the options readable ids like "whale" and "shark".
52. A four-option question about which animals are mammals whose last option is "All of the above".
53. A four-option history question where the correct answer is worth 2 points and the options must stay in the order I wrote them.
54. Ask which shape has four equal sides, naming the options "square", "rect", "tri" and "circle".
55. Make a true/false item whose two options are presented in a random order rather than true first.
56. A multi-select on programming languages with authored ids so results can be reported per language.

## Category 7: Unscored Polls (57–60)

57. An ungraded poll asking which topic students found hardest: fractions, decimals or percentages.
58. Ask students how confident they feel about the material — very, somewhat, or not at all — without scoring it.
59. A poll collecting which project theme the class would prefer, with four options and no right answer.
60. Ask which day suits the review session best, as an unscored question.

## Category 8: Passages and Multi-Part Items (61–68)

61. A two-part reading question about a short passage: first what the reader can conclude about the character, then which line supports that answer. Both parts must be right for the point.
62. Give students a paragraph about honeybees and ask which sentence best states the central idea.
63. A reading item with a four-paragraph passage about a girl fixing a neighbour's porch, asking what it shows about her character.
64. Two questions about the same passage on the water cycle, each worth its own point.
65. An evidence-based question where part A asks for the author's purpose and part B asks which sentence shows it — award nothing unless both are right.
66. A passage titled "How a Honeybee Colony Works" followed by a multiple-choice question about the main idea.
67. A two-part item about a short informational text where the first part is worth 2 points and the second is worth 1.
68. Show a numbered passage and ask which line best supports the claim that the narrator regrets her decision.

## Category 9: Exact-Set Scoring (69–74)

69. Choose the two sentences that belong in a summary of the passage — both must be right, or the answer scores nothing.
70. A select-all-that-apply question about the causes of the American Revolution where picking only some of the correct answers earns no credit.
71. Ask which three of these six items are mammals, awarding the point only for exactly the right set.
72. A question about the water cycle asking students to select both processes that return water to the atmosphere — all or nothing.
73. Which two of these five sentences state opinions rather than facts? Score it as exactly right or wrong, with no partial credit.
74. Pick the two steps that belong in the procedure. A student who picks one correct step and one wrong step scores zero.

## Category 10: Rationales for Wrong Answers (75–78)

75. A multiple-choice question about a character's motivation where each wrong option explains why it is wrong once the student picks it.
76. Ask which gas plants absorb during photosynthesis, and explain to a student who chooses oxygen why that is the gas plants release instead.
77. A fractions question where each distractor names the specific mistake a student who picked it probably made.
78. Which sentence best states the central idea? Give a short explanation for each incorrect choice, shown only after it is selected.

## Category 11: Clicking Sentences in a Passage (79-84)

79. Show a short story about a girl at a tide pool and ask the student to click the sentence that best shows she is absorbed by it.
80. A two-part reading item: first pick the statement that describes the narrator, then click the sentence in the passage that supports it. Both must be right.
81. Give a passage about honeybees and ask the student to click the three sentences that show how the colony works together - any three of the four that fit.
82. Ask students to click the sentence that states the central idea of a short informational passage.
83. A passage about a thunderstorm where the student clicks the two sentences that describe what the narrator hears.
84. Show a four-paragraph passage and ask which sentence best shows the author's opinion, answered by clicking it in the text.

## Category 12: Clicking a Word (85-88)

85. Read the sentence "The aqueduct carried water across long distances" and click the word that means a channel that carries water.
86. A vocabulary item where the student clicks the word in the sentence that means "very tiring", with two other candidate words offered.
87. Show a sentence about a ship and ask the student to click the word that means the front of the boat, explaining why each other choice is wrong.
88. Click the word in this sentence that means the opposite of "ancient".

## Category 13: Written Responses (89-94)

89. After a short story about a girl at a tide pool, ask what inference the reader can make and have the student explain it using details from the text. Mark it out of 2.
90. A constructed-response question about the central idea of an informational passage, with a 0-1-2 rubric and a model answer.
91. Ask students to summarize a key event from the passage in a few sentences, scored by a teacher against a rubric.
92. A two-part item where the first part is multiple choice about the author's purpose and the second asks the student to explain their answer in writing.
93. Explain why the narrator changes her mind, citing two details. Give the rubric bands for full, partial and no credit.
94. A written response asking how the two characters' points of view differ, worth 3 points, with a description of what earns each score.

## Category 14: Fill in the Blank (95-102)

95. A fill-in-the-blank question: "The {{blank}} is the powerhouse of the cell", where the answer is mitochondria.
96. Complete the sentence: the capital of France is ___. Accept Paris.
97. A two-blank sentence about the water cycle where the student types the words for evaporation and condensation.
98. Ask students to fill in the missing word in "Photosynthesis turns light into ___", accepting energy or chemical energy.
99. A spelling item where the student types the word "rhythm" into a blank, and capitals must match.
100. Fill in the blanks in a sentence about the American Revolution with the year and the place, each worth its own point.
101. Complete the sentence about a science experiment, accepting either the British or the American spelling of the answer.
102. A cloze question about mitosis with three blanks, where all three must be right for the point.

## Category 15: Numeric Answers (103-113)

103. Ask what half of one is, accepting 0.5, 0.50 or 1/2 as the same answer.
104. A maths question where the student types the value of pi to two decimal places, accepting anything within 0.005.
105. How many sides does a hexagon have? The answer is a whole number.
106. A science question asking for the density of water in g/cm3, accepting 1 or 1.0, with a small tolerance for rounding.
107. Ask for three quarters as a decimal or a fraction, accepting either form.
108. A two-blank question about a rectangle: type its area and its perimeter, each a number worth its own point.
109. Ask the student to express three eighths as a fraction in lowest terms, accepting only a fraction.
110. A chemistry question asking for Avogadro's number, where the answer must be written in scientific notation.
111. Convert one half to a decimal — a fraction is not an acceptable answer here.
112. Ask what one divided by three is, where only a fraction is accepted as the answer.
113. A division question whose answer is two thirds, accepting a decimal rounded to two places.

## Category 16: Dropdown Cloze (114-122)

114. Complete the sentence "Plants absorb ___ and release ___" with dropdowns, choosing between carbon dioxide, oxygen and nitrogen.
115. A grammar question where the student picks the right verb form from a dropdown inside the sentence.
116. Give a sentence about the water cycle with two dropdowns, and explain the wrong option in the first one.
117. A sentence about the American Revolution with a dropdown for the year and another for the place.
118. Ask the student to complete "The mitochondrion is the ___ of the cell" by choosing from four options in the sentence.
119. A dropdown cloze about fractions where the wrong choice costs a point.
120. Complete a sentence about photosynthesis with three dropdowns, where all three must be right for the point.
121. A Spanish sentence with a dropdown for the article and one for the adjective ending.
122. A sentence about the parts of a plant with one dropdown, where the two wrong options each explain themselves.


## Category 17: Putting Things in Order (123-131)

123. Ask the student to put the four stages of the water cycle in order: evaporation, condensation, precipitation, collection.
124. A question that asks students to sequence the events of a story they have just read.
125. Put these five numbers in order from smallest to largest.
126. Ask the student to order the steps of long division.
127. A history question: put these four events of the American Revolution in chronological order.
128. Order the planets from closest to the sun to furthest.
129. Ask students to arrange the words into a correct sentence.
130. A two-part item where the student first picks the right definition and then puts the steps in order, both required for the point.
131. Put the stages of a butterfly's life cycle in the right sequence.

## Category 18: Matching (132-140)

132. Match each country to its capital: France to Paris, Japan to Tokyo, Peru to Lima.
133. A matching question pairing three authors with the books they wrote, with one extra book nobody wrote as a distractor.
134. Match each scientific term to its definition.
135. Pair each element symbol with the element it stands for: Na, K, Fe.
136. A vocabulary matching item where each Spanish word is matched to its English translation.
137. Match each state to its capital, and explain the pairing students most often get wrong.
138. Pair each historical event with the year it happened, all four required for the point.
139. A matching question where one pairing is worth two points because it is the hardest.
140. Match each shape to the number of sides it has.

## Category 19: Classification (141-148)

141. Sort these animals into mammals, reptiles and birds: blue whale, iguana, bat, eagle, python.
142. A classification question sorting numbers into prime and composite.
143. Sort each sentence into fact or opinion.
144. Classify these foods as fruits or vegetables, where several go in each group.
145. Sort the given words into nouns, verbs and adjectives.
146. A sorting question that puts each material into solid, liquid or gas.
147. Classify each shape as a polygon or not a polygon.
148. Sort each of these inventions into the category it belongs to: transport, communication or medicine.

## Category 20: Word-Bank Cloze (149-156)

149. Complete "The ___ orbits the ___" by dragging words from a bank of Moon, Earth and Sun.
150. A sentence about photosynthesis with two gaps filled from a word bank, with one extra word nobody needs.
151. Fill the gaps in a sentence about the water cycle by dragging the right terms into place.
152. A grammar exercise where the student drags the correct verb forms into three gaps in a paragraph.
153. Complete a definition of gravity by dragging two words from a bank of five.
154. A Spanish sentence with two gaps filled from a bank of articles and adjectives.
155. Drag the right dates into a sentence about the American Revolution, all gaps required for the point.
156. A sentence about the parts of a cell with three gaps and a bank of four words.

## Category 21: Activities (157-164)

157. A five-question quiz on the water cycle, all multiple choice.
158. Build a short test with three questions: one multiple choice, one fill-in-the-blank and one ordering task.
159. A practice set of four questions about fractions that a student can move back and forth between.
160. Make a quiz the student cannot go back through once they have answered a question.
161. A ten-question vocabulary test that submits each answer as it is given.
162. Put these three reading questions together into one activity, each scored on its own.
163. A mixed quiz with a passage-based two-part item and two standalone questions after it.
164. An end-of-unit test on the American Revolution with six questions of different kinds.
