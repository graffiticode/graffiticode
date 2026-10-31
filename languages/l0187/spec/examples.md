<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0187 RAG Training Examples

72 example prompts for training a RAG model on L0187, the declarative FigJam board language.
They cover sticky notes, shapes, text, sections, invisible groups, rows, columns, grids and flows,
connectors (labels, dashes, thickness, arrowheads, return paths, self-loops, parallel lines),
boards with several pages, and drawing a board into a FigJam file.

Each numbered line is a prompt in the author's own voice. Prompts describe WHAT goes on the board,
how it is grouped, what connects and what order matters. They never give positions or sizes,
because L0187 places everything itself. Every prompt here is in scope.

## Category 1: Minimal Boards (1–6)

1. Make an empty FigJam board with one page called "Ideas".
2. Put a single sticky note that says "Hello" on a board.
3. A board with one heading that says "Welcome to the workshop".
4. A board with one diamond that asks "Ready?".
5. A board with a single section called "Parking lot" and nothing in it yet.
6. Add a sticky note saying "Kickoff" to my FigJam board https://www.figma.com/board/ABC123/Planning.

## Category 2: Notes in Order (7–14)

7. Three sticky notes in a row: "Research", "Design", "Build".
8. Five sticky notes in a column, one per weekday.
9. Four sticky notes in a 2 by 2 grid: "Strengths", "Weaknesses", "Opportunities", "Threats".
10. Six yellow sticky notes in a grid of three columns, numbered one to six.
11. A pink, a green and a blue sticky note side by side, in that order.
12. A long sticky note explaining why we moved the launch date, followed by two short reactions.
13. A column of three notes, the middle one at half opacity.
14. A row of four notes with large text: "Now", "Next", "Later", "Never".

## Category 3: Sections (15–24)

15. A sprint retrospective with Went well, To improve and Action items columns, two notes in each.
16. A kanban board with To do, Doing and Done columns.
17. A start, stop, continue retro with three sections side by side.
18. A section called "Questions" holding four sticky notes in a grid of two columns.
19. Two sections, "Before" and "After", each holding three notes in a column.
20. A section with a blue fill called "Decisions" containing two notes.
21. An empty retro template: Went well, To improve and Action items sections, with no notes yet.
22. A mad, sad, glad retro with notes coloured red, blue and green.
23. A section called "Goals" next to a section called "Risks", each with a short list of notes.
24. A four-column story map: Discover, Plan, Build, Launch, with two notes under each.

## Category 4: Headings and Groups (25–32)

25. A workshop agenda: a large heading above two panels side by side, Goals and Topics.
26. A heading "Team charter" above a grid of six value notes in three columns.
27. A page with a heading, then a row of three sections, then a closing note.
28. Group three sections side by side and put a heading above the group.
29. A comparison board: Option A and Option B sections side by side, each with pros and cons notes.
30. A huge title "Q3 planning" above a column of three priority notes.
31. Two groups stacked: the first a row of goal notes, the second a row of risk notes.
32. A textbox with a paragraph of instructions above a grid of empty-looking idea notes.

## Category 5: Flows and Decisions (33–44)

33. A flowchart: Start, Fetch data, a Valid? decision, then Save or Report error.
34. A flowchart where Report error loops back to Fetch data with a dashed Retry line.
35. An approval flow: Request, Approved?, then Ship it or Rework, with Rework going back to the check.
36. A top-to-bottom flow of five steps for onboarding a new hire.
37. A login flow with a decision for valid credentials and branches labelled Yes and No.
38. A release pipeline from left to right: Build, Test, Stage, Deploy.
39. A flow where Plan must come before Build and Build before Review, with Review linked back to Plan.
40. A customer support triage flow with three outcomes from one decision.
41. A right-to-left flow of three steps.
42. A bottom-to-top flow showing a growth ladder of four stages.
43. A process with a document step and a predefined process step between two rounded steps.
44. A loop: a single shape "Poll" with a connector back to itself labelled "every minute".

## Category 6: Systems and Connections (45–54)

45. A small system diagram: Web app talks to API, and API talks to the Orders database.
46. A client and a server with three connectors between them: request, response and heartbeat.
47. Three services connected to one database, each line labelled with its query type.
48. A queue between a producer and two consumers, drawn left to right.
49. Two services with a thick connector between them labelled "critical path".
50. A diagram where the cache sits between the API and the database, with a dashed line from the API straight to the database labelled "on miss".
51. A web app, an auth service and a user database, with connectors that have filled arrowheads.
52. A connector with no arrowheads between two related ideas.
53. A sticky note linked to a section's notes: connect the summary note to each of the three notes inside the "Findings" section.
54. Two sections side by side with a connector from a note in the first to a note in the second.

## Category 7: Pages (55–62)

55. A workshop board with Agenda, Brainstorm and Decisions pages.
56. A two-page board: a retro on the first page and action items on the second.
57. A three-page board, one page per quarter, each with a row of goal notes.
58. A board with a "Context" page holding a heading and notes, and a "Flow" page holding a flowchart.
59. A board with two pages and the page menu shown.
60. A one-page board titled "Offsite" with no page tabs.
61. A board whose first page is a kanban and second page is a decision flow.
62. Two pages with a grey background on the second page.

## Category 8: Drawing Into FigJam (63–72)

63. Add a kanban board to my FigJam file https://www.figma.com/board/ABC123/Sprint.
64. Draw a retro into FigJam file key ABC123xyz.
65. Put this approval flow in https://www.figma.com/board/XYZ789/Process: Request, Review, Approve.
66. Add a heading and three idea notes to my board https://www.figma.com/board/LMN456/Brainstorm.
67. Draw the system diagram with the API and database into https://www.figma.com/board/QRS321/Architecture.
68. Add a two-page workshop board to my FigJam file https://www.figma.com/board/TUV654/Workshop.
69. Save a start, stop, continue retro to FigJam file DEF456ghi.
70. Put a comparison of Option A and Option B into https://www.figma.com/board/GHI987/Decision.
71. Add an onboarding flow from top to bottom to https://www.figma.com/board/JKL012/Onboarding.
72. Draw a mad, sad, glad retro into https://www.figma.com/board/MNO345/Retro.
