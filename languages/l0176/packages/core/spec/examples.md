<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0176 RAG Training Examples

186 example prompts for training a RAG model on the L0176 Learnosity assessment language.
Each numbered line is a prompt in the author's own voice; the category preambles
carry the generator-facing notes about what the prompt should compile to.
Prompts may write math in plain Unicode (`3 × 4`); the generated question must
still encode it as LaTeX — see the Math Notation section of `instructions.md`.

## Category 1: Multiple Choice (1–16)

1. Create a multiple choice question asking "What is the capital of France?" with options "Paris", "London", "Berlin", "Madrid" where Paris is correct.
2. Create a multiple choice question asking "Which planet is largest?" with options "Earth", "Jupiter", "Mars", "Saturn" where Jupiter is correct.
3. Create a multiple choice question with instant feedback asking "What is 2 + 2?" with options "3", "4", "5", "6" where 4 is correct.
4. Create a multiple choice question allowing multiple responses asking "Which are prime numbers?" with options "2", "4", "7", "9" where 2 and 7 are correct.
5. Create a multiple choice question with shuffled options asking "What color is the sky?" with options "Blue", "Green", "Red" where Blue is correct.
6. Create a multiple choice question asking "Which season comes after spring?" with options "Summer", "Fall", "Winter" where Summer is correct.
7. Create a multiple choice question asking "Which is a mammal?" with options "Shark", "Eagle", "Dolphin", "Lizard" where Dolphin is correct, with instant feedback enabled.
8. Create a multiple choice question asking "Select all even numbers" with options "1", "2", "3", "4" where 2 and 4 are correct, allowing multiple responses.
9. Create a multiple choice question asking "What is the boiling point of water?" with options "50°C", "100°C", "150°C", "200°C" where 100°C is correct.
10. Create a multiple choice question asking "Which ocean is the largest?" with options "Pacific", "Atlantic", "Indian", "Arctic" where Pacific is correct.
11. Create an items assessment with a single MCQ asking "What is 3 × 4?" with options "7", "10", "12", "15" where 12 is correct.
12. Create an items assessment with an MCQ asking "What is the largest continent?" with options "Asia", "Africa", "Europe", "Antarctica" where Asia is correct.
13. Create a multiple choice true/false question asking "The Earth is flat" with options "True", "False" where False is correct.
14. Create a multiple choice question asking "Which element has atomic number 1?" with options "Helium", "Hydrogen", "Lithium", "Carbon" where Hydrogen is correct, with shuffled options.
15. Create a multiple choice question asking "What is the square root of 144?" with options "10", "11", "12", "13" where 12 is correct, with instant feedback.
16. Create a multiple choice question asking "Which continent is Egypt in?" with options "Africa", "Asia", "Europe", "South America" where Africa is correct, and add a check answer button.

## Category 2: Short Text (17–26)

17. Create a short text question asking "What is the chemical symbol for water?" with the correct answer "H2O".
18. Create a short text question asking "Spell the number 4" with the correct answer "four", case insensitive.
19. Create a short text question asking "What is the capital of Japan?" with the correct answer "Tokyo".
20. Create a short text question asking "Type the missing word: The quick brown ___" with the correct answer "fox", with a maximum length of 20 characters.
21. Create a short text question asking "What is 7 × 8?" with the correct answer "56".
22. Create a short text question with a placeholder "Enter your answer here" asking "Name the largest ocean" with the correct answer "Pacific".
23. Create a short text question asking "What gas do plants absorb?" with the correct answer "carbon dioxide", case insensitive.
24. Create a short text question asking "What is the abbreviation for Doctor?" with the correct answer "Dr.", case sensitive.
25. Create an items assessment with a short text question asking "What year did World War II end?" with the correct answer "1945".
26. Create a short text question asking "What is the opposite of hot?" with the correct answer "cold", case insensitive.

## Category 3: Essay — Long Text and Plain Text (27–36)

27. Create a long text essay question asking "Describe the water cycle in your own words" with a 300-word limit.
28. Create a long text essay question asking "Write about your favorite book" with placeholder text "Start writing here...".
29. Create a plain text essay question asking "Explain your reasoning" with a 200-word limit.
30. Create a long text essay question asking "Discuss the causes of climate change" with a 500-word limit and placeholder "Begin your essay...".
31. Create a plain text essay question asking "Summarize the main argument" with a 150-word limit.
32. Create a long text essay question asking "Explain how gravity works" with a 400-word limit and placeholder "Begin your explanation...".
33. Create a plain text essay question asking "List three things you learned today" with a 100-word limit.
34. Create an items assessment with a long text essay asking "Compare and contrast two historical events" with a 400-word limit.
35. Create a plain text question asking "Write a brief biography" with a 250-word limit and placeholder "Name, birth date, achievements...".
36. Create a long text essay asking "Analyze the themes in the poem" with a 600-word limit.

## Category 4: Cloze Text — Fill in the Blank (37–47)

