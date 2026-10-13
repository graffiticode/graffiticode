<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0181 RAG Training Examples

90 example prompts for training a RAG model on L0181, the flashcard language — covering
vocabulary decks, definitions, formula drills, dates and people, titles and instructions,
image cards, light and dark decks, asymmetric card content, and longer drill decks.
Image prompts carry real URLs, because a deck built on an invented one renders broken.

Each numbered line is a prompt in the author's own voice. Prompts describe WHAT to build,
never how to write it: an author asks for a deck of cards, not for a `cards [...]` program.
Every prompt here is in scope — matching and memory games belong to L0159 and are deliberately
absent, so nothing in this file trains the model to reach for a mode L0181 does not have.

## Category 1: Basic Vocabulary (1–12)

1. Make a flashcard deck with five Spanish words: hola/hello, adiós/goodbye, por favor/please, gracias/thank you, agua/water.
2. Flashcards for French colours — rouge, bleu, vert, jaune, noir — with the English on the back.
3. Create a deck of ten German nouns with their English meanings.
4. Italian food words: pane, latte, formaggio, mela, pesce. English on the back.
5. Make flashcards for the days of the week in Japanese, romanized, with English translations.
6. A deck of common Mandarin greetings with pinyin on the front and English on the back.
7. Flashcards for twelve Latin roots and what they mean.
8. Portuguese numbers one through ten, with the numeral on the back.
9. Create a deck of English-to-Russian animal words: dog, cat, bird, horse, fish.
10. Make flashcards for Spanish verbs in the infinitive — hablar, comer, vivir, tener, hacer — with English meanings.
11. A deck of Korean colour words with the English on the reverse.
12. Flashcards for fifteen SAT vocabulary words with short definitions.

## Category 2: Definitions and Terminology (13–24)

13. Biology vocab flashcards: photosynthesis, mitosis, osmosis and respiration, each with its definition on the back.
14. Make a deck of chemistry terms — element, compound, mixture, solution, solvent — with definitions.
15. Flashcards for the parts of a plant cell and what each one does.
16. Create a deck of literary devices: metaphor, simile, alliteration, personification, hyperbole, with definitions.
17. Economics terms for an intro course — supply, demand, inflation, recession, GDP — defined on the back.
18. A deck of geometry vocabulary: acute, obtuse, congruent, perpendicular, parallel.
19. Flashcards for the layers of the atmosphere with a one-line description of each.
20. Make a deck of music theory terms: tempo, dynamics, timbre, harmony, cadence.
21. Anatomy flashcards for the major bones of the arm and hand.
22. Create a deck of psychology terms from a first-year syllabus with short definitions.
23. Flashcards for common programming concepts — variable, function, loop, array, recursion.
24. A deck of weather terms for a fifth-grade class: precipitation, humidity, front, air pressure, condensation.

## Category 3: Math and Formulas (25–36)

25. Flashcards for LaTeX-rendered algebra identities: $x^2 + 2x + 1$ / $(x+1)^2$; $a^2 - b^2$ / $(a+b)(a-b)$.
26. Make a deck of trig identities with the equivalent expression on the back, rendered as math.
27. Flashcards for the derivative rules: power rule, product rule, quotient rule, chain rule.
28. A deck of area and volume formulas — circle, triangle, sphere, cylinder — with the formula on the back.
29. Create flashcards for the first ten perfect squares, with the square on the back.
30. Times tables flashcards for the sevens, 7×1 through 7×12, with the product on the back.
31. Flashcards showing $\sin^2 x + \cos^2 x$ on the front and $1$ on the back, plus four more identities like it.
32. Make a deck of unit conversions: metres to feet, kilograms to pounds, litres to gallons, Celsius to Fahrenheit.
33. A deck of common logarithm and exponent rules, written as math.
34. Flashcards for the quadratic formula and the discriminant, with the formula on the reverse.
35. Fraction-to-decimal flashcards: $\frac{1}{2}$, $\frac{1}{4}$, $\frac{3}{4}$, $\frac{1}{5}$, $\frac{2}{5}$.
36. Create a deck of physics equations for motion, with the quantity on the front and the equation on the back.

## Category 4: Dates, Events and People (37–46)

37. Flashcards for ten key dates in American history, with the event on the back.
38. A deck of world capitals: put the country on the front and its capital on the back.
39. Make flashcards matching US states to their capitals — California/Sacramento, Texas/Austin, Florida/Tallahassee, New York/Albany, Illinois/Springfield.
40. Flashcards for the first ten US presidents in order, with the years they served.
41. Create a deck of famous novels with their authors on the back.
42. A deck of chemical elements: symbol on the front, element name on the back.
43. Flashcards for the planets in order from the Sun, with one fact about each.
44. Make a deck of ancient civilizations and the region each one occupied.
45. Flashcards for the major battles of the Second World War with their years.
46. A deck of composers and the period they wrote in.

## Category 5: Titles and Instructions (47–56)

