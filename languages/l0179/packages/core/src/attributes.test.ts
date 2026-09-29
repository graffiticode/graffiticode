// SPDX-License-Identifier: MIT
/**
 * Argument-type and shape rules.
 *
 * These exist because L0179 was briefly MORE PERMISSIVE than L0166: `font-size 14` compiled to
 * `font-size: ""`, silently dropping the value, where L0166 errors with E_ARG_TYPE. The
 * differential test cannot catch that class — it compares programs that compile in BOTH
 * languages, so it is blind to L0179 accepting what L0166 rejects. Only these can.
 */
import { test, expect } from "vitest";
import { parser } from "@graffiticode/parser";
import { compiler, lexicon } from "./index.js";

async function compileSrc(src: string) {
  const code = await parser.parse(179, src, lexicon);
  return await new Promise<any>((res, rej) =>
    compiler.compile(code, {}, {}, (e: any, v: any) => {
      const errs = Array.isArray(e) ? e.filter(Boolean) : e ? [e] : [];
      if (errs.length) rej(errs); else res(v);
    }));
}

const cell = (attrs: string) =>
  `sheets [ sheet "s" [ cells [ cell A1 [text "x" ${attrs}] ] {} ] ] {}..`;

/**
 * Assert that compiling fails with a message containing `needle`.
 *
 * Checks that SOME error matches rather than pinning the array shape: one mistake can raise
 * several errors (a rejected cell leaves the sheet with no cells, which trips that rule too),
 * and a test that breaks when a second, correct error appears is testing the wrong thing.
 */
async function expectError(src: string, needle: string) {
  let errors: any[] | null = null;
  try {
    await compileSrc(src);
  } catch (e: any) {
    errors = Array.isArray(e) ? e : [e];
  }
  expect(errors, `expected a compile error containing "${needle}", but it compiled`).toBeTruthy();
  const messages = errors!.map((x) => String(x?.message ?? x));
  expect(
    messages.some((m) => m.includes(needle)),
    `no error contained "${needle}":\n  ${messages.join("\n  ")}`,
  ).toBe(true);
}

test.each([
  ["font-size 14", "font-size expects a string"],
  ["font-family 12", "font-family expects a string"],
  ['width "wide"', "width expects a number"],
  ["background-color 0", "background-color expects a string"],
])("%s is rejected", async (attrs, needle) => {
  await expectError(cell(attrs), needle);
});

test.each([
  'font-size "14px"',
  "width 100",
  'background-color "#eee"',
  'align "center"',
])("%s is accepted", async (attrs) => {
  await expect(compileSrc(cell(attrs))).resolves.toBeTruthy();
});

// The trap this placement exists for: the base Checker.LIST visits only elts[0], so a rule
// written as a Checker method fires for the first attribute and skips every one after it.
test("a bad argument is caught in the LAST position of an attribute list", async () => {
  await expectError(
    cell('color "red" font-weight "bold" font-size 14'),
    "font-size expects a string",
  );
});

test("points rejects a negative and preserves zero", async () => {
  const withPoints = (p: string) =>
    `sheets [ sheet "s" [ cells [ cell A1 [assess [method "value" expected "1" points ${p}]] ] {} ] ] {}..`;
  await expectError(withPoints("-1"), "must be >= 0");
  // `points 0` is meaningful — checked but unscored — so it must survive, not read as unset.
  const out = await compileSrc(withPoints("0"));
  expect(out.interaction.cells.A1.assess.points).toBe(0);
});

test("hide-formulabar wants a boolean", async () => {
  await expectError(
    `sheets [ sheet "s" [ hide-formulabar 1 cells [ cell A1 [text "x"] ] {} ] ] {}..`,
    "expects true or false",
  );
});

// A sheet with no cells renders nothing. The generator produced exactly this for "create a
// header row with bold white text": row 1 styled, with nothing in it.
test("a sheet with no cells is an error, not an empty grid", async () => {
  await expectError(
    `sheets [ sheet "s" [ rows [ row 1 [font-weight "bold"] ] {} ] ] {}..`,
    "no cells",
  );
});

test("an attribute on the wrong container names where it belongs", async () => {
  await expectError(cell('method "value"'), "belongs to assess");
});

// A type check is not enough to keep a value meaningful: "16" is a fine string and a useless CSS
// size. The repair loop produced exactly this when the type error was first enforced.
test.each(['"14px"', '"1.2em"', '"120%"', '"large"'])("font-size %s is a real size", async (v) => {
  await expect(compileSrc(cell(`font-size ${v}`))).resolves.toBeTruthy();
});

