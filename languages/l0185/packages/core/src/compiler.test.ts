// SPDX-License-Identifier: MIT
// What each step does, and that a program's output is exactly the data — nothing added.
import { beforeEach, describe, expect, it } from "vitest";
import { compile, fetched } from "./harness.js";
import { lexicon } from "./index.js";

const PEOPLE = 'fetch "https://example.org/people.json" {}';
const SALES = 'fetch "https://example.org/sales.csv" {}';

describe("lexicon", () => {
  it("adds L0185's words without overriding any L0000 word", async () => {
    const { lexicon: base } = await import("@graffiticode/l0000");
    for (const w of ["take", "drop", "last", "filter", "map", "get", "min", "max", "data", "use"]) {
      expect(lexicon[w]).toEqual((base as any)[w]);
    }
    for (const w of ["fetch", "where", "group-by", "sort-by", "limit", "summarize"]) expect(lexicon[w].arity).toBe(2);
    expect(lexicon.ABOVE).toMatchObject({ name: "TAG", arity: 0 });
  });
});

describe("right to left", () => {
  it("runs the source first and returns only the transformed data", async () => {
    const out = await compile(
      `sort-by ["revenue" DESC] summarize {orders: COUNT revenue: [SUM "amount"]} group-by ["region"] where ["status" EQUALS "paid"] ${SALES}`,
    );
    expect(out).toEqual([
      { region: "West", orders: 2, revenue: 320.5 },
      { region: "North", orders: 2, revenue: 175.25 },
    ]);
  });

  it("lets a step repeat", async () => {
    const out = await compile(`pick ["name"] where ["city" EQUALS "Oslo"] where ["age" ABOVE 35] ${PEOPLE}`);
    expect(out).toEqual([{ name: "Cy" }]);
  });
});

describe("sources and their options", () => {
  it("reads JSON at a path", async () => {
    expect(await compile('pick ["name"] fetch "https://example.org/api.json" at "data.users" {}')).toEqual([{ name: "Ana" }, { name: "Ben" }]);
  });

  it("returns whatever the path holds, even an object", async () => {
    expect(await compile('fetch "https://example.org/api.json" at "meta" {}')).toEqual({ count: 2 });
  });

  it("parses CSV with typed values", async () => {
    const out = await compile(`limit 1 ${SALES}`);
    expect(out).toEqual([{ "order-id": 1, region: "West", status: "paid", amount: 120.5, "customer-id": 10 }]);
  });

  it("takes inline records, or lists with columns", async () => {
    expect(await compile('rows [{a: 1} {a: 2}] {}')).toEqual([{ a: 1 }, { a: 2 }]);
    expect(await compile('rows [["Oslo" 709] ["Bergen" 291]] columns ["city" "pop"] {}')).toEqual([
      { city: "Oslo", pop: 709 },
      { city: "Bergen", pop: 291 },
    ]);
  });

  it("takes data bound with let, through from", async () => {
    const out = await compile('let people = fetch "https://example.org/people.json" {}.. limit 1 pick ["name"] from people {}');
    expect(out).toEqual([{ name: "Ana" }]);
  });
});

describe("where", () => {
  const names = async (cond: string) => (await compile(`pick ["name"] where ${cond} ${PEOPLE}`)).map((r: any) => r.name);
  it("compares with each operator", async () => {
    expect(await names('["age" ABOVE 30]')).toEqual(["Ana", "Cy"]);
    expect(await names('["age" AT-LEAST 34]')).toEqual(["Ana", "Cy"]);
    expect(await names('["age" BELOW 28]')).toEqual(["Di"]);
    expect(await names('["age" AT-MOST 28]')).toEqual(["Ben", "Di"]);
    expect(await names('["city" EQUALS "Oslo"]')).toEqual(["Ana", "Cy"]);
    expect(await names('["city" IN ["Bergen" "Trondheim"]]')).toEqual(["Ben", "Di"]);
    expect(await names('["name" STARTS-WITH "D"]')).toEqual(["Di"]);
    expect(await names('["address.zip" ENDS-WITH "50"]')).toEqual(["Ana"]);
  });
  it("treats missing values as missing", async () => {
    expect(await names('["email" MISSING]')).toEqual(["Cy"]);
    expect(await names('["email" PRESENT]')).toEqual(["Ana", "Ben", "Di"]);
    expect(await names('["email" NOT-EQUALS "ana@example.org"]')).toEqual(["Ben", "Cy", "Di"]);
  });
  it("applies a function of the record", async () => {
    expect(await names('(<row: or (gt (get "age" row) 40) (equiv (get "city" row) "Bergen")>)')).toEqual(["Ben", "Cy"]);
  });
});

