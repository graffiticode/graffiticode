<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# L0182 RAG Training Examples

82 example prompts for training a RAG model on L0182, the survey record — covering taking a
survey of either style, putting the chosen options of a ranked-choice survey in priority order,
contributing a write-in, answering within the bounds a survey sets, and rating the items of a
rating survey on their scales — Likert agreement, satisfaction, frequency and importance grids,
NPS, stars and semantic differentials — with opt-outs and comments.

**Every example starts by OPENING a survey, and most then take it in a second turn.** Those are
two distinct requests against the same item, and they are written here as `Turn 1` and `Turn 2`:

- **Turn 1 creates the item.** The program names the survey and the session — nothing else —
  and compiles to the survey the taker was given: its options or its items and their scales, its
  title, its instructions and its bounds, along with which version was drawn. There is no response yet.
- **Turn 2 edits that same item**, adding `response [...]` to the program Turn 1 produced. The
  survey is not written again and the options or items are not restated: the program keeps its `id` and its
  `session-id`, which is what brings back the version this taker was actually shown.

**Turn 2 is short because Turn 1 already answered the questions it would otherwise have to ask.**
Whoever writes the response has the compiled record of Turn 1 in front of them — the options in
their own words, how many may be chosen, whether none is allowed — so "take the survey" is a
complete request. A Turn 2 that recites the set is restating what it can already see, and a Turn 2
that recites the bounds is quoting the survey back to itself. What Turn 2 adds is only what the
record cannot supply: whose answer this is, what it is optimising for, whether an option of one's own
comes with it, and — when the person really is dictating their own picks — which options those are.

A prompt with only a Turn 1 is complete as it stands — a survey awaiting an answer is a real
thing to ask for. A prompt with both is two turns, never one, and Turn 2 assumes the item Turn 1
made.

**A survey cannot be created here.** Its options, items, scales, wording and bounds belong to the
survey itself,
and no word writes them — so "take the team-retro survey" means take the one that exists, and
there is no prompt anywhere below that invents a set of options.

**Most prompts leave the choosing to whoever answers.** A request that dictates every pick
teaches transcription; a request that says "take it" and lets the responder weigh the options is the
one that actually exercises judgement, which is the interesting part of answering. Both appear
here, because a person recording their own answer really does dictate it — but the deciding kind
dominates, and the contributed option is almost always left to the responder to think of.

Each turn is written in the requester's own voice. Prompts describe WHAT to record, never how to
write it: someone asks for an answer, not for a `response [...]`.

| `id`                    | Style         | The survey                                                    |
| :---------------------- | :------------ | :------------------------------------------------------------ |
| `civic-priorities`      | ranked-choice | civic priorities — twelve versions, one drawn per taking. 1–5 |
| `team-retro`            | ranked-choice | eight engineering-team retro options. 1–3                     |
| `city-budget`           | ranked-choice | ten neighbourhood projects a council could fund. 0–2          |
| `product-features`      | ranked-choice | nine features customers have asked for. 2–4                   |
| `school`                | ranked-choice | seven school improvements. 0–3                                |
| `course-feedback`       | rating        | agreement grid with an opt-out, an ease line, NPS; a comment  |
| `customer-satisfaction` | rating        | satisfaction questions, a star rating, NPS                    |
| `app-usability`         | rating        | six 1–7 semantic-differential lines                           |
| `workplace-pulse`       | rating        | three versions — frequency, importance, effect                |

The bounds are the survey's own and no prompt sets them. Every option named below is one its survey
actually contains, and a selection naming an option the set does not hold is a compile error.
Prompts that name options or ratings outright use a survey with a single version, because
`civic-priorities` draws one of twelve and `workplace-pulse` one of three, and only the taker can
see which.

## Category 1: Taking a Survey (1–6)