37. Create a cloze text question with the template "The {{response}} is the powerhouse of the cell" with the correct answer "mitochondria".
38. Create a cloze text question with the template "Water is made of {{response}} and oxygen" with the correct answer "hydrogen", case insensitive.
39. Create a cloze text question with the template "The {{response}} of the United States is Washington, D.C." with the correct answer "capital", case insensitive.
40. Create a cloze text question with the template "{{response}} is the chemical symbol for gold" with the correct answer "Au".
41. Create a cloze text question with two blanks: "The {{response}} is in the {{response}} system" with correct answers "Sun" and "solar".
42. Create a cloze text with instant feedback and the template "Plants convert {{response}} into oxygen" with the correct answer "carbon dioxide".
43. Create a cloze text question with the template "Photosynthesis occurs in the {{response}} of plant cells" with the correct answer "chloroplast", case insensitive.
44. Create a cloze text question with the template "A group of lions is called a {{response}}." with the correct answer "pride" and also accept "troop" as an alternate, case insensitive.
45. Create an items assessment with a cloze text question: "The {{response}} War ended in {{response}}" with correct answers "Civil" and "1865".
46. Create a cloze text question with the template "DNA stands for {{response}} acid" with the correct answer "deoxyribonucleic", case insensitive.
47. Create a cloze text question with the template "The speed of {{response}} is approximately 300,000 km/s" with the correct answer "light".

## Category 5: Cloze Association — Drag and Drop (48–54)

48. Create a cloze association question with the template "Drag the correct answer: {{response}} is the largest planet" with possible responses "Jupiter", "Saturn", "Earth" where Jupiter is correct.
49. Create a cloze association question with the template "{{response}} wrote Romeo and Juliet" with possible responses "Shakespeare", "Dickens", "Austen" where Shakespeare is correct.
50. Create a cloze association question with two blanks: "{{response}} is to hot as {{response}} is to cold" with possible responses "fire", "ice", "water" where fire and ice are correct.
51. Create a cloze association question with the template "The chemical formula for water is {{response}}" with possible responses "H2O", "CO2", "NaCl" where H2O is correct.
52. Create an items assessment with a cloze association: "The {{response}} is the closest star to Earth" with possible responses "Sun", "Moon", "Mars" where Sun is correct.
53. Create a cloze association with instant feedback: "{{response}} discovered gravity" with possible responses "Newton", "Einstein", "Galileo" where Newton is correct.
54. Create a cloze association: "{{response}} is the capital of {{response}}" with possible responses "Paris", "France", "Germany", "Berlin" where Paris and France are correct.

## Category 6: Cloze Dropdown (55–60)

55. Create a cloze dropdown question with the template "The sky is {{response}}" with dropdown options "blue", "red", "green" where blue is correct.
56. Create a cloze dropdown with two blanks: "{{response}} are mammals and {{response}} are reptiles" with dropdown options ["Dogs", "Cats", "Fish"] and ["Snakes", "Birds", "Frogs"] where Dogs and Snakes are correct.
57. Create a cloze dropdown question with the template "The largest mammal is the {{response}}" with options "blue whale", "elephant", "giraffe" where blue whale is correct.
58. Create a cloze dropdown: "Water boils at {{response}} degrees Celsius" with options "50", "100", "150" where 100 is correct.
59. Create an items assessment with a cloze dropdown: "The Earth revolves around the {{response}}" with options "Sun", "Moon", "Mars" where Sun is correct.
60. Create a cloze dropdown with instant feedback: "HTML stands for {{response}}" with options "HyperText Markup Language", "High Tech Modern Language", "Home Tool Markup Language" where the first is correct.

## Category 7: Cloze Formula — Math (61–78)

61. Create a cloze formula question asking "Solve: x + 3 = 7. x = {{response}}" with the correct answer "4" using equivLiteral method.
62. Create a cloze formula question asking "Simplify: 5x + 3 - 3x = {{response}}" with the correct answer "2x + 3" using equivSymbolic method.
63. Create a cloze formula question asking "What is the derivative of x²? {{response}}" with the correct answer "2x" using equivSymbolic method.
64. Create a cloze formula question asking "What is 5 × 6? {{response}}" with the correct answer "30" using equivLiteral method.
65. Create a cloze formula question asking "Factor: x² - 4 = {{response}}" with the correct answer "(x-2)(x+2)" using equivSymbolic method.
66. Create a cloze formula question asking "Evaluate: 2³ = {{response}}" with the correct answer "8" using equivValue method.
67. Create an items assessment with a cloze formula: "Solve for y: 2y = 10. y = {{response}}" with the correct answer "5".
68. Create a cloze formula question with instant feedback asking "√16 = {{response}}" with the correct answer "4" using equivLiteral method.
69. Create a cloze formula question asking "Express as a fraction: 0.5 = {{response}}" with the correct answer "\\frac{1}{2}" using equivValue method.
70. Create a cloze formula question asking "Write x²/x in its simplest form: {{response}}" that requires the response to be fully simplified, using the isSimplified method — a predicate, so there is no expected answer to compare against.
71. Create a cloze formula question asking "Expand (x + 1)²: {{response}}" that requires the response to be in expanded form, using the isExpanded method — a predicate, so there is no expected answer to compare against.
72. Create a cloze formula question asking "Factor x² - 9: {{response}}" that requires the response to be in factorised form, using the isFactorised method, with no expected answer.
73. Create a cloze formula question asking "Write a true inequality comparing 5 and 3: {{response}}" that accepts any response which is a true statement, using the isTrue method — both "5 > 3" and "3 < 5" should score.
74. Create a cloze formula question asking "Divide 100 by 3: {{response}}" with the correct answer "100/3" using equivValue method compared to two decimal places, so a rounded "33.33" is accepted as well as the exact value.
75. Create a cloze formula question asking "A pencil measures 5 centimetres. Enter that length including its unit: {{response}}" that requires the answer to carry the unit, using the isUnit method with the unit "cm".
76. Create a cloze formula question asking "Give the mass of the Sun in scientific notation: {{response}} kg" that requires the response to be written in scientific notation, using the equivSyntax method with the scientific rule and ignoring any LaTeX text the learner types alongside the number.
77. Create a cloze formula question asking "Express 1/4 as a decimal: {{response}}" that must be both right and written as a decimal: score the blank with two rules, equivValue against "1/4" for the value and equivSyntax with the decimal rule for the form, so "0.25" scores but "1/4" does not.
78. Create a cloze formula question asking "Type the mass-energy equivalence formula exactly as written: {{response}}" with the correct answer "E=mc^2" using stringMatch method, so the exact characters are what count and spacing differences are marked wrong.

