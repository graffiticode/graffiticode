<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# L0185 Specification

L0185 is a Graffiticode dialect that fetches data from a public https URL — or takes data written
inline — and reshapes it. A program's value is the transformed data, usually a list of records.

# Program

A program is steps, then a source, then `{}`, ending in `..`. Every word takes its parameter and
then everything to its right, so the source runs first and the program reads from the bottom up:

```
sort-by ["revenue" DESC]
summarize {orders: COUNT revenue: [SUM "amount"]}
group-by ["region"]
where ["status" EQUALS "paid"]
fetch "https://l0185.graffiticode.org/data/sales.csv"
{}..
```

There is exactly one source — `fetch`, `rows` or `from` — and it is rightmost. A source's options
(`parse`, `at`, `columns`) go to its right. Steps go to its left, may repeat, and run from right
to left.

# Words

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

# Tags

Closed sets are uppercase tags, written bare.

| Used by | Tags |
| --- | --- |
| `parse` | JSON, CSV |
| `where` | EQUALS, NOT-EQUALS, ABOVE, AT-LEAST, BELOW, AT-MOST, IN, NOT-IN, CONTAINS, STARTS-WITH, ENDS-WITH, MISSING, PRESENT |
| `summarize` | COUNT, SUM, AVERAGE, MEDIAN, MIN, MAX, COUNT-DISTINCT |
| `sort-by` | ASC, DESC |
| `join` | LEFT, INNER |

# Functions of a record

`where` and `derive` accept L0000 functions of the record, written in parentheses where they
stand alone:

```
where (<row: or (gt (get "age" row) 40) (equiv (get "city" row) "Bergen")>)
derive {next-year: <row: add (get "age" row) 1>}
fetch "https://l0185.graffiticode.org/data/people.json"
{}..
```

# Joins

A source bound with `let` is a value, and `join` merges it in:

```
let customers = fetch "https://l0185.graffiticode.org/data/customers.json" {}..
pick ["order-id" "customer-name"]
join {with: customers on: ["customer-id" "id"] kind: LEFT prefix: "customer-"}
fetch "https://l0185.graffiticode.org/data/orders.json"
{}..
```

# Fetching

`fetch` loads only public `https://` addresses with GET: no private, local or internal hosts, at
most 3 redirects, 10 seconds and 5 MB per URL, at most 10 URLs per program. The format is `parse`
when given, else the response's content type, else a sniff of the body. Sources that need a login
are not available yet; `connection-id` is reserved for them.

# Formatting

`format` turns numbers or dates into text with an Excel pattern. A pattern that uses date codes
(`yyyy`, `mm`, `dd`, `hh`, `ss`, `mmm`, `dddd`, `AM/PM`) formats a date in UTC; `m`/`mm` after an
hour code or before a seconds code is minutes. A number is read as a Unix time (milliseconds, or
seconds below 1e11) and a string as an ISO 8601 date; a value that is not a date is left as it is.

```
format {time: "yyyy-mm-dd hh:mm" mag: "0.0"}
rename {"properties.place": "place" "properties.mag": "mag" "properties.time": "time"}
pick ["properties.place" "properties.mag" "properties.time"]
fetch "https://l0185.graffiticode.org/data/earthquakes.json" at "features"
{}..
```

# Output

The output is the data, exactly — no envelope and no added fields. It is limited to 10,000
records and 1 MB.