1. **Turn 1** — Take the `team-retro` survey.
2. **Turn 1** — Give me the `civic-priorities` survey to answer.
3. **Turn 1** — Set up `city-budget` so I can record what I picked.
4. **Turn 1** — Open the `school` survey — I want to see what is on the list before I decide.
5. **Turn 1** — Take `product-features`, and tell me how many I am allowed to choose.
6. **Turn 1** — Take version 7 of `civic-priorities` rather than whichever one it would give me.

## Category 2: Answering With Your Own Judgement (7–16)

7. **Turn 1** — Take the `team-retro` survey.
   **Turn 2** — Take it.
8. **Turn 1** — Take the city budget survey `city-budget`.
   **Turn 2** — Take it, funding what you would fund first.
9. **Turn 1** — Take the `school` survey.
   **Turn 2** — Take it, choosing what would do the most good for students.
10. **Turn 1** — Take the feature survey `product-features`.
    **Turn 2** — Take it, choosing what you would build first.
11. **Turn 1** — Take `team-retro`.
    **Turn 2** — Take it, recording only the single option that matters most.
12. **Turn 1** — Take `product-features`.
    **Turn 2** — Take it as an engineer who has to maintain the thing.
13. **Turn 1** — Take `school`.
    **Turn 2** — Take it the way a teacher would.
14. **Turn 1** — Take the retro survey `team-retro`.
    **Turn 2** — Take it, choosing the options that address causes rather than symptoms.
15. **Turn 1** — Take `city-budget`.
    **Turn 2** — Take it as if the budget only stretched to one of them.
16. **Turn 1** — Take `city-budget`.
    **Turn 2** — Take it for me: I pick the shade trees along the bus routes, and extending library hours into the evening.

## Category 3: Ranking What You Chose (17–24)

17. **Turn 1** — Take `team-retro`.
    **Turn 2** — Take it, with the one you would do this week first.
18. **Turn 1** — Take `city-budget`.
    **Turn 2** — Take it, most urgent first.
19. **Turn 1** — Take the feature survey `product-features`.
    **Turn 2** — Take it, ordered by how many users each would help.
20. **Turn 1** — Take `school`.
    **Turn 2** — Take it, ranked by what a student would notice soonest.
21. **Turn 1** — Take `team-retro`.
    **Turn 2** — Take it, ranked by how much time each would save the team.
22. **Turn 1** — Take `city-budget`.
    **Turn 2** — Take it, and put the cheaper one last.
23. **Turn 1** — Take the survey `team-retro`.
    **Turn 2** — Take it for me: cutting the build time in half first, then the flaky tests, then smaller pull requests.
24. **Turn 1** — Take `product-features`.
    **Turn 2** — Take it for me, in this order: search across everything, not just the current page; then export to CSV and PDF; then a dark theme that respects the system setting.

## Category 4: A Write-In of Your Own (25–34)

25. **Turn 1** — Take the retro survey `team-retro`.
    **Turn 2** — Take it, and add an option of your own that the list is missing.
26. **Turn 1** — Take the city budget survey `city-budget`.
    **Turn 2** — Take it, and contribute something the council has clearly not thought of.
27. **Turn 1** — Take `school`.
    **Turn 2** — Take it, and add one option of your own that no one on the list proposed.
28. **Turn 1** — Take the feature survey `product-features`.
    **Turn 2** — Take it, plus a feature you would want that is not offered.
29. **Turn 1** — Take `team-retro`.
    **Turn 2** — Take it, and add your own option about how the team works rather than what it builds.
30. **Turn 1** — Take `city-budget`.
    **Turn 2** — Take it, with a contribution that would cost almost nothing.
31. **Turn 1** — Take `product-features`.
    **Turn 2** — Take it, and add an option aimed at people who use the product every day.
32. **Turn 1** — Take the school survey `school`.
    **Turn 2** — Take it, and add one option of your own about what happens outside the classroom.
33. **Turn 1** — Take `product-features`.
    **Turn 2** — Take it for me: offline mode and undo, plus an option of my own — let me pin the three views I actually use.