## Category 8: Choice Matrix (79–85)

79. Create a choice matrix question asking "Classify each statement" with rows "The sun is a star" and "The moon is a planet" and columns "True" and "False" where the answers are True and False.
80. Create a choice matrix question asking "Rate your agreement" with rows "Exercise is important", "Sleep is optional" and columns "Agree", "Disagree" where answers are Agree and Disagree.
81. Create a choice matrix asking "Is each statement a fact or opinion?" with rows "The Earth orbits the Sun", "Pizza is the best food" and columns "Fact", "Opinion" where answers are Fact and Opinion.
82. Create a choice matrix asking "Identify the part of speech" with rows "run", "beautiful", "quickly" and columns "Noun", "Verb", "Adjective", "Adverb" where answers are Verb, Adjective, and Adverb.
83. Create an items assessment with a choice matrix: "Is each number even or odd?" with rows "2", "3", "4", "5" and columns "Even", "Odd" where answers are Even, Odd, Even, Odd.
84. Create a choice matrix with shuffled options asking "Match each country to its continent" with rows "Brazil", "Japan", "Egypt" and columns "South America", "Asia", "Africa" where each matches respectively.
85. Create a choice matrix asking "Classify each animal" with rows "Whale", "Cobra", "Eagle" and columns "Mammal", "Reptile", "Bird" where each matches respectively.

## Category 9: Order List (86–92)

86. Create an order list question asking "Arrange in chronological order" with items "World War II", "World War I", "Moon Landing", "Internet" where the correct order is WWI, WWII, Moon Landing, Internet.
87. Create an order list question asking "Order from smallest to largest" with items "Jupiter", "Earth", "Mars", "Mercury" where the correct order is Mercury, Mars, Earth, Jupiter.
88. Create an order list question asking "Order these fractions from least to greatest" with items "1/2", "1/4", "3/4", "1/8" where the correct order is 1/8, 1/4, 1/2, 3/4.
89. Create an order list asking "Arrange the steps of the scientific method" with items "Hypothesis", "Experiment", "Observation", "Conclusion" where the correct order is Observation, Hypothesis, Experiment, Conclusion.
90. Create an items assessment with an order list: "Order these numbers" with items "5", "2", "8", "1" where the correct order is 1, 2, 5, 8.
91. Create an order list with instant feedback asking "Arrange alphabetically" with items "Cherry", "Apple", "Banana", "Date" where the correct order is Apple, Banana, Cherry, Date.
92. Create an order list asking "Order from coldest to hottest" with items "Boiling water", "Room temperature", "Ice", "Body temperature" where the correct order is Ice, Room temperature, Body temperature, Boiling water.

## Category 10: Classification (93–100)

93. Create a classification question asking "Sort the animals" with categories "Mammals" and "Reptiles" and items "Dog", "Snake", "Cat", "Lizard" where Dog and Cat are Mammals and Snake and Lizard are Reptiles.
94. Create a classification question asking "Sort by state of matter" with categories "Solid", "Liquid", "Gas" and items "Ice", "Water", "Steam", "Rock", "Juice", "Helium" where Ice and Rock are Solid, Water and Juice are Liquid, and Steam and Helium are Gas.
95. Create a classification question asking "Sort by type of energy" with categories "Renewable", "Non-renewable" and items "Solar", "Coal", "Wind", "Natural Gas" where Solar and Wind are Renewable and Coal and Natural Gas are Non-renewable.
96. Create a classification asking "Sort by food group" with categories "Fruits", "Vegetables" and items "Apple", "Carrot", "Banana", "Broccoli" where Apple and Banana are Fruits and Carrot and Broccoli are Vegetables.
97. Create an items assessment with a classification: "Sort by type" with categories "Even", "Odd" and items "1", "2", "3", "4" where 2 and 4 are Even and 1 and 3 are Odd.
98. Create a classification asking "Classify the words" with categories "Nouns", "Verbs" and items "run", "cat", "jump", "house" where cat and house are Nouns and run and jump are Verbs.
99. Create a classification with instant feedback asking "Sort by era" with categories "Ancient", "Modern" and items "Pyramids", "Internet", "Roman Empire", "Space Station" where Pyramids and Roman Empire are Ancient and Internet and Space Station are Modern.
100. Create a classification asking "Sort instruments" with categories "String", "Wind", "Percussion" and items "Guitar", "Flute", "Drum", "Violin", "Trumpet", "Cymbal" where Guitar and Violin are String, Flute and Trumpet are Wind, and Drum and Cymbal are Percussion.

