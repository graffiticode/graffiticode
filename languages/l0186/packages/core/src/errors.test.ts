// SPDX-License-Identifier: MIT
// Exact wording, because the generator is an LLM that reads these messages and tries again:
// each one names what was wrong, where, and how to write it instead. Change a message
// deliberately, then update its line here.
import { describe, expect, it } from "vitest";
import { errorOf } from "./harness.js";

describe("errors", () => {
  it("earlyClose", async () => {
    expect(await errorOf("board [ page [ sticky text \"A\" {} x 3 {} ] {} ] {}")).toBe("page: item 2 is a `x`, which is not a member of page. It holds: sticky, shape, textbox, stamp, section, connector. `x` describes a `sticky` or a `shape` or a `textbox` or a `stamp`, or a setting of `section`. If `x` belongs to the description before it, a `{}` ended that description early: a description ends in exactly one `{}`, after its last word.");
  });
  it("earlyCloseTop", async () => {
    expect(await errorOf("board [ page [ sticky text \"A\" {} ] {} ] {} title \"x\" {}")).toBe("A `{}` ended a description early: the program has 2 top-level descriptions where one `board [ … ] {}` was expected, and the words after the early `{}` started a new one. Every description ends in exactly one `{}`, after its last word: write `sticky text \"A\" x 0 {}`, not `sticky text \"A\" {} x 0 {}`.");
  });
  it("strayRecord", async () => {
    expect(await errorOf("board [ page [ sticky text \"A\" {} {} ] {} ] {}")).toBe("page: item 2 is a stray `{}`. A description ends in exactly one `{}`, after its last word: write sticky id \"kick\" text \"Kickoff\" x 0 y 0 {}, not sticky id \"kick\" text \"Kickoff\" x 0 y 0 {} {}.");
  });
  it("widthOnSticky", async () => {
    expect(await errorOf("board [ page [ sticky text \"A\" width 300 {} ] {} ] {}")).toBe("page: sticky \"A\": `width` is not part of sticky. It takes: id, text, x, y, fill, opacity, font-size. `width` describes a `shape`, or a setting of `section`.");
  });
  it("titleOnPage", async () => {
    expect(await errorOf("board [ page [ ] title \"x\" {} ] {}")).toBe("page: `title` is not a setting of page. Its settings are: name, background. `title` is a setting of the board: write it after the board's outer `]`, e.g. board [ … ] title … {}.");
  });
  it("nameInSticky", async () => {
    expect(await errorOf("board [ page [ sticky name \"x\" {} ] {} ] {}")).toBe("page: sticky 1: `name` is not part of sticky. It takes: id, text, x, y, fill, opacity, font-size. `name` is a setting of `page`: write it after the page's `]`, e.g. page [ … ] name … {}.");
  });
  it("xOnBoard", async () => {
    expect(await errorOf("board [ page [ ] {} ] x 3 {}")).toBe("board: `x` is not a setting of board. Its settings are: title, show-page-tabs, show-page-menu. `x` describes a `sticky` or a `shape` or a `textbox` or a `stamp`, or a setting of `section`.");
  });
  it("stickyInBoard", async () => {
    expect(await errorOf("board [ sticky text \"A\" {} ] {}")).toBe("board: item 1 is a `sticky`, which is not a member of board. It holds: page. `sticky` is a member of `page` or `section`: write it inside its `[ … ]`, e.g. page [ sticky id \"kick\" text \"Kickoff\" x 0 y 0 {} ] {}.");
  });
  it("pageInPage", async () => {
    expect(await errorOf("board [ page [ page [ ] {} ] {} ] {}")).toBe("page: item 1 is a `page`, which is not a member of page. It holds: sticky, shape, textbox, stamp, section, connector. `page` is a member of `board`: write it inside its `[ … ]`, e.g. board [ page [ sticky text \"A\" {} ] name \"Planning\" {} ] {}.");
  });
  it("saveInPage", async () => {
    expect(await errorOf("board [ page [ save-to-figjam \"ABC123\" ] {} ] {}")).toBe("page: item 1 is save-to-figjam, which is not a member of page. `save-to-figjam` is a statement on its own line at the top of the program, e.g. save-to-figjam \"https://www.figma.com/board/ABC123/Name\" then board [ … ] {}..");
  });
  it("saveInChain", async () => {
    expect(await errorOf("board [ page [ ] {} ] title \"x\" save-to-figjam \"ABC123\"")).toBe("title: save-to-figjam cannot end a description. `save-to-figjam` is a statement on its own line at the top of the program, e.g. save-to-figjam \"https://www.figma.com/board/ABC123/Name\" then board [ … ] {}..");
  });
  it("badTarget", async () => {
    expect(await errorOf("save-to-figjam \"my board\" board [ page [ ] {} ] {}")).toBe("save-to-figjam: expected a FigJam link like \"https://www.figma.com/board/ABC123/Name\" or a bare file key like \"ABC123\", got \"my board\".");
  });
  it("twoSaves", async () => {
    expect(await errorOf("save-to-figjam \"ABC123\" save-to-figjam \"ABC123\" board [ page [ ] {} ] {}")).toBe("save-to-figjam is given twice. A board is drawn into one FigJam file: keep one save-to-figjam line.");
  });
  it("noBoard", async () => {
    expect(await errorOf("save-to-figjam \"ABC123\"")).toBe("A program is one board, ending in `..`: e.g. board [ page [ sticky text \"Hello\" {} ] {} ] {}.. save-to-figjam names where to draw it, and needs the board beside it.");
  });
  it("noPages", async () => {
    expect(await errorOf("board [ ] {}")).toBe("board: needs at least one page, e.g. board [ page [ sticky text \"A\" {} ] {} ] {}.");
  });
  it("unnamedPage", async () => {
    expect(await errorOf("board [ page [ ] {} page [ ] name \"B\" {} ] {}")).toBe("board: page 1 needs a name — a board with more than one page names every page, e.g. page [ … ] name \"Retro\" {}.");
  });
  it("stampKindOnShape", async () => {
    expect(await errorOf("board [ page [ shape kind LIKE {} ] {} ] {}")).toBe("page: shape 1: kind LIKE is a stamp, not a shape. A shape's kind is one of SQUARE, ELLIPSE, ROUNDED_RECTANGLE, DIAMOND, TRIANGLE_UP, TRIANGLE_DOWN, PARALLELOGRAM_RIGHT, PARALLELOGRAM_LEFT, ENG_DATABASE, ENG_QUEUE, ENG_FILE, ENG_FOLDER, TRAPEZOID, PREDEFINED_PROCESS, SHIELD, DOCUMENT_SINGLE, DOCUMENT_MULTIPLE, MANUAL_INPUT, HEXAGON, CHEVRON, PENTAGON, OCTAGON, STAR, PLUS, ARROW_LEFT, ARROW_RIGHT, SUMMING_JUNCTION, OR, SPEECH_BUBBLE, INTERNAL_STORAGE.");
  });
  it("shapeKindOnStamp", async () => {
    expect(await errorOf("board [ page [ stamp kind DIAMOND {} ] {} ] {}")).toBe("page: stamp 1: kind DIAMOND is a shape, not a stamp. A stamp's kind is one of LIKE, LOVE, LAUGH, SURPRISED, CELEBRATE, HEART.");
  });
  it("stampNoKind", async () => {
    expect(await errorOf("board [ page [ stamp x 3 {} ] {} ] {}")).toBe("page: stamp 1: needs a kind, one of LIKE, LOVE, LAUGH, SURPRISED, CELEBRATE, HEART, e.g. stamp kind LIKE x 200 y 300 {}.");
  });
  it("quotedTag", async () => {
    expect(await errorOf("board [ page [ shape kind \"diamond\" {} ] {} ] {}")).toBe("kind: expected one of SQUARE, ELLIPSE, ROUNDED_RECTANGLE, DIAMOND, TRIANGLE_UP, TRIANGLE_DOWN, PARALLELOGRAM_RIGHT, PARALLELOGRAM_LEFT, ENG_DATABASE, ENG_QUEUE, ENG_FILE, ENG_FOLDER, TRAPEZOID, PREDEFINED_PROCESS, SHIELD, DOCUMENT_SINGLE, DOCUMENT_MULTIPLE, MANUAL_INPUT, HEXAGON, CHEVRON, PENTAGON, OCTAGON, STAR, PLUS, ARROW_LEFT, ARROW_RIGHT, SUMMING_JUNCTION, OR, SPEECH_BUBBLE, INTERNAL_STORAGE, LIKE, LOVE, LAUGH, SURPRISED, CELEBRATE, HEART, got \"diamond\". Write it bare and uppercase, without quotes: kind DIAMOND.");
  });
  it("badFontSize", async () => {
    expect(await errorOf("board [ page [ textbox text \"x\" font-size \"big\" {} ] {} ] {}")).toBe("font-size: expected one of SMALL, MEDIUM, LARGE, EXTRA_LARGE, HUGE, or a number of pixels above 0, got \"big\".");
  });
  it("badColor", async () => {
    expect(await errorOf("board [ page [ sticky fill \"chartreuse\" {} ] {} ] {}")).toBe("fill: expected a hex colour like \"#ffcc00\" or one of red, blue, green, yellow, purple, orange, pink, white, black, gray, got \"chartreuse\".");
  });
  it("unknownEndpoint", async () => {
    expect(await errorOf("board [ page [ sticky id \"a\" {} connector from \"a\" to \"b\" {} ] {} ] {}")).toBe("page \"Page 1\": connector to \"b\": no node on this page has that id or text. It has: \"a\".");
  });
  it("twiceGiven", async () => {
    expect(await errorOf("board [ page [ sticky x 1 x 2 {} ] {} ] {}")).toBe("x: is given twice. Each word may appear once in a description.");
  });
  it("listNotRecord", async () => {
    expect(await errorOf("board [ page [ ] [ ] ] {}")).toBe("page: needs its settings after the `]`, ending in a record — write `{}` when there are none, e.g. page [ sticky text \"A\" {} ] name \"Planning\" {}.");
  });
  it("notAList", async () => {
    expect(await errorOf("board page [ ] {} {}")).toBe("board: expected a list in [brackets], e.g. board [ page [ sticky text \"A\" {} ] {} ] {}.");
  });
  it("waypointStrayRecord", async () => {
    expect(await errorOf("board [ page [ sticky id \"a\" {} sticky id \"b\" {} connector from \"a\" to \"b\" waypoints [ waypoint [300 0] {} ] {} ] {} ] {}")).toBe("waypoints: item 2 is a stray `{}`. A waypoint takes only its pair: write waypoint [300 0], not waypoint [300 0] {}.");
  });
  it("waypointNotAPair", async () => {
    expect(await errorOf("board [ page [ sticky id \"a\" {} sticky id \"b\" {} connector from \"a\" to \"b\" waypoints [ waypoint 300 0 ] {} ] {} ] {}")).toBe("waypoint: expected an [x y] pair of numbers, like waypoint [300 0], got 300.");
  });
  it("waypointOneNumber", async () => {
    expect(await errorOf("board [ page [ sticky id \"a\" {} sticky id \"b\" {} connector from \"a\" to \"b\" waypoints [ waypoint [300] ] {} ] {} ] {}")).toBe("waypoint: expected an [x y] pair of numbers, like waypoint [300 0], got a list.");
  });
  it("waypointsNotAList", async () => {
    expect(await errorOf("board [ page [ sticky id \"a\" {} sticky id \"b\" {} connector from \"a\" to \"b\" waypoints \"a\" {} ] {} ] {}")).toBe("waypoints: expected a list of waypoints, like waypoints [ waypoint [300 0] waypoint [300 400] ], got \"a\".");
  });
  it("waypointsEmpty", async () => {
    expect(await errorOf("board [ page [ sticky id \"a\" {} sticky id \"b\" {} connector from \"a\" to \"b\" waypoints [ ] {} ] {} ] {}")).toBe("waypoints: needs at least one waypoint, like waypoints [ waypoint [300 0] waypoint [300 400] ].");
  });
  it("waypointsWrongMember", async () => {
    expect(await errorOf("board [ page [ sticky id \"a\" {} sticky id \"b\" {} connector from \"a\" to \"b\" waypoints [ sticky text \"z\" {} ] {} ] {} ] {}")).toBe("waypoints: item 1 is a `sticky`, which is not a waypoint. Write each one as waypoint [x y], like waypoints [ waypoint [300 0] waypoint [300 400] ].");
  });
  it("waypointsFanOut", async () => {
    expect(await errorOf("board [ page [ sticky id \"a\" {} sticky id \"b\" {} connector from \"a\" to [\"b\" \"a\"] waypoints [ waypoint [1 2] ] {} ] {} ] {}")).toBe("page: connector 3: waypoints route one line: give a single from and a single to, e.g. connector from \"a\" to \"b\" waypoints [ waypoint [300 0] ] {}.");
  });
  it("waypointsStar", async () => {
    expect(await errorOf("board [ page [ sticky id \"a\" {} sticky id \"b\" {} connector from \"*\" to \"b\" waypoints [ waypoint [1 2] ] {} ] {} ] {}")).toBe("page: connector 3: waypoints route one line: give a single from and a single to, e.g. connector from \"a\" to \"b\" waypoints [ waypoint [300 0] ] {}.");
  });
  it("waypointInPage", async () => {
    expect(await errorOf("board [ page [ sticky id \"a\" {} sticky id \"b\" {} waypoint [1 2] ] {} ] {}")).toBe("page: item 3 is a `waypoint`, which is not a member of page. It holds: sticky, shape, textbox, stamp, section, connector. `waypoint` is a member of `waypoints`: write it inside its `[ … ]`, e.g. waypoints [ waypoint [300 0] ] {}.");
  });
  it("waypointsOnSticky", async () => {
    expect(await errorOf("board [ page [ sticky id \"a\" {} sticky id \"b\" {} sticky text \"C\" waypoints [ waypoint [1 2] ] {} ] {} ] {}")).toBe("page: sticky \"C\": `waypoints` is not part of sticky. It takes: id, text, x, y, fill, opacity, font-size. `waypoints` describes a `connector`.");
  });
  it("centerOnElbowed", async () => {
    expect(await errorOf("board [ page [ sticky id \"a\" {} sticky id \"b\" {} connector from \"a\" to \"b\" from-side CENTER {} ] {} ] {}")).toBe("page: connector 3: from-side CENTER needs line-type STRAIGHT; FigJam cannot attach an ELBOWED connector at a node's centre. Use AUTO, TOP, BOTTOM, LEFT or RIGHT, or add line-type STRAIGHT.");
  });
  it("centerOnCurved", async () => {
    expect(await errorOf("board [ page [ sticky id \"a\" {} sticky id \"b\" {} connector from \"a\" to \"b\" line-type CURVED to-side CENTER {} ] {} ] {}")).toBe("page: connector 3: to-side CENTER needs line-type STRAIGHT; FigJam cannot attach a CURVED connector at a node's centre. Use AUTO, TOP, BOTTOM, LEFT or RIGHT, or add line-type STRAIGHT.");
  });
});