34. **Turn 1** — Take `school`.
    **Turn 2** — Take it for me: air conditioning in every classroom, plus one of mine — a hot lunch children will actually eat.

## Category 5: A Write-In and Nothing Chosen (35–40)

35. **Turn 1** — Take the `city-budget` survey.
    **Turn 2** — None of these is what the neighbourhood needs. Take it choosing nothing, and record my own option instead.
36. **Turn 1** — Take `school`.
    **Turn 2** — Take it without picking anything from the list — just the one thing you would do instead.
37. **Turn 1** — Take `city-budget`.
    **Turn 2** — Take it, deciding none of it is the right priority, and record only your own option.
38. **Turn 1** — Take the school survey `school`.
    **Turn 2** — Take it with no selection and a single contribution.
39. **Turn 1** — Take `school`.
    **Turn 2** — Take it for me, without picking from the list. Just my option: pay teaching assistants a living wage.
40. **Turn 1** — Take `city-budget`.
    **Turn 2** — Take it for me: nothing from the list, and one option of mine — a late bus home on weekends.

## Category 6: Answering Within the Survey's Bounds (41–46)

41. **Turn 1** — Take `team-retro`.
    **Turn 2** — Take it, choosing as many as it allows.
42. **Turn 1** — Take `city-budget`.
    **Turn 2** — Take it, using every choice it gives me.
43. **Turn 1** — Take `product-features`.
    **Turn 2** — Take it with the fewest choices it will accept.
44. **Turn 1** — Take `school`.
    **Turn 2** — Take it, picking the one that would help most and leaving it there.
45. **Turn 1** — Take `city-budget`.
    **Turn 2** — Take it recording whatever you actually think, even if that is a single option plus one of your own.
46. **Turn 1** — Take `school`.
    **Turn 2** — Take it for me: free breakfast for every student, smaller class sizes in the early grades, and air conditioning in every classroom.

## Category 7: Answering From a Particular Point of View (47–50)

47. **Turn 1** — Take the school survey `school`.
    **Turn 2** — Take it the way a parent of a five-year-old would, and add the option they would add.
48. **Turn 1** — Take `city-budget`.
    **Turn 2** — Take it as someone who does not own a car.
49. **Turn 1** — Take the retro survey `team-retro`.
    **Turn 2** — Take it as the person who carries the pager, and contribute an option from that experience.
50. **Turn 1** — Take `product-features`.
    **Turn 2** — Take it as a customer who has been asking for the same thing for two years.

## Category 8: Taking a Rating Survey (51–54)

51. **Turn 1** — Take the `course-feedback` survey.
52. **Turn 1** — Open `customer-satisfaction` so I can see what it asks before I answer.
53. **Turn 1** — Give me the `workplace-pulse` survey.
54. **Turn 1** — Take `app-usability`, and tell me what the two ends of each line mean.

## Category 9: Rating With Your Own Judgement (55–60)

55. **Turn 1** — Take `course-feedback`.
    **Turn 2** — Take it as a student who enjoyed the course but found the labs rushed.
56. **Turn 1** — Take `customer-satisfaction`.
    **Turn 2** — Take it as a shopper who found everything quickly but queued for twenty minutes to pay.
57. **Turn 1** — Take `app-usability`.
    **Turn 2** — Take it as someone opening the app for the first time.
58. **Turn 1** — Take `workplace-pulse`.
    **Turn 2** — Answer it honestly for someone on a team that has just shipped a large release.
59. **Turn 1** — Take `course-feedback`.
    **Turn 2** — Take it for me: agree with everything except the pace, which I disagree with, and the portal was easy enough — a 5.
60. **Turn 1** — Take `customer-satisfaction`.
    **Turn 2** — Take it for me: satisfied with everything, four stars for the visit, and an 8 for recommending you.

## Category 10: Numeric Scales, NPS and Stars (61–64)

61. **Turn 1** — Take `customer-satisfaction`.
    **Turn 2** — Take it, and give the visit overall three stars.
