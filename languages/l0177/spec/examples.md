<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0177 Examples

Natural-language requests that exercise the Learnosity **Author API integration** oracle. Run these
through the generator to produce examples organically; the programs they yield are the corpus.

They are phrased the way a client actually asks — an integration to embed and how it should behave —
not as descriptions of the vocabulary. Between them they should reach every part of the surface:
all four views, the enforced question-picker restriction, editor and widget permissions, the
metadata pane, list filters and toolbars, assessment-player settings, content tags, item banks,
container and global options, and designs that arrive with holes still in them.

**Every request below names its own serving domain and author, and its item/activity reference
where the view needs one.** That is deliberate, and it is what makes these usable as corpus. The
starting template (`template.gc`) supplies nothing — it is `author-embed {}..` — so a program can
only contain what its request gave it. A prompt that names no domain yields a program with a
`domain` hole, which is CORRECT and is what §"Under-specified requests" is for; but a corpus made
only of those would never demonstrate a complete design. The values here are mocks and they vary
on purpose: an example teaches which slot a value belongs in, and repeating one literal everywhere
would instead teach the literal.

L0177 returns a developer recipe (via `get_spec`), not item content and not runnable code.

## Item editor — `item-edit`

1. How do I embed the Learnosity item editor for author u123 on lms.acme.edu, editing item algebra-item-1 from bank 100, allowing only multiple-choice and cloze questions?
2. On lms.acme.edu, let author u123 edit item algebra-item-1, but not delete widgets.
3. Embed the item editor at authoring.acme.edu for author u451, working on item speaking-1, so authors can only add written and spoken response questions.
4. Put the item editor in our LMS at lms.district.k12.us for author t-77 on item calc-limit-2, restricted to maths and graphing question types, in a 640-pixel-tall pane.
5. On studio.learnco.io, author u-4412 editing item sci-hotspot-1: authors should see an item's title and reference, and new items should get references prefixed ALG_.
6. Make the item title mandatory before an item can be saved — item editor on lms.acme.edu, author u123, item algebra-item-1.
7. Show difficulty and notes on the item and let authors edit them, but make the source read-only. Editor at content.acme.edu for author c-12, item bio-cell-4.
8. Authors on lms.acme.edu (author u123, item algebra-item-1) should be able to see an item's tags but not change them.
9. Open the item editor in preview mode by default and hide the edit/preview toggle — authoring.acme.edu, author j-77, item hist-essay-2.
10. Let authors duplicate an item, including its shared passages. Editor at items.example.org for author e-5, item rdg-passage-9.
11. Stamp every new item with Subject: Biology and Grade: 9 — item editor at bio.acme.edu, author b-31, item bio-cell-4, bank 4021.
12. Stop authors saving any item still tagged Status: locked. Editor on lms.acme.edu, author u123, item algebra-item-1.
13. Let authors work in the editor but don't persist anything when they hit save — sandbox.acme.edu, author demo-1, item scratch-1.
14. Turn off the item editor's save button entirely, our own app handles saving. app.learnco.io, author u-4412, item sci-hotspot-1.
15. Enable audio recording and dynamic content on items in our editor at media.acme.edu for author m-9, item speaking-1.
16. Embed the item editor for author j.chen@acme.edu (Jamie Chen) on authoring.acme.edu, item bank 4021, editing item alg-quad-3.

## Item browser — `item-list`

17. Embed a Learnosity item browser at studio.learnco.io for author u-4412 so authors can find and open existing items.
18. Show author u-4412 a list of only their own published items, 25 per page, on studio.learnco.io.
19. On library.acme.edu for author lib-3, the item list should show titles and references, and let authors select several items at once.
20. Give the item browser at studio.learnco.io (author u-4412) a search box and a create button, but only let people search by reference and title.
21. Each row in the item list at portal.acme.edu, author p-8, should link to our own editor page at /items/:reference/edit.
22. Only show items tagged Subject: Math in the browser at math.acme.edu for author m-88, bank 12.
23. Hide the create button in the item browser at studio.learnco.io for author u-4412 — our authors shouldn't be making new items there.

## Activity editor — `activity-edit`

24. Embed the Learnosity activity editor at build.district.k12.us for designer author-99 so instructional designers can assemble activities from item bank 42.
25. Let designer author-99 build unit-3-quiz on build.district.k12.us: search our bank, add items, and edit them in place.
26. In the activity editor at build.district.k12.us (designer author-99, activity unit-3-quiz), show the player settings and let designers set a time limit and turn on auto-save.
27. Designers on build.district.k12.us, signed in as author-99, should be able to shuffle items and show distractor rationales in the assessment player.
28. Let designers on build.district.k12.us (author-99) control whether the exit, extend and save buttons appear in the player's administration menu.
29. The activity editor at build.district.k12.us for author-99 should search both our core item bank 42 and our licensed content bank 43.
30. Limit activity item search to 25 results and only show items created by the current user — activity editor on build.district.k12.us, designer author-99.
31. Show the activity's title, description and difficulty in the editor, but don't let designers change the difficulty. build.district.k12.us, designer author-99, activity unit-3-quiz.
32. Let designers add items to an activity but not edit them — build.district.k12.us, author-99, activity unit-3-quiz.
33. Turn on custom points per item in the activity editor at build.district.k12.us for designer author-99.

## Activity browser — `activity-list`

34. Show a browsable list of our Learnosity activities at portal.example.edu for user t-5501.
35. List activities with titles, references and status, 15 per page — portal.example.edu, user t-5501, bank 315.
36. Let designers create adaptive and branching activities from the activity list at build.district.k12.us, designer author-99.
37. Only show published and unpublished activities in the list at portal.example.edu for user t-5501, not archived ones.

## Layout, chrome and global behaviour

38. Fit the item editor into a 700-pixel pane with a 60-pixel fixed footer — lms.acme.edu, author u123, item algebra-item-1.
39. Give the widget editor back and save buttons, and require validation before saving a question. authoring.acme.edu, author u451, item speaking-1.
40. Stop the browser asking authors to confirm before navigating away from the editor at lms.acme.edu (author u123, item algebra-item-1).

## Under-specified requests (the compiler should flag the holes)

These withhold values on purpose — they are the counterpart to everything above, and the programs
they yield should carry holes, not invented placeholders. Do not "fix" them by adding a domain.

41. I want to embed the Learnosity item editor.
42. Embed an item browser for our authors.
43. Set up the activity editor so our team can build quizzes, restricted to multiple choice.
44. Embed the Learnosity item editor on lms.acme.edu.

## Out of scope (should be redirected, not designed)

45. Write me a multiple-choice question about photosynthesis with four options. *(item content → L0176)*
46. Give me the Node.js code to embed the item editor. *(the recipe is language-neutral; it describes the procedure, it doesn't emit code)*