test.each(['"16"', '"big"'])("font-size %s is rejected for want of a unit", async (v) => {
  await expectError(cell(`font-size ${v}`), "needs a unit");
});

// ── Several sheets ─────────────────────────────────────────────────────────
//
// None of this had a single test before multiple sheets landed — including the rule that used to
// reject a second sheet. The compiled shape is the contract every consumer reads, so these assert
// on OUTPUT, never on source shape.

const twoSheets = (s1 = "", s2 = "", tail = "") => `sheets [
  sheet "s1" [ ${s1} cells [ cell A1 [text "a"] ] {} ]
  sheet "s2" [ ${s2} cells [ cell A1 [text "b"] ] {} ]
] ${tail} {}..`;

test("two sheets compile and each keeps its own cells", async () => {
  const out = await compileSrc(twoSheets());
  expect(out.interaction.sheets.map((s: any) => s.id)).toEqual(["s1", "s2"]);
  expect(out.interaction.sheets[0].cells.A1.text).toBe("a");
  expect(out.interaction.sheets[1].cells.A1.text).toBe("b");
});

test("the flat fields mirror sheet 1, so an older renderer still draws something", async () => {
  const out = await compileSrc(twoSheets());
  expect(out.interaction.cells.A1.text).toBe("a");
});

// The disjunction that keeps single-sheet output byte-identical to L0166. If this test and the
// next one disagree, the differential test stops meaning anything.
test("a lone unnamed sheet emits NO sheets envelope", async () => {
  const out = await compileSrc('sheets [ sheet "s1" [ cells [ cell A1 [text "a"] ] {} ] ] {}..');
  expect(out.interaction.sheets).toBeUndefined();
  expect(out.interaction.showSheetTabs).toBeUndefined();
  expect(out.interaction.hideSheetMenu).toBeUndefined();
  expect(out.validation.sheets).toBeUndefined();
});

test("a lone NAMED sheet does emit one, so the sheet menu can label it", async () => {
  const out = await compileSrc(
    'sheets [ sheet "s1" [ name "Revenue" cells [ cell A1 [text "a"] ] {} ] ] {}..');
  expect(out.interaction.sheets).toHaveLength(1);
  expect(out.interaction.sheets[0].name).toBe("Revenue");
});

test("name falls back to the id, and the id to its position", async () => {
  const out = await compileSrc(twoSheets('name "Revenue"'));
  expect(out.interaction.sheets.map((s: any) => s.name)).toEqual(["Revenue", "s2"]);
});

test("duplicate ids are refused — they key answers and grading", async () => {
  await expectError(
    `sheets [
      sheet "dup" [ cells [ cell A1 [text "a"] ] {} ]
      sheet "dup" [ cells [ cell A1 [text "b"] ] {} ]
    ] {}..`,
    'two sheets share the id "dup"');
});

test("title and instructions are program-level and reach the top of the output", async () => {
  const out = await compileSrc(twoSheets("", "", 'title "T" instructions "I"'));
  expect(out.title).toBe("T");
  expect(out.instructions).toBe("I");
});

test("title inside a sheet is refused, and the error says where it belongs", async () => {
  await expectError(
    'sheets [ sheet "s1" [ title "T" cells [ cell A1 [text "a"] ] {} ] ] {}..',
    "`title` belongs to sheets");
});

test("params still works when it comes last in the chain", async () => {
  const out = await compileSrc(
    `sheets [ sheet "s1" [ cells [ cell A1 [text "{{A1}}"] ] {} ] ] title "T" params { "A1": "1" } {}..`);
  expect(out.title).toBe("T");
  expect(out.templateVariablesRecords[0].A1).toBe("1");
});

test("show-sheet-tabs and hide-sheet-menu reach interaction, and only when written", async () => {
  const out = await compileSrc(twoSheets("", "", "show-sheet-tabs false hide-sheet-menu false"));
  expect(out.interaction.showSheetTabs).toBe(false);
  expect(out.interaction.hideSheetMenu).toBe(false);
});

// ── instant-feedback ───────────────────────────────────────────────────────

const oneAssessed = (tail = "") =>
  `sheets [ sheet "s1" [ cells [ cell A1 [text "" assess [method "value" expected "4"]] ] {} ] ] ${tail} {}..`;