## Category 11: Multi-Question Assessments (101–110)

101. Create an items assessment with an MCQ asking "What is 2+2?" with options "3", "4", "5" where 4 is correct, and a short text question asking "Spell the answer" with correct answer "four".
102. Create an items assessment with a cloze text "The {{response}} is the largest organ" with correct answer "skin", and an MCQ asking "Which system does it belong to?" with options "Nervous", "Digestive", "Integumentary" where Integumentary is correct.
103. Create an items assessment with a long text essay asking "Describe photosynthesis" with a 300-word limit, and an MCQ asking "What gas do plants produce?" with options "CO2", "O2", "N2" where O2 is correct.
104. Create an items assessment with three MCQ questions about geography: capital of France (Paris), capital of Japan (Tokyo), and capital of Australia (Canberra).
105. Create an items assessment with a cloze formula "Solve: 2x = 10. x = {{response}}" with correct answer "5", and a short text question asking "Is this equation linear?" with correct answer "yes".
106. Create an items assessment with an order list asking "Order the planets from the Sun" with items "Earth", "Mars", "Venus", "Mercury" in correct order Mercury, Venus, Earth, Mars, and a classification sorting them into "Inner" and "Outer" categories.
107. Create an items assessment with a choice matrix about weather: rows "Rain", "Snow", "Sunshine" with columns "Warm", "Cold" where Rain is Warm, Snow is Cold, and Sunshine is Warm.
108. Create an items assessment with a cloze dropdown "Water is {{response}}" with options "solid", "liquid", "gas" where liquid is correct, and a cloze association "Ice is {{response}}" with possible responses "solid", "liquid", "gas" where solid is correct.
109. Create an items assessment with a plain text essay asking "Reflect on what you learned" with a 200-word limit, and an MCQ asking "How confident are you?" with options "Very", "Somewhat", "Not at all" where Very is correct.
110. Create an items assessment combining four question types: an MCQ, a short text, a cloze text, and an order list, all related to basic math facts.

## Category 12: Bow-tie (NGN/NCLEX) (111–116)

Each bow-tie has a clinical scenario as the stimulus, three labeled source
pools, and a 2-1-2 correct-answer pattern (two actions, one condition, two
parameters to monitor).

111. Create a bow-tie question with the scenario "A 65-year-old male presents with chest pain and diaphoresis". Columns are "Actions to Take", "Condition Most Likely", "Parameters to Monitor". Actions options: "give aspirin", "give nitro", "call cardiology", "obtain 12-lead ECG". Condition options: "myocardial infarction", "pulmonary embolism", "pericarditis". Monitor options: "ST segment changes", "blood pressure", "troponin", "respiratory rate". Correct actions: "give aspirin" and "obtain 12-lead ECG". Correct condition: "myocardial infarction". Correct monitors: "ST segment changes" and "troponin".
112. Create a bow-tie question for a patient with dyspnea and lower-extremity edema. Columns: "Actions", "Condition", "Monitor". Actions: "administer furosemide", "elevate head of bed", "start CPR", "place in Trendelenburg". Condition: "acute heart failure", "pneumothorax", "sepsis". Monitor: "daily weight", "oxygen saturation", "blood glucose", "urine output". Correct actions: "administer furosemide", "elevate head of bed". Correct condition: "acute heart failure". Correct monitors: "daily weight", "urine output".
113. Create a bow-tie for a toddler with a high fever and stiff neck. Columns: "Actions to Take", "Condition Most Likely", "Parameters to Monitor". Actions: "draw blood cultures", "give ibuprofen", "isolate the patient", "consult neurology". Condition: "bacterial meningitis", "febrile seizure", "viral URI". Monitor: "level of consciousness", "temperature", "weight", "skin turgor". Correct actions: "draw blood cultures", "isolate the patient". Correct condition: "bacterial meningitis". Correct monitors: "level of consciousness", "temperature".
114. Create a bow-tie for a post-op patient with sudden tachycardia and low oxygen saturation. Columns: "Actions", "Condition", "Monitor". Actions: "administer oxygen", "notify provider", "encourage oral fluids", "ambulate the patient". Condition: "pulmonary embolism", "myocardial infarction", "atelectasis". Monitor: "oxygen saturation", "respiratory rate", "dietary intake", "capillary refill". Correct actions: "administer oxygen", "notify provider". Correct condition: "pulmonary embolism". Correct monitors: "oxygen saturation", "respiratory rate".
115. Create a bow-tie for a diabetic patient found confused and diaphoretic. Columns: "Actions", "Condition", "Monitor". Actions: "give 15 g oral glucose", "check finger-stick glucose", "administer insulin", "start normal saline". Condition: "hypoglycemia", "diabetic ketoacidosis", "stroke". Monitor: "blood glucose", "level of consciousness", "weight", "urine ketones". Correct actions: "give 15 g oral glucose", "check finger-stick glucose". Correct condition: "hypoglycemia". Correct monitors: "blood glucose", "level of consciousness".
116. Create a bow-tie for a patient with severe abdominal pain and rebound tenderness. Columns: "Actions to Take", "Condition Most Likely", "Parameters to Monitor". Actions: "keep NPO", "administer pain medication", "encourage ambulation", "insert nasogastric tube". Condition: "appendicitis", "gastroenteritis", "kidney stones". Monitor: "temperature", "bowel sounds", "skin integrity", "hydration status". Correct actions: "keep NPO", "insert nasogastric tube". Correct condition: "appendicitis". Correct monitors: "temperature", "bowel sounds".

