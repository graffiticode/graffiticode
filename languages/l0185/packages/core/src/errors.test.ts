// SPDX-License-Identifier: MIT
// Exact wording, because the generator is an LLM that reads these messages and tries again: each
// names what was wrong, where, and how to write it instead. Generated from the reviewed messages;
// change a message deliberately, then update its line here.
import { describe, expect, it } from "vitest";
import { errorOf } from "./harness.js";

describe("errors", () => {
  it("unknownField", async () => {
    expect(await errorOf("where [\"agee\" ABOVE 30] fetch \"https://example.org/people.json\" {}")).toBe("where: no field \"agee\" in the data. Its fields are: \"name\", \"age\", \"city\", \"email\", \"address\", \"tags\". Did you mean \"age\"?");
  });
  it("noSource", async () => {
    expect(await errorOf("where [\"age\" ABOVE 30] {}")).toBe("where: there is no data to its right. The source goes last, just before {}: where [\"age\" ABOVE 30] fetch \"https://example.org/people.json\" {}.");
  });
  it("twoSources", async () => {
    expect(await errorOf("rows [{a: 1}] fetch \"https://example.org/people.json\" {}")).toBe("rows: the data already has a source to its right (fetch). A program has exactly one source, rightmost, just before {}.");
  });
  it("optionLeftOfSource", async () => {
    expect(await errorOf("at \"data.users\" fetch \"https://example.org/api.json\" {}")).toBe("at: is an option of fetch, so it goes to the right of fetch, not to its left: fetch \"https://example.org/api.json\" at \"data.users\" {}.");
  });
  it("optionWrongSource", async () => {
    expect(await errorOf("rows [{a: 1}] at \"x\" {}")).toBe("at: is an option of fetch, not rows. Write it to the right of fetch, e.g. fetch \"https://example.org/api.json\" at \"data.users\" {}.");
  });
  it("columnsOnRecords", async () => {
    expect(await errorOf("rows [{a: 1}] columns [\"a\"] {}")).toBe("columns: names rows written as lists; these rows are records, which carry their own field names. Remove columns.");
  });
  it("listRowsNoColumns", async () => {
    expect(await errorOf("rows [[\"Oslo\" 709]] {}")).toBe("rows: rows written as lists need columns to name them, to the right of rows: rows [[\"Oslo\" 709]] columns [\"city\" \"population\"] {}.");
  });
  it("raggedRow", async () => {
    expect(await errorOf("rows [[\"Oslo\" 709] [\"Bergen\"]] columns [\"city\" \"pop\"] {}")).toBe("rows: row 2 has 1 value, but there are 2 columns (city, pop).");
  });
  it("groupByNoSummarize", async () => {
    expect(await errorOf("group-by [\"city\"] fetch \"https://example.org/people.json\" {}")).toBe("group-by: has no summarize to its left. Write summarize {\u2026} group-by [\u2026] \u2026, e.g. summarize {orders: COUNT} group-by [\"region\"] fetch \"https://\u2026\" {}.");
  });
  it("opNeedsValue", async () => {
    expect(await errorOf("where [\"age\" ABOVE] fetch \"https://example.org/people.json\" {}")).toBe("where: ABOVE needs a value: where [\"age\" ABOVE \u2026].");
  });
  it("opNoValue", async () => {
    expect(await errorOf("where [\"email\" MISSING 1] fetch \"https://example.org/people.json\" {}")).toBe("where: MISSING takes no value: where [\"email\" MISSING].");
  });
  it("inNeedsList", async () => {
    expect(await errorOf("where [\"city\" IN \"Oslo\"] fetch \"https://example.org/people.json\" {}")).toBe("where: IN needs a list of values, e.g. where [\"city\" IN [\"a\" \"b\"]].");
  });
  it("aggNeedsField", async () => {
    expect(await errorOf("summarize {n: SUM} fetch \"https://example.org/people.json\" {}")).toBe("summarize: SUM needs a field: n: [SUM \"field\"].");
  });
  it("aggNotNumeric", async () => {
    expect(await errorOf("summarize {n: [SUM \"city\"]} fetch \"https://example.org/people.json\" {}")).toBe("summarize: SUM of \"city\" needs numbers; it found \"Oslo\".");
  });
  it("joinNoWith", async () => {
    expect(await errorOf("join {on: \"id\"} fetch \"https://example.org/people.json\" {}")).toBe("join: expects {with: <data> on: \"field\"}, e.g. join {with: customers on: [\"customer-id\" \"id\"]}, with customers bound by let.");
  });
  it("joinUnknownKey", async () => {
    expect(await errorOf("let c = fetch \"https://example.org/customers.json\" {}.. join {with: c on: \"id\" type: LEFT} fetch \"https://example.org/orders.json\" {}")).toBe("join: \"type\" is not part of join. It takes: with, on, kind, prefix.");
  });
  it("joinClash", async () => {
    expect(await errorOf("let a = fetch \"https://example.org/people.json\" {}.. join {with: a on: \"name\"} fetch \"https://example.org/people.json\" {}")).toBe("join: both sides have a field \"age\". Add a prefix, e.g. prefix: \"right-\".");
  });
  it("shadowTake", async () => {
    expect(await errorOf("take 2 fetch \"https://example.org/people.json\" {}")).toBe("`take` is L0000's list function, not an L0185 step. Write: limit 10 fetch \"https://\u2026\" {}.");
  });
  it("shadowFilter", async () => {
    expect(await errorOf("filter (<r: true>) fetch \"https://example.org/people.json\" {}")).toBe("`filter` is L0000's list function, not an L0185 step. Write: where [\"age\" ABOVE 30] fetch \"https://\u2026\" {}.");
  });
  it("fetch404", async () => {
    expect(await errorOf("fetch \"https://example.org/missing.json\" {}")).toBe("fetch: fetching \"https://example.org/missing.json\" failed: the server answered 404.");
  });
  it("htmlBody", async () => {
    expect(await errorOf("fetch \"https://example.org/page.html\" {}")).toBe("fetch: \"https://example.org/page.html\" returned an HTML page, not JSON or CSV.");
  });
  it("atNothing", async () => {
    expect(await errorOf("fetch \"https://example.org/api.json\" at \"data.people\" {}")).toBe("at: \"data.people\" names nothing in the data from \"https://example.org/api.json\". Its top-level keys are: \"meta\", \"data\".");
  });
  it("lambdaNotBool", async () => {
    expect(await errorOf("where (<row: get \"age\" row>) fetch \"https://example.org/people.json\" {}")).toBe("where: the function returned 34 for record 1; it must return true or false, e.g. where (<row: gt (get \"age\" row) 30>).");
  });
  it("deriveNothing", async () => {
    expect(await errorOf("derive {x: <row: get \"nope\" row>} fetch \"https://example.org/people.json\" {}")).toBe("derive: the function for \"x\" returned nothing for record 1. Check its field names, e.g. derive {x: <row: get \"price\" row>}.");
  });
  it("connectionId", async () => {
    expect(await errorOf("fetch \"https://example.org/people.json\" connection-id \"c1\" {}")).toBe("connection-id: authenticated sources are not available yet. Use a public https URL.");
  });
  it("earlyClose", async () => {
    expect(await errorOf("where [\"age\" ABOVE 30] {} fetch \"https://example.org/people.json\" {}")).toBe("A `{}` ended the program early: it has 2 top-level expressions where one was expected, and the words after the early `{}` started a new one. A program is steps, then the source, then exactly one `{}`: write `where [\"age\" ABOVE 30] fetch \"https://\u2026\" {}`, not `where [\"age\" ABOVE 30] {} fetch \"https://\u2026\" {}`.");
  });
  it("notAProgram", async () => {
    expect(await errorOf("add 1 2")).toBe("A program is steps, then a source, then `{}`: e.g. where [\"age\" ABOVE 30] fetch \"https://example.org/people.json\" {}..");
  });
  it("limitNotCount", async () => {
    expect(await errorOf("limit \"ten\" fetch \"https://example.org/people.json\" {}")).toBe("limit: expects a whole number of records, e.g. limit 10. Got \"ten\".");
  });
  it("sortBadItem", async () => {
    expect(await errorOf("sort-by [\"age\" 3] fetch \"https://example.org/people.json\" {}")).toBe("sort-by: 3 is not a field or ASC/DESC. Write sort-by [\"revenue\" DESC \"name\"].");
  });
  it("renameClash", async () => {
    expect(await errorOf("rename {city: \"name\"} fetch \"https://example.org/people.json\" {}")).toBe("rename: \"city\" would become \"name\", which is already a field. Rename or omit \"name\" first.");
  });
  it("needsList", async () => {
    expect(await errorOf("where [\"count\" ABOVE 1] fetch \"https://example.org/api.json\" at \"meta\" {}")).toBe("where: needs a list of records, but the data to its right is a record. Use at \"\u2026\" on the fetch to reach the list.");
  });
  it("outputTooLarge", async () => {
    expect(await errorOf("let albums = fetch \"https://example.org/albums.json\" {}.. join {with: albums on: [\"albumId\" \"id\"] prefix: \"album-\"} fetch \"https://example.org/photos.json\" {}")).toBe("The result is larger than 1 MB, the most an item can hold. Use pick to keep only the fields you need, or limit.");
  });
  it("unknownFieldNested", async () => {
    expect(await errorOf("pick [\"zip\"] fetch \"https://example.org/people.json\" {}")).toBe("pick: no field \"zip\" in the data. Its fields are: \"name\", \"age\", \"city\", \"email\", \"address\", \"tags\". Did you mean \"address.zip\"?");
  });
});