62. **Turn 1** — Take `course-feedback`.
    **Turn 2** — Take it, and say I would recommend it ten out of ten.
63. **Turn 1** — Take `app-usability`.
    **Turn 2** — Put the app right at the clear end for finding my way around, and halfway for everything else.
64. **Turn 1** — Take `course-feedback`.
    **Turn 2** — Take it, but leave out the recommendation question — I would rather not answer it.

## Category 11: Opting Out and Commenting (65–70)

65. **Turn 1** — Take `course-feedback`.
    **Turn 2** — Take it, and mark the labs not applicable — I never went to one.
66. **Turn 1** — Take `workplace-pulse`.
    **Turn 2** — Take it, and prefer not to say wherever the survey lets me.
67. **Turn 1** — Take `course-feedback`.
    **Turn 2** — Take it, and add a comment asking for more worked examples.
68. **Turn 1** — Take `workplace-pulse`.
    **Turn 2** — Take it, and if it asks for a comment, say what would make the biggest difference.
69. **Turn 1** — Take `course-feedback`.
    **Turn 2** — Take it as a student who missed half the lectures, and say so in the comment.
70. **Turn 1** — Take `customer-satisfaction`.
    **Turn 2** — Take it as a first-time visitor who could not find anything they came for.

## Category 12: Likert Scales (71–82)

A Likert grid is a run of statements sharing one labelled scale. People answer it in the scale's
own words ("agree"), in looser words ("somewhere in the middle", "the strongest yes there is"),
or as a number ("a 4 out of 5") — and a number on a Likert scale is its value, so a 4 on a
five-point agreement scale is "Agree", not the fifth label. Prompts that dictate answers use
`course-feedback` and `customer-satisfaction`, which have one version each; `workplace-pulse`
draws its scale — frequency, importance or effect — so prompts for it leave the answers to the
responder.

71. **Turn 1** — Take `course-feedback`.
    **Turn 2** — Strongly agree with every statement, and the portal was very easy — it was the best course I have taken.
72. **Turn 1** — Take `course-feedback`.
    **Turn 2** — Take it for me: the goals and the materials get a 4 out of 5, the pace a 2, feedback a 3, the labs a 5, and the portal a 6.
73. **Turn 1** — Take `course-feedback`.
    **Turn 2** — Answer it right down the middle — neither agree nor disagree on every statement, and halfway on the portal.
74. **Turn 1** — Take `course-feedback`.
    **Turn 2** — Take it as a student who disagreed with most of it but thought the materials were clear.
75. **Turn 1** — Take `course-feedback`.
    **Turn 2** — Take it for me: I strongly disagree that the pace was right, I agree about everything else, and the portal was very easy.
76. **Turn 1** — Take `customer-satisfaction`.
    **Turn 2** — Take it for me: very satisfied with the staff, dissatisfied with the wait, neutral about the rest, three stars overall, and a 6 for recommending you.
77. **Turn 1** — Take `customer-satisfaction`.
    **Turn 2** — Take it as someone who thought the prices were far too high but liked everything else.
78. **Turn 1** — Take `customer-satisfaction`.
    **Turn 2** — Rate every question a 2 out of 5 — it was a disappointing visit — give it two stars, and a 3 for recommending you.
79. **Turn 1** — Take `workplace-pulse`.
    **Turn 2** — Answer it as someone who has had a hard month: lean towards the negative end wherever the scale has one.
80. **Turn 1** — Take `workplace-pulse`.
    **Turn 2** — Answer it as a new starter in their first month, using whatever scale it gives you.
81. **Turn 1** — Take `workplace-pulse`.
    **Turn 2** — Take it, and use the top of the scale for anything about my manager and the middle for everything else.
82. **Turn 1** — Take `course-feedback`.
    **Turn 2** — Take it as a part-time student who never saw the feedback or the labs: not applicable for those two, agree with the rest, and a 5 for the portal.