## Category 13: Metadata and Tagging (117–127)

117. Create an order list question asking "Arrange the planets by distance from the Sun" with items "Mercury", "Venus", "Earth", "Mars", tagged with difficulty easy and DOK 1.
118. Create a multiple choice question asking "What is the primary function of the mitochondria?" with four options where "ATP production" is correct, tagged with NGSS MS-LS1-2 and difficulty medium.
119. Create a short text question asking "What is the chemical symbol for water?" with the correct answer "H2O", tagged with CCSS 5-PS1-1, difficulty easy, DOK 1.
120. Create a cloze dropdown question with the template "The {{response}} is the powerhouse of the cell" with options "mitochondria", "nucleus", "ribosome" where mitochondria is correct, tagged with difficulty medium and DOK 2.
121. Create a multiple choice question asking "What is the function of the cell membrane?" with four options where "control what enters and exits" is correct, and add a one-line distractor rationale per option explaining each misconception.
122. Create a multiple choice question asking "Who painted the Mona Lisa?" with four options where "Leonardo da Vinci" is correct, with question-level acknowledgements "Image courtesy Louvre Museum, public domain".
123. Create a multiple choice question asking "What gas do plants primarily absorb during photosynthesis?" with options "Oxygen", "Carbon dioxide", "Nitrogen", "Helium" where Carbon dioxide is correct, with a one-line distractor rationale per option, tagged with NGSS MS-LS1-6, difficulty medium, DOK 2.
124. Create a choice matrix question asking "Classify each statement" with rows "The sun is a star" and "The moon is a planet" and columns "True" and "False", tagged with NGSS MS-ESS1-2 and difficulty easy, with per-row rationale explaining the correct classification.
125. Create a classification question asking "Sort animals by class" with categories "Mammals" and "Reptiles" and items "dog", "snake", "cat", "lizard", tagged with NGSS MS-LS4-2 and difficulty medium, with an item-level note "Variant for the genetics unit; pair with the inheritance MCQ".
126. Update the existing item with id <ITEM_ID>: change the stem to be shorter and clearer, but keep all the existing tags, difficulty, DOK, and per-option distractor rationale unchanged.
127. Update the existing item with id <ITEM_ID>: keep the stem and options unchanged, but change the difficulty tag from medium to hard and update DOK from 2 to 3 — leave the distractor rationale alone.

## Category 14: Custom Spreadsheet Questions (L0179 Embedded) (128–140)

These items emit a `custom` Learnosity question with `lang "0179"`. The
spreadsheet payload is either supplied inline via `model { ... }` describing
an L0179 program, or read from the upstream pipeline task with
`model data use "0179"` — the `use` form, not the bare `data {default}`
fallback, which renders an empty widget. The embedded L0179 widget handles scoring via its own
`scorer.js` — `valid-response` is not used.

128. Create a custom spreadsheet question that embeds the L0179 interaction. Stem: "Use the spreadsheet below to compute the column totals for the first quarter." Read the spreadsheet model from the upstream pipeline task using `data use "0179"`.
129. Create a custom spreadsheet question backed by L0179 with the stem "Complete the SUM formula in cell A6." The embedded spreadsheet has the values 10, 20, 30, 40, 50 in cells A1 through A5, and an assessed cell A6 expecting the student to enter `=SUM(A1:A5)` using the formula method.
130. Create a custom spreadsheet question with the stem "Fill in the 3 by 3 multiplication table." Embed an L0179 spreadsheet containing a 3 by 3 grid of assessed input cells whose expected values are the products of the row and column headings 1, 2 and 3 — 1, 2, 3 then 2, 4, 6 then 3, 6, 9, reading left to right, top to bottom.
131. Create a custom spreadsheet question with the stem "Compute the line totals and grand total for the order below." The embedded L0179 spreadsheet has a header row (Product, Qty, Unit Price, Line Total), 3 data rows with per-row line-total formulas in column D (`=B2*C2` and so on), and a SUM grand total in D5. Bold the header row and right-align the numeric columns.
132. Create a custom spreadsheet question that embeds a parameterized L0179 sheet. Stem: "Add the two values shown and enter the total in A3." The spreadsheet uses params to populate A1 and A2 and assesses cell A3 with the formula method expecting the correct SUM formula across the param values.
133. Create a custom spreadsheet question that reads its model from the upstream pipeline task. Stem: "Use the supplied worksheet to enter the missing values in column B." Save the item to the item bank — the snapshot freezes the upstream payload at compile time.
134. Create an items assessment with two questions. First, a custom L0179 spreadsheet with stem "Enter the average of the listed test scores in cell B7." The embedded sheet has scores 85, 92, 78, 95, 88 in B2 through B6 and an assessed cell B7 expecting `=AVERAGE(B2:B6)`. Second, a short text question asking "Which spreadsheet function did you use?" with the correct answer "AVERAGE", case insensitive.
135. Create a custom spreadsheet question with the stem "Label each row in column B as Positive or Negative based on the value in column A." Embed an L0179 spreadsheet with 5 numeric values in column A (mix of positive and negative numbers) and 5 assessed blank cells in column B expecting the labels Positive or Negative reading top to bottom.
136. Create a custom spreadsheet question with the stem "Use the monthly budget worksheet to compute the total in cell B7." The embedded L0179 spreadsheet has category labels in column A (Rent, Groceries, Utilities, Transportation, Other), dollar amounts in column B right-aligned with two decimal places, and an assessed `=SUM(B2:B6)` cell in B7. Tag the item with difficulty medium, DOK 2, and CCSS 6.RP.A.3c.
137. Create a custom spreadsheet question with the stem "Solve each arithmetic problem in column B." Embed an L0179 spreadsheet where column A has display-only labels "2+3=", "7-4=", and "3×2=" and column B has blank assessed cells expecting the values 5, 3, and 6 respectively. Tag the item with difficulty easy and DOK 1.
138. Create a custom spreadsheet question that reads the upstream task model via `data use "0179"`. Stem: "Use the spreadsheet supplied above to answer the prompt." Do not emit a `valid-response` — scoring is handled by the embedded L0179 widget.
139. Create a custom spreadsheet question with the stem "Enter the correct multiplication formula in each cell of column C." Embed an L0179 spreadsheet with prices in column A (10, 20, 30), quantities in column B (2, 3, 1), and three assessed cells in column C using the formula method expecting `=A1*B1`, `=A2*B2`, and `=A3*B3` row by row.
140. Create a custom spreadsheet question with the stem "Compute each section subtotal and the grand total." The embedded L0179 spreadsheet has two sections of 3 data rows each in column A, an assessed SUM subtotal cell at the bottom of each section, and a final assessed cell summing the two subtotals. Bold the subtotal and total rows. Tag the item with difficulty hard and DOK 3.

