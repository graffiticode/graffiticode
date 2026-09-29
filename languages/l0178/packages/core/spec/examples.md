<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0178 Examples

Natural-language requests that exercise the Learnosity **Data API** cookbook. Run these through
the generator to produce examples organically; the programs they yield are the corpus.

They are phrased the way a developer actually asks — data they need out of a Learnosity bank, and
what they intend to do about it — not as descriptions of the vocabulary. Between them they should
reach every part of the modelled surface: all 30 blocks, every filter, the three session time axes,
response shaping, both paging policies, and the asynchronous job shape.

**Every prompt here must yield a program worth RETRIEVING.** A RAG row is a bare prompt-and-code
pair — the compiler's warnings do not travel with it — so a program carrying a value the vocabulary
tells you not to author teaches that value with nothing to explain it. Prompts whose correct answer
is a refusal, and the two whose programs would bake in an over-maximum `limit` or a hand-authored
`next`, live in `boundary-tests.md` instead. Run those to check the boundary holds; never mark
their output.

**Every request below says HOW FAR IT READS, and names its own references, banks, users and
activities.** That is deliberate, and it is what makes these usable as corpus. The starting
template (`template.gc`) supplies nothing — it is `data-job {}..` — so a program can only contain
what its request gave it. A prompt that never says whether it wants everything or a sample yields
a program with the paging hole, which is CORRECT and is what §"Under-specified requests" is for;
but a corpus made only of those would never demonstrate a complete job. The values here are mocks
and they vary on purpose: an example teaches which slot a value belongs in, and repeating one
literal everywhere would instead teach the literal.

**A WRITE prompt must make clear that the payload already exists, and that the ask is for the
procedure.** L0178 describes how to move content; L0176 composes it. A prompt phrased as a bare
imperative — "publish these items", "create these sessions" — reads as a request to AUTHOR the
content, and a router will send it to L0176, correctly by its own lights. Say where the payload
came from ("the JSON from our pipeline", "the template we already fetched") and ask how to send
it. Read prompts do not need this: nothing about "pull every published item" implies authoring.

Note the reading intent is usually carried by ordinary words — "all of them", "every", "the full
set", "just the first page", "a sample to eyeball" — not by naming a policy. That is how the
request arrives, and the generator has to hear it.

L0178 returns a developer recipe (via `get_spec`), not item content and not runnable code. It
never calls the API itself.

## Reading Items — `items-get`

1. Pull every published Item tagged Subject: English out of bank 123 so I can index them for search.
2. Fetch Items Grade7_ELA_1021 and Grade7_ELA_1022 with their creation and update dates.
3. I need all the Items in our bank that contain an mcq question — every one, not a sample.
4. Get me one page of archived Items from bank 4021 so I can eyeball the shape of the data.
5. Export the full set of Items created by user author-99 since January, newest first.
6. List every Item in pool winter-2026 rather than the main bank, all of them.
7. I want all Items tagged Grade: 6 or Grade: 7 but not Grade: 5, from bank 88.
8. Give me every unpublished Item in bank 12 along with its max score and who last updated it.
9. Pull all Items whose workflow reference is Default workflow and whose state is Approved.
10. Fetch the Items referenced by our sync manifest — about 400 references — and include dt_created.
11. Get all Items containing question references q-88f2 or q-91ac, complete list.
12. Read every per-dichotomous scored Item in bank 315, sorted by title ascending.
13. I need the whole Item set from bank 100 updated between 1 March and 31 March 2026.
14. Just the first 10 Items from bank 7, sorted by reference — I only want to sanity-check the format.
15. Pull the complete list of Items tagged Standard: CCSS.MATH.5.NF.1 with their dynamic content data.
16. Extract every Item in bank 4021 that has adaptive data attached, all pages.

## Reading session responses — `responses-get`

17. Pull every completed session response for activity numeracy since January.
18. Get all responses for user student_0001 across every activity — the full history.
19. I need the responses for sessions ef4f80b8-e281-41f4-9efd-349b7eb9dd37 and 9c1d2e33-aa10-4f5b-9f22-6b7c1d0e4411.
20. Fetch every response for activities numeracy and writing that were submitted last week.
21. Give me one page of session responses so I can see what the payload looks like.
22. Read all Incomplete and Pending Scoring sessions for activity midterm-2026, oldest first.
23. Pull every session for user u-4412 that STARTED after 1 February, regardless of when it was submitted.
24. I want all sessions for activity final-exam that were COMPLETED before the deadline of 15 May.
25. Extract every response for activity reading-unit-3 together with our stored session metadata field cohort_id.
26. Get all discarded sessions for activity practice-set-2, complete list, so we can audit them.
27. Pull the full set of responses for users student_0001, student_0002 and student_0003 on activity numeracy.
28. Read every session for activity numeracy that was UPDATED in the last 24 hours — we poll this hourly.

## Asynchronous work — `offlinepackage-get` and `jobs-get`

Neither block is paged, so neither takes a paging policy. The producer returns a job reference
and the poll is its own job — a request describing both halves yields two programs, not one.

29. Build an offline device package for items calc-limit-2 and alg-quad-3 out of bank 386.
30. Package activity unit-3-quiz for offline delivery, with the assets under /content.
31. Check whether job dc39cf55-dbfc-4921-bc69-6488307992fc has finished yet.
32. Show me every job that is still queued or running on bank 386.
33. List the jobs created in the last hour so I can see what our nightly export is doing.
34. Build an offline package for these 12 items, returning only the reference and status of the job.

## Writing Items — `items-set`

A write always carries advisories — that it persists, and that `set` replaces rather than
merges. Those ride alongside a correct program; they are not defects in it. Each prompt names
the bank, because writing to the wrong one is the mistake that cannot be undone.

