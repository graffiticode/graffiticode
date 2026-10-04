# L0185 — fetch and shape data

L0185 fetches JSON or CSV from a public https URL, or takes data written inline, and reshapes it:
filtering, picking and renaming fields, computing new ones, grouping and summarizing, sorting,
joining two data sets. A program's output is the transformed data itself — usually a list of
records — and nothing else.

OUT_OF_SCOPE: charts are L0184; spreadsheets and editable tables are L0179; quizzes and assessment
items are L0180. Sources that need a login, an API key or a POST request are not built yet: L0185
fetches only public https URLs with GET. Writing data back anywhere is not built.

**A program is steps, then the source, then `{}`. Every word works on what is to its right, so a
program runs right to left: the source — `fetch`, `rows` or `from` — goes last, just before
`{}`.** Read a program from the bottom up.

```
sort-by ["revenue" DESC]
summarize {orders: COUNT revenue: [SUM "amount"]}
group-by ["region"]
where ["status" EQUALS "paid"]
fetch "https://l0185.graffiticode.org/data/sales.csv"
{}..
```

Bottom up: fetch the CSV, keep paid orders, group by region, summarize each group, sort by
revenue. The output is the summary records, e.g. `[{region: "West", orders: 2, revenue: 320.5}, …]`.

## The rules

- **Exactly one source, rightmost.** `fetch "https://…"` loads a public URL; `rows [ … ]` is
  data written inline; `from x` uses data bound with `let`. Every step has the source somewhere
  to its right.
- **A source's options go to its right**: `fetch "https://…" parse CSV at "data.users" {}`,
  `rows [["Oslo" 709]] columns ["city" "population"] {}`.
- **Steps stack to the left of the source** and run in order from right to left. A step may
  appear more than once (two `where`s are both applied).
- **`group-by` goes to the right of the `summarize` it groups**:
  `summarize {…} group-by ["region"] …`.
- **The program ends in exactly one `{}`**, after the source and its options.
- Closed sets are UPPERCASE tags, written bare: `DESC`, `ABOVE`, `SUM`, `CSV`, `LEFT`.
- A field name may be a dot-path into nested records: `"address.city"`.

## Words

<!-- words:start -->
| Word | Kind | Signature | Meaning |
| --- | --- | --- | --- |
| `fetch` | source | `<string record: record>` | Source: load a public https URL (JSON or CSV). |
| `rows` | source | `<list record: record>` | Source: inline data — a list of records, or a list of lists with `columns`. |
| `from` | source | `<any record: record>` | Source: data produced elsewhere in the program, e.g. a source bound with `let`. |
| `parse` | option of `fetch` | `<tag record: record>` | How to read a fetched body: JSON or CSV. Defaults to the content type, then a sniff. |
| `at` | option of `fetch` | `<string record: record>` | Where the data is inside the fetched JSON, as a dot-path. |
| `columns` | option of `rows` | `<list record: record>` | Names for rows written as lists. |
| `connection-id` | option of `fetch` | `<string record: record>` | Reserved for authenticated sources; not available yet. |
| `where` | step | `<list|lambda record: record>` | Keep the records that match: `[field OP value]`, or a function of the record, e.g. `where ["age" ABOVE 30]`. |
| `pick` | step | `<list record: record>` | Keep only these fields, in this order. |
| `omit` | step | `<list record: record>` | Drop these fields. |
| `rename` | step | `<record record: record>` | Rename fields: `{old: "new"}`. |
| `derive` | step | `<record record: record>` | Add or replace fields computed from each record: `{field: <row: …>}`. |
| `fill` | step | `<record record: record>` | Replace missing or null values: `{field: value}`. |
| `group-by` | step | `<list record: record>` | Group the records by these fields, for the summarize to its left. |
| `summarize` | step | `<record record: record>` | One record per group (or one for all): `{name: COUNT}` or `{name: [SUM "field"]}`. |
| `sort-by` | step | `<list record: record>` | Sort by fields, each optionally followed by ASC or DESC. |
| `limit` | step | `<number record: record>` | Keep the first n records. |
| `skip` | step | `<number record: record>` | Drop the first n records. |
| `distinct` | step | `<list record: record>` | Drop duplicate records, compared on these fields, or on whole records with `[]`. |
| `unnest` | step | `<string record: record>` | One record per element of a list field; record elements merge in as field.key. |
| `spread` | step | `<string record: record>` | Turn a record field into field.key fields. |
| `join` | step | `<record record: record>` | Join another data set: `{with: <source> on: "id" kind: LEFT prefix: "c-"}`. |
| `format` | step | `<record record: record>` | Format numbers or dates as text with an Excel pattern: `{revenue: "$#,##0.00" time: "yyyy-mm-dd hh:mm"}`. |
<!-- words:end -->