## Category 15: Dynamic Data — Params for Math Questions (141–152)

These items carry a dynamic-data table declared with the item-level `params`
keyword: a list of row records, one drawn per session. Reference a column
anywhere in the question with a `{{colname}}` placeholder — `{{response}}`
stays reserved for the cloze blank. Placeholders are substituted wherever a
string appears (stem, options, and `valid-response`), so the correct answer
can vary row by row: give the answer its own column and point `valid-response`
at it. Use this for math questions that should show each student different
numbers without an upstream L0179 widget. (When an embedded L0179 question
supplies its own `templateVariablesRecords`, that inherited table takes
precedence over a hardwired `params` table on the same item.)

141. Create a cloze formula question with a dynamic data table so each student sees different numbers: stem "Compute {{a}} + {{b}} = {{response}}". Provide rows {a: 2, b: 3, ans: 5}, {a: 7, b: 5, ans: 12}, {a: 14, b: 8, ans: 22}, and set the correct answer to {{ans}} using equivValue.
142. Create a cloze formula question with the stem "Solve for x: {{m}}x = {{p}}. x = {{response}}" and a params table {m: 2, p: 10, x: 5}, {m: 3, p: 12, x: 4}, {m: 5, p: 45, x: 9}, with the correct answer {{x}} using equivLiteral.
143. Create a cloze formula question with the stem "Find the area of a {{w}} by {{h}} rectangle: {{response}}" and rows {w: 4, h: 5, area: 20}, {w: 6, h: 3, area: 18}, {w: 7, h: 2, area: 14}, with the correct answer {{area}} using equivValue.
144. Create a cloze formula question with instant feedback and a dynamic table: "Evaluate {{a}}^{{n}} = {{response}}" with rows {a: 2, n: 3, ans: 8}, {a: 3, n: 2, ans: 9}, {a: 5, n: 2, ans: 25}, and the correct answer {{ans}} using equivValue.
145. Create a cloze formula question with two blanks driven by a params table: "{{a}} + {{b}} = {{response}} and {{a}} − {{b}} = {{response}}" with rows {a: 8, b: 3, sum: 11, diff: 5}, {a: 10, b: 6, sum: 16, diff: 4}, {a: 9, b: 4, sum: 13, diff: 5}, with correct answers {{sum}} and {{diff}} using equivValue.
146. Create a multiple choice question with a dynamic table asking "Which value equals {{a}} + {{b}}?" with options "{{sum}}", "{{d1}}", "{{d2}}", "{{d3}}" where the first option is correct, with options shuffled. Rows: {a: 12, b: 7, sum: 19, d1: 17, d2: 21, d3: 18}, {a: 9, b: 6, sum: 15, d1: 13, d2: 16, d3: 14}, {a: 14, b: 8, sum: 22, d1: 20, d2: 24, d3: 21}.
147. Create a multiple choice question with a dynamic table asking "What is {{a}} × {{b}}?" with options "{{prod}}", "{{near}}", "{{far}}", "{{off}}" where the first option is correct and options are shuffled. Rows: {a: 6, b: 7, prod: 42, near: 48, far: 36, off: 49}, {a: 8, b: 4, prod: 32, near: 28, far: 36, off: 24}, {a: 9, b: 6, prod: 54, near: 56, far: 45, off: 63}.
148. Create a cloze formula question with the stem "Round {{x}} to the nearest ten: {{response}}" and rows {x: 47, ans: 50}, {x: 83, ans: 80}, {x: 25, ans: 30}, with the correct answer {{ans}} using equivValue.
149. Create an items assessment with two dynamically parameterized questions, each with its own params table. First, a cloze formula "Add {{a}} + {{b}} = {{response}}" with rows {a: 5, b: 6, ans: 11}, {a: 8, b: 9, ans: 17}, {a: 13, b: 4, ans: 17} and correct answer {{ans}}. Second, a multiple choice "Which value equals {{a}} − {{b}}?" with options "{{diff}}", "{{d1}}", "{{d2}}" where the first is correct, shuffled, with rows {a: 20, b: 8, diff: 12, d1: 28, d2: 13}, {a: 15, b: 9, diff: 6, d1: 24, d2: 7}.
150. Create a cloze formula question with a dynamic table and save it to the item bank so the parameter table is persisted with the saved item: stem "Compute {{a}} ÷ {{b}} = {{response}}" with rows {a: 12, b: 4, ans: 3}, {a: 20, b: 5, ans: 4}, {a: 18, b: 6, ans: 3}, correct answer {{ans}} using equivValue.
151. Create a multiple choice question with a dynamic table asking "Is {{a}} + {{b}} equal to {{claimed}}?" with options "True" and "False" where False is correct, and add a one-line distractor rationale per option. Rows: {a: 7, b: 8, claimed: 14}, {a: 9, b: 6, claimed: 16}, {a: 12, b: 5, claimed: 18}.
152. Create a cloze formula question with a dynamic table asking "Simplify {{a}}x + {{b}}x = {{response}}" with rows {a: 3, b: 4, ans: "7x"}, {a: 5, b: 2, ans: "7x"}, {a: 6, b: 9, ans: "15x"}, with the correct answer {{ans}} using equivSymbolic, tagged with CCSS 7.EE.A.1, difficulty medium, DOK 2.