47. Make a flashcard deck titled "Spanish Vocab" with five pairs: hola/hello, adiós/goodbye, por favor/please, gracias/thank you, agua/water.
48. Biology vocab flashcards with the instruction "Flip each card to check yourself."
49. A deck called "Times Tables" with the sevens, and the prompt "Say the answer out loud before you flip."
50. Create flashcards titled "Cell Biology" covering mitosis, meiosis, osmosis and diffusion.
51. Make a deck named "State Capitals" with ten states, and tell the student to name the capital before revealing.
52. Flashcards titled "Algebra Identities" with the instruction "Rewrite each expression, then check."
53. A deck called "French Colours" instructing the learner to say each word aloud first.
54. Create a deck titled "Chemistry Symbols" with the instruction "Name the element, then flip."
55. Make flashcards headed "Weather Words" for a fifth-grade class, with a short line telling them what to do.
56. A deck titled "Presidents in Order" with the instruction "Try to recall the years before flipping."

## Category 6: Image Cards (57–64)

An image card is a card whose side is a URL, so these prompts carry the URLs. That is the
point of the category: the deck is only as good as the links in it, and a link the author did
not supply is a link that 404s. Prompt 60 is the other half of the lesson — asked for pictures
with no URLs to hand, the right answer is text, not a guess.

The hosts vary on purpose, and prompt 58 mixes two in one deck. There is no list of acceptable
image domains: a URL the author wrote is used as the author wrote it, and a host you do not
recognise is not a host that is down.

57. Flashcards titled "Flags" with the country name on the back and the flag on the front, from https://flagcdn.com/w320/jp.png for Japan, https://flagcdn.com/w320/br.png for Brazil, https://flagcdn.com/w320/eg.png for Egypt and https://flagcdn.com/w320/ca.png for Canada.
58. Make a deck of animal photos with the animal's name on the back: https://images.pexels.com/photos/45201/kitty-cat-kitten-pet-45201.jpeg?auto=compress&w=320 is a cat, https://upload.wikimedia.org/wikipedia/commons/thumb/3/37/African_Bush_Elephant.jpg/330px-African_Bush_Elephant.jpg is an elephant.
59. A deck of musical instrument photos with the instrument's name on the back — https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Violin_VL100.png/330px-Violin_VL100.png and https://upload.wikimedia.org/wikipedia/commons/thumb/9/9d/Trumpet_1.jpg/330px-Trumpet_1.jpg.
60. A deck where the front is a picture of a leaf and the back names the tree. I haven't collected the photos yet, so put the leaf description on the front for now and I'll swap the images in later.
61. Create flashcards for art history with the painting on the front and the artist on the back: https://upload.wikimedia.org/wikipedia/commons/thumb/e/ec/Mona_Lisa%2C_by_Leonardo_da_Vinci%2C_from_C2RMF_retouched.jpg/330px-Mona_Lisa%2C_by_Leonardo_da_Vinci%2C_from_C2RMF_retouched.jpg, and https://upload.wikimedia.org/wikipedia/commons/thumb/e/ea/Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg/330px-Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg.
62. Flashcards with a diagram of a cell organelle on the front and its name on the back, starting with https://upload.wikimedia.org/wikipedia/commons/thumb/3/3b/Animal_mitochondrion_diagram_en.svg/330px-Animal_mitochondrion_diagram_en.svg.png for the mitochondrion.
63. A deck of road sign images with what each sign means on the reverse — https://upload.wikimedia.org/wikipedia/commons/thumb/c/c9/Stop_sign.jpg/330px-Stop_sign.jpg means come to a full stop.
64. Make flashcards where the front is the country name and the back is its flag image, using https://flagcdn.com/w320/de.png for Germany and https://flagcdn.com/w320/fr.png for France.

## Category 7: Light and Dark (65–70)

65. A dark-themed deck of state capitals: California/Sacramento, Texas/Austin, Florida/Tallahassee, New York/Albany, Illinois/Springfield.
66. Make a flashcard deck for chemistry symbols on a dark background.
67. Create a light-themed vocabulary deck for Spanish beginners.
68. A dark deck of algebra identities titled "Identities".
69. Flashcards for the planets, set to open in dark mode.
70. Make a light-themed deck of literary devices with definitions.

## Category 8: Longer and Asymmetric Cards (71–78)

71. Flashcards where the front is a single term and the back is a full-sentence definition, for six ecology concepts.
72. A deck of legal terms with detailed explanations on the back.
73. Make flashcards for six historical events, each with a two-sentence summary on the reverse.
74. A deck where the front asks a short question and the back gives a paragraph-length answer.
75. Flashcards for medical abbreviations with the full term spelled out on the back.
76. Create a deck of idioms with their meanings explained on the back.
77. A deck of Spanish phrases — full sentences, not single words — with English translations.
78. Flashcards for six philosophy concepts, each with a careful definition on the reverse.

## Category 9: Drill Decks (79–90)

79. A twenty-card deck of multiplication facts through the twelves.
80. Make a deck of all fifty US states with their capitals.
81. Flashcards for the complete periodic table's first thirty elements, symbol to name.
82. A large deck of a hundred common Spanish words for a semester's study.
83. Create thirty flashcards for the irregular past tense of common English verbs.
84. A deck of every bone in the human body grouped for a first anatomy exam.
85. Flashcards for the two hundred most common Japanese kanji, with meanings.
86. Make a deck of all the trigonometric values for the unit circle.
87. A deck of forty musical terms for a theory exam.
88. Flashcards for every US president in order, with their years in office.
89. A deck of twenty-five SAT vocabulary words with definitions and the instruction to try each one twice.
90. Create a fifty-card deck of French verb conjugations in the present tense.