## Keeping records: `where`

`where [field OP value]` keeps the records for which the test holds. Operators:
`EQUALS NOT-EQUALS ABOVE AT-LEAST BELOW AT-MOST IN NOT-IN CONTAINS STARTS-WITH ENDS-WITH`, and
`MISSING`/`PRESENT`, which take no value. `IN` and `NOT-IN` take a list.

```
pick ["name" "city"]
where ["city" IN ["Oslo" "Bergen"]]
where ["age" AT-LEAST 30]
fetch "https://l0185.graffiticode.org/data/people.json"
{}..
```

For a test the operators cannot express — OR across fields, arithmetic — give a function of the
record, in parentheses. It must return true or false:

```
where (<row: or (gt (get "age" row) 40) (equiv (get "city" row) "Bergen")>)
fetch "https://l0185.graffiticode.org/data/people.json"
{}..
```

## Computing fields: `derive`

`derive {field: <row: …>}` adds a field (or replaces one) computed from each record:

```
derive {total: <row: mul (get "price" row) (get "qty" row)>}
rows [{item: "Pen" price: 1.5 qty: 4} {item: "Ink" price: 7 qty: 1}]
{}..
```

Functions are L0000 lambdas. Inside them: `get "field" row` reads a field; `add sub mul div`
do arithmetic; `gt ge lt le` compare numbers; `eq` compares NUMBERS and `equiv` compares any two
values (use `equiv` for text); `and or not` combine tests; `concat` joins text and `str` turns a
number into text; `format-number "#,##0.00" x` formats a number.

## Summarizing: `group-by` and `summarize`

`summarize {name: AGG}` or `{name: [AGG "field"]}` turns the records into one record per group —
or one record for all of them when there is no `group-by`. `AGG` is one of
`COUNT SUM AVERAGE MEDIAN MIN MAX COUNT-DISTINCT`; `COUNT` alone counts records.

```
summarize {people: COUNT average-age: [AVERAGE "age"]}
group-by ["city"]
fetch "https://l0185.graffiticode.org/data/people.json"
{}..
```

## Joining: `let` and `join`

Bind a source with L0000's `let`, then join it in. `on` is a field name, or `[left right]` when
they differ; `kind` is `LEFT` (default, keeps unmatched records) or `INNER`; `prefix` renames the
right side's fields so names do not clash.

```
let customers = fetch "https://l0185.graffiticode.org/data/customers.json" {}..
pick ["order-id" "customer-name" "total"]
join {with: customers on: ["customer-id" "id"] prefix: "customer-"}
fetch "https://l0185.graffiticode.org/data/orders.json"
{}..
```

## Nested data

`at "path"` reaches the list inside a fetched JSON document. `spread "address"` turns a record
field into `address.city`, `address.zip`, …; `unnest "items"` makes one record per element of a
list field. A chart or table that needs flat records needs these.

```
pick ["order-id" "items.sku" "items.qty"]
unnest "items"
fetch "https://l0185.graffiticode.org/data/orders.json"
{}..
```

## Data for a chart or another program

When the output is read by another program — a chart's dataset names the fields it reads — produce
those fields with exactly those names, and make every one a plain value (a number, text,
true/false or null), never a record or a list. Reach into nested records with dot-paths and
rename them to the names asked for:

```
rename {"player.name": "player"}
pick ["player.name" "goals"]
limit 10
sort-by ["goals" DESC]
fetch "https://l0185.graffiticode.org/data/stats.json" at "top_scorers"
{}..
```

## Guidelines

- Use only the URLs and values the request gives. Never invent a URL or data.
- Put `pick` near the top (leftmost) so the output has just the fields that were asked for.
- `format` turns numbers or dates into text — use it only when the reader wants formatted text,
  not when another program will compute with the values. A pattern with date codes (`yyyy mm dd
  hh mm ss`, `mmm` for "Jan", `AM/PM`) formats a date, in UTC: a number is read as a Unix time
  (milliseconds, or seconds), a string as an ISO date. `mm` is minutes after `hh`, else the month:
  `format {time: "yyyy-mm-dd hh:mm"}`.
- The result can be at most 1 MB. For large data, `pick` the fields asked for, and `limit` when
  the request names a number.
- `take`, `drop`, `filter`, `map` and `last` are L0000's list functions, not steps: use `limit`,
  `skip`, `where` and `derive`.