describe("shaping fields", () => {
  it("picks, omits and renames, keeping order", async () => {
    expect(await compile(`limit 1 pick ["email" "name"] ${PEOPLE}`)).toEqual([{ email: "ana@example.org", name: "Ana" }]);
    expect(await compile(`limit 1 omit ["address" "tags" "email"] ${PEOPLE}`)).toEqual([{ name: "Ana", age: 34, city: "Oslo" }]);
    expect(Object.keys((await compile(`limit 1 rename {city: "town"} pick ["name" "city"] ${PEOPLE}`))[0])).toEqual(["name", "town"]);
  });
  it("picks a nested field by dot-path", async () => {
    expect(await compile(`limit 1 pick ["name" "address.zip"] ${PEOPLE}`)).toEqual([{ name: "Ana", "address.zip": "0150" }]);
  });
  it("derives with L0000 functions, and fills nulls", async () => {
    const out = await compile('derive {total: <row: mul (get "price" row) (get "qty" row)>} rows [{price: 1.5 qty: 4} {price: 7 qty: 1}] {}');
    expect(out.map((r: any) => r.total)).toEqual([6, 7]);
    const filled = await compile(`pick ["email"] fill {email: "none"} ${PEOPLE}`);
    expect(filled.map((r: any) => r.email)).toEqual(["ana@example.org", "ben@example.org", "none", "di@example.org"]);
  });
  it("spreads a record field and unnests a list field", async () => {
    expect((await compile(`limit 1 pick ["address.city" "address.zip"] spread "address" ${PEOPLE}`))[0]).toEqual({ "address.city": "Oslo", "address.zip": "0150" });
    const items = await compile('pick ["order-id" "items.sku"] unnest "items" fetch "https://example.org/orders.json" {}');
    expect(items).toEqual([
      { "order-id": "A1", "items.sku": "pen" },
      { "order-id": "A1", "items.sku": "ink" },
      { "order-id": "A2", "items.sku": "pad" },
    ]);
  });
  it("formats numbers as text", async () => {
    expect(await compile('format {v: "$#,##0.00"} rows [{v: 1234.5}] {}')).toEqual([{ v: "$1,234.50" }]);
  });
});

describe("summarize, sort, limit, distinct", () => {
  it("summarizes everything into one record without group-by", async () => {
    expect(await compile(`summarize {n: COUNT avg: [AVERAGE "age"] oldest: [MAX "age"] median: [MEDIAN "age"] cities: [COUNT-DISTINCT "city"]} ${PEOPLE}`)).toEqual([
      { n: 4, avg: 32, oldest: 41, median: 31, cities: 3 },
    ]);
  });
  it("sorts by several fields, nulls last", async () => {
    const out = await compile(`pick ["name"] sort-by ["city" "age" DESC] ${PEOPLE}`);
    expect(out.map((r: any) => r.name)).toEqual(["Ben", "Cy", "Ana", "Di"]);
    const emails = await compile(`pick ["email"] sort-by ["email" DESC] ${PEOPLE}`);
    expect(emails.map((r: any) => r.email)).toEqual(["di@example.org", "ben@example.org", "ana@example.org", null]);
  });
  it("limits, skips and drops duplicates", async () => {
    expect((await compile(`skip 1 limit 3 ${PEOPLE}`)).map((r: any) => r.name)).toEqual(["Ben", "Cy"]);
    expect(await compile(`pick ["city"] distinct ["city"] ${PEOPLE}`)).toEqual([{ city: "Oslo" }, { city: "Bergen" }, { city: "Trondheim" }]);
  });
});

describe("join", () => {
  it("joins data bound with let, LEFT by default, with a prefix", async () => {
    const out = await compile(
      'let customers = fetch "https://example.org/customers.json" {}.. pick ["order-id" "customer-name"] join {with: customers on: ["customer-id" "id"] prefix: "customer-"} fetch "https://example.org/orders.json" {}',
    );
    expect(out).toEqual([
      { "order-id": "A1", "customer-name": "Acme" },
      { "order-id": "A2", "customer-name": "Globex" },
      { "order-id": "A3", "customer-name": null },
    ]);
  });
  it("keeps only matches when INNER", async () => {
    const out = await compile(
      'let customers = fetch "https://example.org/customers.json" {}.. pick ["order-id"] join {with: customers on: ["customer-id" "id"] kind: INNER prefix: "c-"} fetch "https://example.org/orders.json" {}',
    );
    expect(out).toEqual([{ "order-id": "A1" }, { "order-id": "A2" }]);
  });
});

describe("fetching", () => {
  beforeEach(() => {
    fetched.length = 0;
  });
  it("fetches a URL used twice once", async () => {
    await compile(
      'let a = fetch "https://example.org/people.json" {}.. join {with: a on: "name" prefix: "again-"} fetch "https://example.org/people.json" {}',
    );
    expect(fetched).toEqual(["https://example.org/people.json"]);
  });
});
