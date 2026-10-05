<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0175 RAG Training Examples

_Revised: 2026-08-28_

Natural-language prompts for training a RAG model on L0175 — composing 5th-grade ELA
assessment items (Smarter Balanced · Grade 5 · Claim 1). They are written the way a fifth-grade
teacher would ask for an item, and they stay away from specific passage content so the model
learns the task shape, not a topic. Each program declares its `target` first.

This is a covering set: every task model of every target appears at least once, and across the
task models each target's dimensions are each covered at least once. Standard is a function of
dimension, so covering dimensions covers the standards too — except in Word Meanings, where the
one dimension spans four L-4 strategies (context, roots and affixes, dictionary, word
relationships), which are covered instead. The dimension is carried by the skill the prompt
describes, not a tag.

Item type maps to a task-model number within each target, and the numbers collide across targets —
a short-text item is tm3 in T4/T11 but tm5 in T2/T9; a hot-text item is tm2 in T4/T11, tm4 in T2/T9, and
tm3 in T1/T8/T10 — so each prompt names its target and task model.

## Target 4 (`c1-t4`) — Reasoning & Evidence, literary

Students read a story and reason about it — a character's feelings or motives, how two characters
relate, the setting, an event, the narrator's point of view or feelings, the theme, or the topic —
and back it up with evidence from the text.

1. c1-t4 tm1 — Make a two-part item for a story: in Part A students figure out what the main character is feeling or why they act the way they do, and in Part B they pick the line that best backs it up.
2. c1-t4 tm1 — Make a two-part item for a story about an important event: in Part A students figure out why it happens or how a character reacts to it, and in Part B they pick the line that best supports their answer.
3. c1-t4 tm1 — Make a two-part item for a story about two characters: in Part A students figure out how the two feel about each other, and in Part B they pick the line that best shows it.
4. c1-t4 tm2 — Make an item for a story where students first click the sentence that best tells the narrator's point of view, then click the sentence or two that support it.
5. c1-t4 tm2 — Make an item for a story where students first click the sentence that best shows how the setting shapes the mood, then click the sentences that support it.
6. c1-t4 tm2 — Make an item for a story where students first click the sentence that best shows how the narrator feels about another character, then click the sentences that support it.
7. c1-t4 tm3 — Make a written-response item for a story: ask students what the theme is and have them explain it using details from the text.
8. c1-t4 tm3 — Make a written-response item for a story: ask students what the story is mostly about and have them support it with details from the text.

## Target 11 (`c1-t11`) — Reasoning & Evidence, informational

The same kind of reasoning as Target 4, but for an informational passage — how ideas or events
connect, how the author uses information to support a point, the author's point of view or
purpose, or the author's opinion — always supported with evidence.

9. c1-t11 tm1 — Make a two-part item for an informational passage: in Part A students figure out how two ideas or events are connected, and in Part B they choose the detail that best supports it.
10. c1-t11 tm1 — Make a two-part item for an informational passage: in Part A students figure out the author's point of view, and in Part B they choose the detail that best supports it.
11. c1-t11 tm2 — Make an item for an informational passage where students click the sentence that best states the author's purpose, then click the sentences that support it.
12. c1-t11 tm2 — Make an item for an informational passage where students click the sentence that best shows how the author uses facts to support a point, then click the sentences that support it.
13. c1-t11 tm3 — Make a written-response item for an informational passage: ask students what conclusion they can draw about the author's opinion and have them back it up with evidence from the text.

## Target 2 (`c1-t2`) — Central Ideas, literary

Students find the theme of a story or poem, the key details and events that build it, or summarize
part of it. The theme is a lesson or message, not a plot event. Wrong answers are usually true but
not central. Summaries here always cover a section or a key event, never the whole story.

14. c1-t2 tm1 — Make an item for a story that asks which sentence best tells the theme.
15. c1-t2 tm2 — Make an item for a story where students choose the two sentences that belong in a summary of it.
16. c1-t2 tm3 — Make a two-part item for a story: in Part A students pick the theme, and in Part B they choose the sentence that best supports it.
17. c1-t2 tm4 — Make an item for a story where students click the one or two sentences that best show the theme.
18. c1-t2 tm5 — Make a written-response item for a story: ask students to summarize what happens after a key moment, using details from the text.

## Target 9 (`c1-t9`) — Central Ideas, informational

Students find the main idea of an informational passage, the key details that build it, or a
summary. Wrong answers are usually true but not central — a small supporting detail, an
overgeneralization, or a misread. T2 is its literary twin; the two are the only targets that use all five task models.

19. c1-t9 tm1 — Make an item for an informational passage that asks which sentence best states the main idea.
20. c1-t9 tm1 — Make an item that shows students a short summary of an informational passage with one key detail left out and asks which detail is missing.
21. c1-t9 tm2 — Make an item for an informational passage where students choose the two sentences that belong in a summary.
22. c1-t9 tm3 — Make a two-part item for an informational passage: in Part A students pick the main idea, and in Part B they choose the key detail that best supports it.
23. c1-t9 tm4 — Make an item for an informational passage where students click the sentence or two that best show the main idea.
24. c1-t9 tm5 — Make a written-response item for an informational passage: ask students to figure out the main idea and explain it using key details from the text.

## Target 1 (`c1-t1`) — Key Details, literary

The same job as Target 8, but on a story instead of an article. Give students a conclusion about
the story and have them find the line or lines that support it. Wrong answers are other lines that
tell about the story without backing up that particular conclusion.

25. c1-t1 tm1 — Give students a conclusion about a story and make an item asking which line from the story best supports it.
26. c1-t1 tm2 — Give students a conclusion about a story and make an item asking which two lines best support it.
27. c1-t1 tm3 — Give students a conclusion about a story and make an item where they click the sentence or two that support it.

## Target 8 (`c1-t8`) — Key Details, informational

The conclusion is handed to the students; their job is to find the evidence. Give them an
inference about an informational passage and have them pick the detail(s) that support it. The
wrong answers are other details that don't actually support it.

28. c1-t8 tm1 — Give students a conclusion about an informational passage and make an item asking which detail from the passage best supports it.
29. c1-t8 tm2 — Give students a conclusion about an informational passage and make an item asking which two details best support it.
30. c1-t8 tm3 — Give students a conclusion about an informational passage and make an item where they click the sentence or two that support it.

## Target 10 (`c1-t10`) — Word Meanings, informational

Students figure out what a word or phrase means the way it is used in an informational passage.
The answer choices are meanings; wrong ones come from another meaning of the word, a misread, or
the wrong context. Items lean on context, but can also use a word's roots and affixes, a dictionary
entry, or word relationships like synonyms and antonyms.

31. c1-t10 tm1 — Make an item that asks what a key word most likely means the way it is used in an informational passage.
32. c1-t10 tm1 — Make an item that asks what a word means by using its Greek or Latin root or prefix.
33. c1-t10 tm2 — Make an item that asks students to choose the two answers that best give the meaning of a key word as it is used in an informational passage.
34. c1-t10 tm2 — Make an item that asks students to choose the two words that mean about the same as a key word from the passage.
35. c1-t10 tm3 — Give students a short dictionary definition and make an item where they click the word in the paragraph that matches it.