## Category 16: Token Highlight (153–164)

Each token-highlight item names a passage, the correct tokens to highlight, and
the clickable distractors. Only the listed tokens are clickable; matching is
case-insensitive and whole-word, and a repeated correct token counts at every
occurrence.

A clickable token can be a whole sentence or a whole paragraph, not just a
single word: list the full sentence (including its end punctuation) or the full
paragraph text as a correct token or distractor, and the entire span becomes one
clickable unit. Examples 159–161 highlight whole sentences; Examples 162–164
highlight whole paragraphs.

153. Create a token highlight question asking "Highlight the verbs." with the passage "The cat runs then jumps high." where "runs" and "jumps" are correct and "cat" and "high" are clickable distractors.
154. Create a token highlight question asking "Click the two nouns." with the passage "A small dog chased the red ball across the yard." where "dog" and "ball" are correct, and "small", "red", and "yard" are distractors.
155. Create a token highlight question asking "Highlight every word spelled incorrectly." with the passage "She recieved a seperate letter in the libary." where "recieved", "seperate", and "libary" are correct and "letter" is a distractor.
156. Create a token highlight question asking "Select the adjectives." with the passage "The bright sun warmed the cold sand on the quiet beach." where "bright", "cold", and "quiet" are correct and "sun", "sand", and "beach" are distractors, and let the student pick at most three.
157. Create a token highlight question asking "Highlight the sentence's subject and verb." with the passage "The energetic puppy barked loudly at the mail carrier." where "puppy" and "barked" are correct and "energetic", "loudly", and "carrier" are distractors.
158. Create a token highlight question asking "Click each time the word 'run' appears." with the passage "I run to school, then run back, and run again at night." where every "run" is correct and "school" and "night" are distractors.
159. Create a token highlight question asking "Highlight the sentence that states an opinion." with the passage "The sky is blue. I think blue is the most beautiful color. Water boils at 100 degrees." where the sentence "I think blue is the most beautiful color." is correct and the sentences "The sky is blue." and "Water boils at 100 degrees." are distractors.
160. Create a token highlight question asking "Click the topic sentence." with the passage "Recycling helps the environment in many ways. It reduces the amount of trash sent to landfills. It also saves energy and raw materials." where the sentence "Recycling helps the environment in many ways." is correct and the other two sentences are distractors.
161. Create a token highlight question asking "Highlight every sentence written in the past tense." with the passage "The team practices every morning. They won the championship last spring. The coach praised their effort." where the sentences "They won the championship last spring." and "The coach praised their effort." are correct and "The team practices every morning." is a distractor, and let the student pick at most two.
162. Create a token highlight question asking "Highlight the paragraph that summarizes the passage." with a passage of three paragraphs: "Dogs are loyal animals. They have lived alongside humans for thousands of years.", "Cats are independent pets. They groom themselves and hunt small prey." and "In short, both dogs and cats make wonderful companions for different reasons.", where the paragraph "In short, both dogs and cats make wonderful companions for different reasons." is correct and the first two paragraphs are distractors.
163. Create a token highlight question asking "Click the paragraph that describes the problem." with a passage of three paragraphs: "Our town's library closes at five o'clock every day. Many students finish school and arrive only after it has shut.", "One solution is to keep the library open until eight in the evening. Volunteers could staff the extra hours." and "With longer hours, more students would have a quiet place to study.", where the first paragraph is correct and the other two paragraphs are distractors.
164. Create a token highlight question asking "Highlight each paragraph that gives a reason to exercise." with a passage of three paragraphs: "Regular exercise strengthens the heart and improves circulation.", "Some people prefer to exercise in the morning, while others prefer the evening." and "Exercise also lifts your mood by releasing endorphins.", where the paragraphs "Regular exercise strengthens the heart and improves circulation." and "Exercise also lifts your mood by releasing endorphins." are correct and the middle paragraph is a distractor.