35. How do I push item alg-quad-3 into bank 386? I already have its JSON from our authoring pipeline.
36. What's the procedure for loading items we've already authored into bank 386 so they're live for delivery?
37. I need to change the title and description of item calc-limit-2 in bank 386 without losing anything else — how?
38. Our nightly job has 40 items of finished JSON to send to bank 386 as unpublished drafts. How should it call the API?
39. How do I archive item L0178_TEST_1 in bank 386 so it stops appearing in the author's list?
40. What's the right way to rename item old-ref-7 to alg-quad-3 in bank 386?
41. How do I write our existing item bio-cell-4 into bank 386, published and tagged Subject: Biology and Grade: 9?

## Deleting a session — `sessions-delete`

One session per request, by design. A prompt that names a single session is this operation;
a prompt that asks to clear many is not, and lives in `boundary-tests.md`.

42. We have a right-to-be-forgotten request for session 88336e4c-04de-4274-ae31-39957b230f98. How do we delete it?
43. A learner has asked us to remove their session 3f9a1c22-77bd-4e10-9a01-5c2e8b41d7e0. What's the procedure?

## Browsing the Item bank — `activities-get`, `questions-get`, `features-get`, `pools-get`, `workflows-get`, `tagging-tags-get`, `tags-get`, `tag-hierarchies-get`, `tag-hierarchy-nodes-get`, `upload-assets-get`, `activity-templates-get`, `player-templates-get`

The rest of the read surface. All six paged ones end on an absent `meta.next`, so a request
that wants everything means exhaustive paging.

44. List every published activity in bank 386, all of them.
45. Find the activities that contain both calc-limit-2 and alg-quad-3.
46. Show me activities tagged Subject: Maths but not Grade: 5, with their titles and creators.
47. Pull every mcq question in bank 386 together with when it was created.
48. Get the questions belonging to items Grade7_ELA_1021 and Grade7_ELA_1022.
49. List all the shared passages in bank 386 — every feature of that type.
50. Find features whose content mentions photosynthesis, narrowed to passage types.
51. Show me every item pool in bank 386 and whether it is published or still pending.
52. List the authoring workflows configured on bank 386.
53. What tag names exist under the type Subject in bank 386? All of them.
54. Give me the tags of type Grade and Subject in bank 386.
55. List the tag hierarchies in bank 386.
56. Show the child nodes under Subject: Maths in the curriculum hierarchy.
57. I need upload URLs for two images, diagram.png and chart.svg, in bank 386.
58. What activity templates are available in bank 386?
59. Which player templates can we choose from in bank 386?

## Tagging — `items-tags-set`, `items-tags-update`, `activities-tags-set`, `activities-tags-update`

The verb decides whether existing tags survive, so the request has to say which it wants. "Add"
is `update`; "these are now its tags" is `set`.

60. How do I add the tag Grade: 9 to item bio-cell-4 in bank 386 without disturbing its other tags?
61. What's the call that adds Subject: Maths to items alg-quad-3 and calc-limit-2, keeping their existing tags?
62. How do I make Status: retired the only tag on item rdg-passage-9?
63. How do I set activity unit-3-quiz's tags to exactly Subject: English and Grade: 7, discarding the old ones?
64. What's the right call to add Term: Spring to activity unit-3-quiz without disturbing its existing tags?
65. How do I retag five items in bank 386 so their only tag is Review: pending?

## Updating sessions, scores and pools — `session-statuses-update`, `session-item-update`,
`response-scores-update`, `response-grading-update`, `response-feedback-update`, `pools-update`

Each of these writes to assessment results. Whether they replace or merge is not established,
so a request should say what it expects to happen.

66. How do I mark session 7939ead7-3242-4907-850d-3e5e48130277 as Completed for user student_0001?
67. Discard sessions 88336e4c-04de-4274-ae31-39957b230f98 and 3f9a1c22-77bd-4e10-9a01-5c2e8b41d7e0.
68. What's the call that swaps item calc-limit-2 into three existing sessions and re-scores them?
69. How do I set the score on response r-4471 in session ef4f80b8-e281-41f4-9efd-349b7eb9dd37 to 3 out of 5?
70. Record grader g-12's score of 4 for response r-889 on item bio-cell-4 in that session.
71. Attach grader feedback to response r-889 in session ef4f80b8 saying the working was incomplete.
72. Update the pool winter-2026 in bank 386 to be named Winter 2026 Review.

## Submitting sessions — `sessions-set-from-template`, `sessions-set-failed-submission`

Two different operations behind one endpoint. The payload the request describes decides which:
learner responses against a template, or recovered base64 session data.

73. How do we create sessions for four learners against the template we already fetched for activity numeracy?
74. We have student_0001's responses and the template. What's the call that submits them?
75. Three sessions failed to save when learners lost connectivity. How do we re-submit the data they recovered?
76. How should our recovery job push yesterday's saved session blobs back into Learnosity, ignoring response revisions?

## Requests that raise an advisory warning

Legitimate jobs the compiler accepts but wants to steer. The programs they yield are correct and
worth retrieving; the warning is advisory and rides alongside, not a defect in the code.

77. Get every Item that is NOT tagged Grade: 5 from bank 88.
78. Fetch all Items whose workflow state is Approved.
79. Read all the Items in the bank — no filter, just everything we have.
80. Pull all the published Items — I don't know our bank id, just use the default one.

## Under-specified requests (the compiler should flag the holes)

These withhold the reading intent on purpose — they are the counterpart to everything above, and
the programs they yield should carry holes, not an invented paging policy. Do not "fix" them by
choosing exhaustive.

81. Get the published Items from bank 123.
82. I need the session responses for activity numeracy.
83. Fetch Items tagged Subject: Science.
84. Read the responses for user student_0001.