test("instant-feedback compiles to a top-level `feedback` mode, never `instantFeedback`", async () => {
  const on = await compileSrc(oneAssessed("instant-feedback true"));
  expect(on.feedback).toBe("instant");
  expect(on).not.toHaveProperty("instantFeedback");
  const off = await compileSrc(oneAssessed("instant-feedback false"));
  expect(off.feedback).toBe("check");
});

test("without instant-feedback there is no `feedback` key — the default is on check", async () => {
  const out = await compileSrc(oneAssessed());
  expect(out).not.toHaveProperty("feedback");
});

test("instant-feedback takes a boolean", async () => {
  await expectError(oneAssessed('instant-feedback "yes"'), "instant-feedback");
});

test("instant-feedback inside a sheet is refused and pointed at the program level", async () => {
  await expectError(
    'sheets [ sheet "s1" [ instant-feedback true cells [ cell A1 [text "a"] ] {} ] ] {}..',
    "instant-feedback");
});

test("hiding both the menu and the tabs with several sheets is refused as unreachable", async () => {
  await expectError(twoSheets("", "", "show-sheet-tabs false hide-sheet-menu true"),
    "leaves no way to reach sheets beyond the first");
});

test("hiding both is fine with ONE sheet — there is nothing to navigate to", async () => {
  await expect(compileSrc(
    'sheets [ sheet "s1" [ cells [ cell A1 [text "a"] ] {} ] ] show-sheet-tabs false hide-sheet-menu true {}..',
  )).resolves.toBeTruthy();
});

// ── Per-sheet grading ──────────────────────────────────────────────────────

const assessed = (points1: number, points2: number) => `sheets [
  sheet "s1" [ cells [ cell A1 [text "" assess [method "value" expected "1" points ${points1}]] ] {} ]
  sheet "s2" [ cells [ cell A1 [text "" assess [method "value" expected "2" points ${points2}]] ] {} ]
] {}..`;

test("points sum across sheets into one total", async () => {
  const out = await compileSrc(assessed(6, 4));
  expect(out.validation.points).toBe(10);
  expect(out.validation.sheets.s1.points).toBe(6);
  expect(out.validation.sheets.s2.points).toBe(4);
});

// The silent failure this guards: `getValidation` writes regions[region].rows[rowIndex][col], so
// run once over a merged grid the second A1 overwrites the first and one sheet's answer key
// vanishes — leaving a maximum no correct response can reach.
test("two sheets both holding A1 do not overwrite each other's answer key", async () => {
  const out = await compileSrc(assessed(6, 4));
  expect(out.validation.sheets.s1.regions["*"].rows[0].A.assess.expected).toBe("1");
  expect(out.validation.sheets.s2.regions["*"].rows[0].A.assess.expected).toBe("2");
});

// Same shape of bug one level up: resolveInheritedPoints looks up columns[key[0]] globally.
test("a cell does not inherit points from the other sheet's column", async () => {
  const out = await compileSrc(`sheets [
    sheet "s1" [
      columns [ column A [assess [points 9]] ] {}
      cells [ cell A1 [text "" assess [method "value" expected "1"]] ] {}
    ]
    sheet "s2" [ cells [ cell A1 [text "" assess [method "value" expected "2"]] ] {} ]
  ] {}..`);
  expect(out.interaction.sheets[0].cells.A1.assess.points).toBe(9);
  expect(out.interaction.sheets[1].cells.A1.assess.points).toBeUndefined();
});

// ── Sheet-qualified param names ────────────────────────────────────────────

test("a sheet-qualified param name survives into templateVariablesRecords verbatim", async () => {
  const out = await compileSrc(twoSheets("", "", 'params { "s2!A1": "7" }'));
  expect(out.templateVariablesRecords[0]["s2!A1"]).toBe("7");
});

test("a qualified name pointing at no such sheet is refused, and names the ones that exist", async () => {
  await expectError(twoSheets("", "", 'params { "s9!A1": "7" }'), 'params: "s9!A1"');
});

test("a qualified name whose address is malformed is refused", async () => {
  await expectError(twoSheets("", "", 'params { "s2!nope": "7" }'), "is not a cell address");
});

test("a bare param name is untouched — it means sheet 1, as it always has", async () => {
  const out = await compileSrc(twoSheets("", "", 'params { "A1": "7" }'));
  expect(out.templateVariablesRecords[0].A1).toBe("7");
});