## Category 17: Partial Credit (165–172)

These items ask for partial credit, which sets Learnosity's `partialMatch`
scoring type — the learner earns a fraction of the point per correct response
instead of needing every response right. It applies only to types with more than
one scorable response, and on `mcq` it requires multiple responses to be allowed.

165. Create a multiple choice question asking "Select all the prime numbers." with options "2", "4", "7", "9" where 2 and 7 are correct, allowing multiple responses, and give partial credit for each correct selection.
166. Create a multiple choice question asking "Which of these are mammals?" with options "Dolphin", "Shark", "Bat", "Eagle" where Dolphin and Bat are correct, allowing multiple responses, scoring each correct answer separately.
167. Create a choice matrix question asking "Mark each statement true or false." with rows "Water boils at 100°C", "The sun orbits the Earth", "Sound travels faster in water than in air" and columns "True" and "False" where the answers are True, False, True, awarding partial credit per row.
168. Create a cloze text question with the template "The capital of France is {{response}} and the capital of Japan is {{response}}." where the answers are "Paris" and "Tokyo", giving partial credit for each blank filled correctly.
169. Create a cloze dropdown question asking students to complete "A {{response}} has {{response}} sides." with dropdown choices "triangle/square" and "three/four" where the answers are "triangle" and "three", with partial credit per blank.
170. Create an order list question asking "Put these events in chronological order." with the items "Declaration of Independence", "Civil War", "World War I", "Moon landing" in that correct order, with partial credit.
171. Create a classification question asking "Sort these animals by class." with categories "Mammals" and "Reptiles" and items "dog", "snake", "cat", "lizard", giving partial credit per correctly placed item.
172. Create a token highlight question asking "Highlight the verbs." with the passage "The cat runs then jumps high." where "runs" and "jumps" are correct and "cat" and "high" are distractors, scoring each correct token separately.

## Category 18: Several Accepted Math Answers (173–178)

A math response is compared as an *expression*, so notation never needs
enumerating — under any method `1/2`, `1 / 2`, and `\frac{1}{2}` are one answer.
Naming which answers count describes an explicit set instead, which no
equivalence method produces: `equivSymbolic` on `1/2` would also accept `4/8`.
These requests list the accepted expressions per blank; the first becomes the
Learnosity `valid_response` and the rest become `alt_responses`.

173. Create a cloze formula question asking "Simplify 4/8 to lowest terms: {{response}}" that accepts "1/2", "0.5", or "2/4" as correct, but not "4/8", using equivLiteral method.
174. Create a cloze formula question asking "What fraction of the circle is shaded? {{response}}" that accepts "3/4" or "0.75" using equivLiteral method.
175. Create a cloze formula question asking "Write the slope of the line: {{response}}" that accepts "-2" or "-2/1" using equivLiteral method.
176. Create a cloze formula question asking "Factor completely: x² - 4 = {{response}}" that accepts "(x-2)(x+2)" or "(x+2)(x-2)" using equivLiteral method.
177. Create a cloze formula question with two blanks asking "Give the value of x and its decimal form: x = {{response}}, or {{response}} as a decimal" where the first blank accepts "1/4" or "2/8" and the second accepts "0.25", using equivLiteral method.
178. Create a cloze formula question asking "Give a fraction equivalent to 0.5: {{response}}" that accepts "1/2", "2/4", or "3/6" using equivLiteral method.

## Category 19: Custom Spreadsheet Questions — Multiple Sheets (179–180)

These items embed a multi-sheet L0179 workbook in a `custom` question, so the
student moves between named tabs in the sheet menu while answering.

179. Create a custom spreadsheet question with the stem "Use the Data tab to complete the Answers tab." Embed an L0179 workbook with two sheets: a tab named Data holding five labelled monthly sales figures, and a tab named Answers with two assessed blank cells expecting the total and the average of those figures.
180. Create a custom spreadsheet question backed by a three-tab L0179 workbook with tabs named Q1, Q2 and Q3, each holding one assessed cell worth 2 points expecting the quarter totals 4200, 5100 and 6300 respectively, with the stem "Enter each quarter's total on its own tab."

## Category 20: Custom Concept Web Questions (L0183 Embedded) (181–186)

These items emit a `custom` Learnosity question with `lang "0183"`, reading the
concept web from the upstream pipeline task with `model data use "0183"`. The
embedded L0183 web scores each blank with partial credit through its own
`scorer.js` — `valid-response` is not used.

181. Create a custom concept web question that embeds an L0183 web about the parts of a cell, with the stem "Drag each part onto the web." Read the web from the upstream pipeline task.
182. Create a Learnosity question embedding an L0183 food chain web where students label each arrow, with the stem "Label how each organism is connected."
183. Create a custom concept web question with the stem "Complete the water cycle." The embedded L0183 web has four blank stages around "Water cycle" and one wrong answer in the word bank.
184. Create an items assessment with two questions. First, a custom L0183 concept web about the three branches of government with the stem "Place each branch." Second, a multiple choice question asking which branch interprets laws, with the answer Judicial.
185. Create a custom concept web question backed by L0183 with the stem "Fill in the inputs and outputs of photosynthesis." Tag the item with difficulty medium and DOK 2.
186. Create a custom concept web question that reads its web from the upstream L0183 task, with the stem "Use the web to show how the planets relate to the Sun," and save it to the item bank.
