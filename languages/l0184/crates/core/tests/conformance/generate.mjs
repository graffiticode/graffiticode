// SPDX-License-Identifier: MIT
//
// Regenerates the fixtures the Rust L0184 is tested against, from the TypeScript L0184 in
// this directory (packages/core):
//
//   cases.json                        programs parsed with L0184's lexicon and compiled by
//                                     @graffiticode/l0184, with the AST, the upstream data
//                                     and the result
//   ../../src/lexicon-additions.json  the words L0184 adds to the base lexicon
//   ../../src/vocab.json              the vocabulary and legality tables of attributes.ts, the
//                                     example descriptions, and the colour table of colors.ts
//
// The corpus: programs generated from the vocabulary (every word with a good and a wrong value,
// in its own description and in every other; every tag in every tag slot; every plot word on
// every plot kind; every colour), the spec's programs, every program the TypeScript suite
// compiles (recorded while it runs, with its data), number and date sweeps, and hand-written
// edge cases.
//
// Needs `npm ci && npm run -w packages/core build` here; `npm run rust:fixtures` does the
// build. `cargo test` reads the committed output.
// Date.parse reads a date-time without a zone as local time; the server runs in UTC.
process.env.TZ = "UTC";

import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const load = (path) => import(pathToFileURL(join(root, path)).href);

const { parser } = await load("node_modules/@graffiticode/parser/src/index.js");
const { compiler, lexicon } = await load("packages/core/dist/index.js");
const attributes = await load("packages/core/dist/attributes.js");
const l0000 = await load("node_modules/@graffiticode/l0000/dist/index.js");
const { lexicon: base, setSchemaFetcher } = l0000;

/* ------------------------------------------------------------------ generated sources */

const additions = Object.fromEntries(
  Object.entries(lexicon).filter(
    ([word, entry]) => JSON.stringify(base[word]) !== JSON.stringify(entry),
  ),
);
writeFileSync(
  join(root, "crates/core/src/lexicon-additions.json"),
  JSON.stringify(additions, null, 2) + "\n",
);
console.log(
  `redefines base words: ${
    Object.keys(additions)
      .filter((word) => word in base)
      .join(", ") || "none"
  }`,
);

const {
  chainFields,
  memberFields,
  containerFields,
  validAttributes,
  plotKindAttributes,
  labelPositions,
  validSettings,
  containerParts,
  listMember,
  KINDS,
  TAGS,
  exampleOf,
  wordOf,
} = attributes;

// colors.ts keeps its table private; read it from the source, which is the single place it lives.
const tailwind = Object.fromEntries(
  [
    ...readFileSync(join(root, "packages/core/src/colors.ts"), "utf8").matchAll(
      /"([a-z]+(?:-\d+)?)":\s*"([^"]+)"/g,
    ),
  ].map(([, token, hex]) => [token, hex]),
);
const words = [
  ...Object.keys(listMember),
  ...Object.values(listMember),
  "legend",
  "tooltip",
  "label",
  "chart",
  "charts",
];
writeFileSync(
  join(root, "crates/core/src/vocab.json"),
  JSON.stringify(
    {
      kinds: KINDS,
      chainFields,
      memberFields,
      containerFields,
      validAttributes,
      plotKindAttributes,
      labelPositions,
      validSettings,
      // Infinity has no JSON form; null is "no limit".
      containerParts: JSON.parse(JSON.stringify(containerParts)),
      listMember,
      examples: Object.fromEntries(words.map((w) => [w, exampleOf(w)])),
      tailwind,
    },
    null,
    2,
  ) + "\n",
);
console.log(`colour tokens: ${Object.keys(tailwind).length}`);

/* ------------------------------------------------------------------ helpers */

const chart = (parts, settings = "") => `chart [ ${parts} ] ${settings} {}`;
const program = (charts, settings = "", shared = "") =>
  `charts [ ${shared} ${charts} ] ${settings} {}..`;
const plots = (...ps) => `plots [ ${ps.join(" ")} ] {}`;
const axes = (...as) => `axes [ ${as.join(" ")} ] {}`;
const one = (plotSrc, parts = "", settings = "") =>
  program(chart(`${parts} ${plots(plotSrc)}`, settings));

// A minimal plot of each kind, with the parts it needs.
const KIND_BASE = {
  BAR: ["values [3 5 2]", ""],
  LINE: ["values [1 null 3]", ""],
  PIE: ['names ["a" "b" "c"] values [1 2 3]', ""],
  SCATTER: ["x [1 2 3] y [4 5 6]", ""],
  HISTOGRAM: ["values [1 2 2 3 7 9 12]", ""],
  BOXPLOT: ["values [[1 2 3 4 20] [5 6 7]]", ""],
  CANDLESTICK: ["open [1 2] close [2 1] low [0.5 0.5] high [3 3]", ""],
  HEATMAP: ['x ["a" "b"] y ["u" "v"] values [1 2]', ""],
  FUNNEL: ['names ["a" "b" "c"] values [30 20 10]', ""],
  GAUGE: ["value 72", ""],
  RADAR: ["values [1 2 3]", axes('axis direction RADIAL categories ["s" "p" "r"] {}')],
};

// A good value for each word, written as source.
const GOOD = {
  id: '"q"',
  name: '"N"',
  title: '"T"',
  subtitle: '"S"',
  description: '"D"',
  instructions: '"I"',
  theme: "DARK",
  palette: '["blue-500" "#10B981"]',
  background: '"slate-900"',
  "show-chart-tabs": "true",
  "show-chart-menu": "true",
  "dataset-id": '"d1"',
  width: '"80%"',
  height: "300",
  animation: "false",
  columns: '["a" "b"]',
  rows: '[["x" 1] ["y" 2]]',
  direction: "X",
  scale: "LINEAR",
  categories: '["a" "b" "c"]',
  "min-value": "0",
  "max-value": "200",
  position: "TOP",
  inverse: "true",
  rotate: "45",
  kind: "BAR",
  "x-axis": '"x1"',
  "y-axis": '"y1"',
  values: "[1 2 3]",
  names: '["a" "b" "c"]',
  x: "[1 2 3]",
  y: "[4 5 6]",
  value: "50",
  "bin-count": "3",
  group: '["a" "b" "a"]',
  open: "[1 2 3]",
  close: "[2 1 3]",
  low: "[0 0 0]",
  high: "[5 5 5]",
  color: '"blue-500"',
  colors: '["red-500" "blue-500" "#abc"]',
  stack: '"s"',
  smooth: "true",
  area: "true",
  step: "START",
  symbol: "RECT",
  "symbol-size": "6",
  "bar-width": '"50%"',
  "inner-radius": '"40%"',
  radius: "80",
  rose: "AREA",
  "start-angle": "45",
  label: "show true {}",
  show: "false",
  formatter: '"{c}"',
  trigger: "ITEM",
};

// Wrong values for each kind of value a word expects.
const WRONG = {
  text: ["[1]", '"  "', "true", "null", "RECT", "{}"],
  color: ["5", '"nope-500"', '"#12345"', "[1]"],
  number: ['"5"', "true", "[1]", "null"],
  bound: ["true", '""', "[1]"],
  size: ['"50"', "-1", '"50 %"', "true"],
  boolean: ['"true"', '"false"', "1", "null"],
  tag: ['"bar"', '"top"', '"dark"', '"nope"', "5", "CIRCLE"],
  data: ["5", '""', "true", "{}"],
  rows: ["5", '"x"'],
  list: ['"x"', "5"],
  colors: ['"red-500"', "[]", '["red-500" "nope"]', "[5]"],
  record: ["5", '"x"', "[1]"],
};

const wordMeta = Object.fromEntries(
  Object.entries({ ...chainFields, ...memberFields }).map(([name, meta]) => [wordOf(name), meta]),
);

// Where a word naturally sits: a function from a source fragment to a whole program.
const CONTEXTS = {
  charts: (w) => program(chart(plots("plot kind BAR values [1 2] {}")), w),
  chart: (w) => program(chart(plots("plot kind BAR values [1 2] {}"), w)),
  dataset: (w) =>
    program(
      chart(plots("plot kind BAR values [1 2] {}")),
      "",
      `datasets [ dataset ${w} columns ["k" "v"] rows [["a" 1]] {} ] {}`,
    ),
  axis: (w) =>
    one("plot kind BAR values [1 2] {}", axes(`axis direction X ${w} {}`, "axis direction Y {}")),
  plot: (w) => one(`plot kind BAR values [1 2] ${w} {}`),
  label: (w) => one(`plot kind BAR values [1 2] label ${w} {} {}`),
  legend: (w) => program(chart(`legend ${w} {} ${plots("plot kind BAR values [1 2] {}")}`)),
  tooltip: (w) => program(chart(`tooltip ${w} {} ${plots("plot kind BAR values [1 2] {}")}`)),
};

const generated = [];
const add = (src, data) => generated.push(data === undefined ? src : { src, data });

// Every word with a good value and with every wrong value of its type, in every description.
for (const [word, meta] of Object.entries(wordMeta)) {
  if (memberFields[Object.keys(memberFields).find((k) => wordOf(k) === word)]) continue;
  for (const [, place] of Object.entries(CONTEXTS)) {
    add(place(`${word} ${GOOD[word]}`));
  }
  const owners = Object.entries({ ...validAttributes, ...validSettings })
    .filter(([, ws]) => ws.includes(word))
    .map(([o]) => o);
  for (const owner of owners) {
    const place = CONTEXTS[owner];
    if (!place) continue;
    for (const wrong of WRONG[meta.expects] ?? []) add(place(`${word} ${wrong}`));
  }
}

// Every plot word on every plot kind.
for (const [kind, [body, parts]] of Object.entries(KIND_BASE)) {
  add(one(`plot kind ${kind} ${body} {}`, parts));
  add(one(`plot kind ${kind} ${body} {}`, parts, 'title "T" subtitle "S"'));
  add(
    one(
      `plot kind ${kind} ${body} {}`,
      `${parts} legend show true position LEFT {} tooltip show false {}`,
    ),
  );
  add(
    one(`plot kind ${kind} ${body} {}`, `${parts} legend show true position RIGHT {}`, 'title "T"'),
  );
  add(
    one(`plot kind ${kind} ${body} {}`, `${parts} legend show true position TOP {}`, 'title "T"'),
  );
  add(one(`plot kind ${kind} ${body} {} plot kind ${kind} ${body} {}`, parts));
  add(one(`plot kind ${kind} name "A" ${body} {} plot kind ${kind} name "B" ${body} {}`, parts));
  for (const word of validAttributes.plot) {
    if (word === "kind" || body.includes(`${word} `)) continue;
    add(one(`plot kind ${kind} ${body} ${word} ${GOOD[word]} {}`, parts));
  }
  for (const position of Object.keys(TAGS).filter((t) =>
    ["TOP", "BOTTOM", "LEFT", "RIGHT", "INSIDE", "OUTSIDE", "CENTER"].includes(t),
  )) {
    add(one(`plot kind ${kind} ${body} label position ${position} formatter "{b}" {} {}`, parts));
  }
  for (const other of Object.keys(KIND_BASE)) {
    if (other === kind) continue;
    add(
      one(
        `plot kind ${kind} ${body} {} plot kind ${other} ${KIND_BASE[other][0]} {}`,
        parts || KIND_BASE[other][1],
      ),
    );
  }
}

// Every tag in every tag slot.
for (const [name, meta] of Object.entries(chainFields).filter(([, m]) => m.expects === "tag")) {
  const word = wordOf(name);
  const owner = Object.entries({ ...validAttributes, ...validSettings }).find(([, ws]) =>
    ws.includes(word),
  )[0];
  for (const tag of Object.keys(TAGS)) {
    if (word === "kind")
      add(
        one(
          `plot kind ${tag} ${KIND_BASE[tag]?.[0] ?? "values [1 2]"} {}`,
          KIND_BASE[tag]?.[1] ?? "",
        ),
      );
    else if (word === "direction")
      add(
        one(
          "plot kind BAR values [1 2] {}",
          axes(`axis direction ${tag} categories ["a" "b" "c"] {}`, "axis direction Y {}"),
        ),
      );
    else add(CONTEXTS[owner](`${word} ${tag}`));
  }
  for (const v of meta.oneOf) add(CONTEXTS[owner](`${word} "${v.toLowerCase()}"`));
}

// Axes: every scale in every direction, with and without categories and bounds.
for (const dir of ["X", "Y"]) {
  for (const scale of ["CATEGORY", "LINEAR", "LOG", "TIME"]) {
    for (const extra of [
      "",
      'categories ["a" "b"]',
      "min-value 1 max-value 10",
      'min-value "2026-01-01"',
      "min-value 0",
      "min-value 5 max-value 5",
      "position TOP",
      "position LEFT",
      "position BOTTOM rotate 30",
      "rotate 120",
      'name "A" inverse true',
    ]) {
      const other = dir === "X" ? "Y" : "X";
      const a = axes(
        `axis direction ${dir} scale ${scale} ${extra} {}`,
        `axis direction ${other} {}`,
      );
      add(one("plot kind BAR values [1 2] {}", a));
      add(one("plot kind LINE x [1 2] y [3 4] {}", a));
    }
  }
}
for (const extra of [
  "",
  "scale LINEAR",
  "scale CATEGORY",
  "position TOP",
  "rotate 10",
  "min-value 5",
  "max-value 2",
  'min-value "a"',
  'categories ["a" "b"]',
  'categories ["a" "a" "b"]',
  'name "R" inverse true',
]) {
  add(
    one(
      "plot kind RADAR values [1 2 3] {}",
      axes(`axis direction RADIAL categories ["s" "p" "r"] ${extra} {}`),
    ),
  );
  add(one("plot kind RADAR values [1 2] {}", axes(`axis direction RADIAL ${extra} {}`)));
}

// Several axes on a side, and plots bound to them by id.
add(
  one(
    'plot kind BAR y-axis "a" values [1 2] {} plot kind LINE y-axis "b" values [3 4] {} plot kind LINE y-axis "c" values [5 6] {}',
    axes(
      'axis direction X categories ["p" "q"] {}',
      'axis id "a" direction Y {}',
      'axis id "b" direction Y {}',
      'axis id "c" direction Y position RIGHT {}',
      "axis direction X position TOP {}",
    ),
  ),
);

// Colours: every token, hex forms, and near misses.
add(
  program(
    chart(plots("plot kind BAR values [1 2] {}")),
    `palette [${Object.keys(tailwind)
      .map((t) => `"${t}"`)
      .join(" ")}]`,
  ),
);
for (const c of [
  '"#ABC"',
  '"#abcd"',
  '"#AABBCC"',
  '"#aabbccdd"',
  '" blue-500 "',
  '"Blue-500"',
  '"BLACK"',
  '"transparent"',
  '"blue-501"',
  '"#ab"',
  '"#abcdeg"',
  '"rgb(0,0,0)"',
  '""',
  '"red"',
]) {
  add(one(`plot kind BAR values [1 2] color ${c} {}`));
  add(program(chart(plots("plot kind BAR values [1 2] {}")), `background ${c}`));
}

// Numbers: histogram bins and labels, box plots, radar bounds, heatmap ranges, gauges.
let seed = 7;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const sweeps = [
  [0.1, 0.2, 0.3],
  [1e-7, 2e-7, 3e-7],
  [123456789, 123456790, 123456791],
  [0.30000000000000004, 0.3],
  [1, 1.0001, 1.0002, 1.0003],
  [-5, -1, 0, 3.25, 9.5],
  [5, 5, 5],
  [-0.001],
  [1e20, 2e20],
  [0.125, 0.375, 0.625],
  [2.5, 3.5, 0.0125],
];
for (let i = 0; i < 10; i++) {
  const n = 1 + Math.floor(rand() * 30);
  const scale = [1, 10, 0.01, 1000, 0.37][i % 5];
  sweeps.push(
    Array.from({ length: n }, () => Math.round((rand() * 100 - 20) * scale * 1000) / 1000),
  );
}
for (const vs of sweeps) {
  const list = `[${vs.join(" ")}]`;
  add(one(`plot kind HISTOGRAM values ${list} {}`));
  for (const k of [1, 7]) add(one(`plot kind HISTOGRAM values ${list} bin-count ${k} {}`));
  add(one(`plot kind BOXPLOT values [${list} ${list}] {}`));
  add(
    one(
      `plot kind BOXPLOT values ${list} group [${vs.map((_, j) => `"${"abc"[j % 3]}"`).join(" ")}] {}`,
    ),
  );
  add(
    one(
      `plot kind RADAR values [${vs.slice(0, 3).join(" ")} 1 2] {}`,
      axes(`axis direction RADIAL categories ["a" "b" "c" "d" "e"] {}`),
    ),
  );
  add(
    one(
      `plot kind RADAR values [${vs.slice(0, 3).join(" ")} 1 2] {}`,
      axes(`axis direction RADIAL categories ["a" "b" "c" "d" "e"] min-value -100 {}`),
    ),
  );
  add(
    one(
      `plot kind HEATMAP values [[${vs[0]} ${vs[0]}]] {}`,
      axes('axis direction X categories ["a" "b"] {}', 'axis direction Y categories ["u"] {}'),
    ),
  );
  add(one(`plot kind GAUGE value ${vs[0]} min-value -1000 max-value 1000 {}`));
}
for (const big of [
  "1e300",
  "-1e300",
  "1.7976931348623157e308",
  "5e-324",
  "0",
  "-0",
  "1e21",
  "123.456",
]) {
  add(
    one(
      `plot kind RADAR values [${big} 1 2] {}`,
      axes('axis direction RADIAL categories ["a" "b" "c"] {}'),
    ),
  );
  add(
    one(
      `plot kind RADAR values [${big} 1 2] {}`,
      axes(`axis direction RADIAL categories ["a" "b" "c"] min-value ${big} {}`),
    ),
  );
  add(
    one(
      `plot kind HEATMAP values [[${big}]] {}`,
      axes('axis direction X categories ["a"] {}', 'axis direction Y categories ["u"] {}'),
    ),
  );
  add(one(`plot kind HISTOGRAM values [${big} 1] {}`));
  add(one(`plot kind GAUGE value ${big} {}`));
}
for (let n = 1; n <= 5; n++) {
  add(
    one(
      Array.from({ length: n }, (_, j) => `plot kind GAUGE name "g${j}" value ${10 * j} {}`).join(
        " ",
      ),
    ),
  );
  add(
    one(
      Array.from(
        { length: n },
        (_, j) => `plot kind GAUGE name "g${j}" value ${10 * j} color "red-500" {}`,
      ).join(" "),
      "legend show true {}",
    ),
  );
}

// Dates on a TIME axis: what JavaScript's Date.parse accepts decides what compiles.
const DATES = [
  "2026-03-01",
  "2026-03",
  "2026",
  "+002026-03-01",
  "-000001-01-01",
  "2026-03-01T10:00",
  "2026-03-01T10:00:00Z",
  "2026-03-01T10:00:00.123Z",
  "2026-03-01T10:00:00.1234567Z",
  "2026-03-01T10:00:00+05:30",
  "2026-03-01T24:00:00Z",
  "2026-03-01T25:00:00Z",
  "2026-02-30",
  "2026-13-01",
  "2026-00-10",
  "2026-03-01 10:00",
  "2026/03/01",
  "03/01/2026",
  "3/1/2026",
  "1/2/3",
  "March 1, 2026",
  "Mar 1 2026",
  "1 Mar 2026",
  "1 March 2026 10:00 GMT",
  "Sun, 01 Mar 2026 10:00:00 GMT",
  "Sun Mar 01 2026 10:00:00 GMT+0100 (CET)",
  "2026-03-01T10:00:00 PST",
  "Mar 2026",
  "march",
  "2026 march 1",
  "1 2 3",
  "1",
  "12",
  "123",
  "99",
  "100",
  "2026.03.01",
  "2026-3-1",
  "2026-03-01T",
  "T10:00",
  "10:00",
  "10:00 2026-03-01",
  "noon",
  "tomorrow",
  "",
  " ",
  "x",
  "abc 2026",
  "2026 abc",
  "Q1 2026",
  "2026-W10",
  "2026-060",
  "20260301",
  "1e3",
  "0x10",
  "Thu, 01 Jan 1970 00:00:00 GMT",
  "Jan 1 1970 12:00 AM",
  "Jan 1 1970 12:00 PM",
  "Jan 1 1970 13:00 PM",
  "Jan 1 1970 00:00 am",
  "12/31/1999 23:59:59",
  "Dec 25, 2026 (Christmas)",
  "(comment) Dec 25 2026",
  "2026-03-01T10:00:00.Z",
  "2026-03-01T10:00:60Z",
  "2026-03-01T10:60Z",
  "275760-09-13",
  "+275760-09-13T00:00:00Z",
  "+275760-09-13T00:00:00.001Z",
  "Jan 32 2026",
  "Feb 29 2025",
  "Feb 29 2024",
  "2026-03-01 GMT",
  "2026-03-01 UTC+2",
  "Mar 1 2026 UT",
  "Mar 1 2026 EST",
  "Mar 1 2026 EDT",
  "Mar 1 2026 Z",
  "Mar 1 2026 10:00:00.5",
  "Mar 1 2026 10:00:00.",
  "Mar 1 2026 10::",
  "Mar 1 2026 -0500",
  "Mar 1 2026 10:00 +0500",
  "Mar 1 2026 10:00 +05",
  "Mar 1 2026 10:00 +123456",
  "Mar-1-2026",
  "1-Mar-2026",
  "2026-Mar-01",
  "Monday, March 2, 2026",
  "Mo March 2 2026",
  "Septem 1 2026",
  "Sept 1 2026",
  "s 1 2026",
  "1/1/50",
  "1/1/49",
  "1/1/0",
  "1/1/99999",
  "2026-03-01T10:00:00z",
  "2026-03-01t10:00:00Z",
  "2026-03-01T10:00:00+0530",
  "2026-03-01T10Z",
  "1970-01-01T00:00:00.000+00:00",
  "Mar 1 2026 10:00 pm",
  "Mar 1 2026 25:00",
  "Mar 1 2026 10 am",
  "Mar 1 2026 10:00:00:00",
  "Mar 1 2026 )",
  "2026-03-01)",
  "+2026",
  "-2026",
];
const quote = (s) => JSON.stringify(s);
for (const d of DATES) {
  add(
    one(
      `plot kind LINE x [${quote(d)}] y [1] {}`,
      axes("axis direction X scale TIME {}", "axis direction Y {}"),
    ),
  );
}
for (const d of ["2026-03-01", "nope", "Mar 1 2026"]) {
  add(
    one(
      `plot kind LINE x ["2026-03-01"] y [1] {}`,
      axes(
        `axis direction X scale TIME min-value ${quote(d)} max-value ${quote(d)} {}`,
        "axis direction Y {}",
      ),
    ),
  );
}

// Datasets and upstream data.
const UPSTREAM = [
  { region: "West", orders: 3, revenue: 360.5 },
  { region: "North", orders: 2, revenue: 175.25 },
  { region: "South", orders: 1, revenue: 60 },
];
const fed = (rows, columns = "") =>
  program(
    chart(
      `${axes('axis direction X categories "region" {}', "axis direction Y {}")} ${plots('plot kind BAR values "revenue" {}')}`,
    ),
    "",
    `datasets [ dataset id "sales" ${columns} rows ${rows} {} ] {}`,
  );
for (const data of [
  UPSTREAM,
  {},
  [],
  [
    { region: "a", revenue: 1 },
    { revenue: 2, region: "b" },
  ],
  [{ region: "a" }],
  [[1, 2]],
  { rows: [["a", 1]], columns: ["region", "revenue"] },
  { a: 1 },
  [{ region: "a", revenue: [1] }],
]) {
  for (const columns of [
    "",
    'columns ["region" "revenue"]',
    'columns ["revenue" "region"]',
    'columns ["region"]',
  ]) {
    add(fed("data {}", columns), data);
    add(fed('data use "0185"', columns), data);
  }
}
add(fed('data {0: {region: "a" revenue: 1}}', ""));
add(fed('data {1: {region: "a" revenue: 1}}', ""));
add(fed('data {rows: [["a" 1]]}', 'columns ["region" "revenue"]'));
add(fed('{1: {region: "b" revenue: 2} 0: {region: "a" revenue: 1}}', ""));
add(fed('{01: {region: "a" revenue: 1}}', ""));
add(fed("{a: 1}", ""));
add(fed("[[1 2 3]]", 'columns ["region" "revenue"]'));
add(fed('[["a" 1]]', 'columns ["region" "region"]'));
add(fed('[["a" 1]]', 'columns ["region" 5]'));
add(fed('[["a" 1]]', 'columns ["region" " "]'));
add(fed('[{region: "a" revenue: 1} ["b" 2]]', ""));
add(fed('[{region: "a" revenue: 1 extra: 3}]', 'columns ["region" "revenue"]'));
add(fed('[{region: "a"}]', 'columns ["region" "revenue"]'));
add(fed('[{region: "a" revenue: {x: 1}}]', ""));
add(fed('[["a" [1]]]', 'columns ["region" "revenue"]'));
add(fed("[]", ""));
add(fed("[]", 'columns ["region" "revenue"]'));

const handwritten = [
  readFileSync(join(root, "packages/core/spec/template.gc"), "utf8"),
  "42..",
  "{}..",
  '{type: "charts"}..',
  'id "x" {type: "charts"}..',
  'id "x" {type: "chart"}..',
  "[charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] {}]..",
  "(charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] {})..",
  'set-var "c" charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] {} get-var "c"..',
  'set-var "v" [4 5] charts [ chart [ plots [ plot kind BAR values get-var "v" {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind BAR values map (<x: mul x 2>) [1 2 3] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [add 1 2 sub 5 1] {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind BAR values [1 2] name get-var "nope" {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind BAR values [1 get-var "nope"] {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind BAR values [1 2] name div 1 0 {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [1 div 1 0] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [1 2] name 2.5 {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [1 2] name 1e21 {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind BAR values [1 2] {name: "z"} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind BAR values [1 2] {nope: 1} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [1 2] {0: 1} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind BAR values [1 2] {"x-axis": "x1"} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot {kind: "BAR" values: [1 2]} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind BAR values [1 2] {} ] {} ] {id: "k"} ] {}..',
  'charts [ chart [ plots [ plot kind BAR values [1 2] {} ] {} ] {} ] {title: "k"}..',
  'charts [ chart [ plots [ plot kind BAR values [1 2] {} ] {} ] {} ] {nope: "k"}..',
  "charts [ chart [ plots [ plot kind BAR values [1 2] {} ] {} ] {} ] 5..",
  "charts [ chart [ plots [ plot kind BAR values [1 2] {} ] {} ] 5 ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [1 2] {} ] 5 ] {} ] {}..",
  "charts 5 {}..",
  "charts [ chart 5 {} ] {}..",
  "charts [ chart [ plots 5 {} ] {} ] {}..",
  "charts [ chart [ plots [ 5 ] {} ] {} ] {}..",
  'charts [ chart [ plots [ "p" ] {} ] {} ] {}..',
  "charts [ chart [ plots [ {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ {a: 1 b: 2} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ [1] ] {} ] {} ] {}..",
  "charts [ chart [ plots [ BAR ] {} ] {} ] {}..",
  "charts [ chart [ plots [ axis direction X {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind BAR values [1] {} title "x" {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind BAR values [1] {} id "x" {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind BAR values [1] {} plot kind BAR {} values [2] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] show-chart-tabs false show-chart-menu true {}..",
  "charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] show-chart-tabs false {}..",
  "charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] show-chart-tabs false {}..",
  'charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] id "c2" {} chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} chart [ plots [ plot kind BAR values [1] {} ] {} ] id "c1" {} ] {}..',
  'charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] name "N" {} ] {}..',
  "charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] height 0 {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] height -5 {} ] {}..",
  'charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] width 300 height 200 description "D" {} ] {}..',
  "charts [ chart [ plots [ plot kind BAR values [] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [null null] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind PIE names [] values [] {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind PIE names ["a" "b"] values [0 0] {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind PIE names ["a" "a"] values [1 2] {} ] {} legend show false {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind FUNNEL names ["a" "a"] values [1 2] {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind FUNNEL names ["a" "b"] values [1 -2] {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind PIE names ["a" "b"] values [1 2] colors ["red-500"] {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind FUNNEL names ["a" "b"] values [1 2] colors ["red-500"] {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind BAR values [1 2] colors ["red-500"] {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind PIE names [1 true] values [1 2] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind PIE names [1 null] values [1 2] {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind PIE names ["a"] values [1 2] {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind PIE values [1 2] {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind PIE names ["a"] {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind SCATTER x [1 2] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind SCATTER y [1 2] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind SCATTER x [1 2] y [1 null] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind SCATTER x [1 2] y [null null] {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind SCATTER x [1 "b"] y [1 2] {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind SCATTER x [1 null] y [1 2] {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind SCATTER x [1 2] y [1 2] names ["a"] {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind SCATTER x [1 2] y [1 2] names ["a" "b"] label show false {} {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind SCATTER x [1 2] y [1 2] stack "s" {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind LINE x [1 2] y [1 2] stack "s" {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind LINE x [1 2] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind LINE y [1 2] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind LINE {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind LINE values [1 2] smooth true step END {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind LINE values [1 2] smooth false step END {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind LINE values [1 2] symbol NONE symbol-size 0 {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [1 2] {} plot kind LINE values [1 2 3] {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind BAR id "a" values [1 2] {} plot kind LINE id "b" values [1 2 3] {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind BAR values [1 2] {} plot kind SCATTER x [1 2] y [1 2] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind LINE x [1 2] y [1 2] {} plot kind SCATTER x [1 2] y [1 2] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind HISTOGRAM values [[1 2]] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind HISTOGRAM values [] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind HISTOGRAM values [1 2] bin-count 0 {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind HISTOGRAM values [1 2] bin-count 2.5 {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind HISTOGRAM values [1 2] bin-count -1 {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind HISTOGRAM values [1 null] {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind HISTOGRAM name "H" values [1 2 3] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis id "bins" direction X name "Bins" {} axis direction Y scale LINEAR name "Count" {} ] {} plots [ plot kind HISTOGRAM values [1 2 3] {} ] {} ] {} ] {}..',
  "charts [ chart [ axes [ axis direction X scale LINEAR {} ] {} plots [ plot kind HISTOGRAM values [1 2 3] {} ] {} ] {} ] {}..",
  "charts [ chart [ axes [ axis direction RADIAL {} ] {} plots [ plot kind HISTOGRAM values [1 2 3] {} ] {} ] {} ] {}..",
  'charts [ chart [ axes [ axis categories ["a"] {} ] {} plots [ plot kind HISTOGRAM values [1 2 3] {} ] {} ] {} ] {}..',
  "charts [ chart [ axes [ axis direction X rotate 30 {} ] {} plots [ plot kind HISTOGRAM values [1 2 3] {} ] {} ] {} ] {}..",
  "charts [ chart [ axes [ axis direction X {} axis direction X {} ] {} plots [ plot kind HISTOGRAM values [1 2 3] {} ] {} ] {} ] {}..",
  "charts [ chart [ axes [ axis direction Y scale LOG {} ] {} plots [ plot kind HISTOGRAM values [1 2 3] {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind HISTOGRAM x-axis "zz" values [1 2 3] {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind BOXPLOT values [1 2 3] {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind BOXPLOT values [[1 2] [3]] group ["a" "b"] {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind BOXPLOT values [1 2 3] group ["a" "b"] {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind BOXPLOT group ["a" "b"] {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind BOXPLOT {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind BOXPLOT values [[1 2] 3] {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind BOXPLOT values [[1 2] ["a"]] {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind BOXPLOT values [[1 2] [[3]]] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind BOXPLOT values [[] []] {} ] {} ] {} ] {}..",
  'charts [ chart [ axes [ axis direction X categories ["a" "b"] {} axis direction Y {} ] {} plots [ plot kind BOXPLOT values [1 2 3] group ["a" "b" "c"] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction X categories ["a" "b" "c"] {} axis direction Y {} ] {} plots [ plot kind BOXPLOT values [[1 2]] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction X categories ["a" "b"] {} axis direction Y scale LOG {} ] {} plots [ plot kind BOXPLOT values [[1 2] [0 3]] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction X {} axis direction Y categories ["a" "b"] {} ] {} plots [ plot kind BOXPLOT values [[1 2 30] [3 4 5 6 7 100]] {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind BOXPLOT values [[1 2]] {} plot kind BOXPLOT values [[1 2]] {} ] {} ] {} ] {}..",
  'charts [ chart [ axes [ axis direction X categories ["a"] {} axis id "x2" direction X categories ["b"] {} axis direction Y {} ] {} plots [ plot kind BOXPLOT values [[1 2]] {} plot kind BOXPLOT x-axis "x2" values [[1 2]] {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind CANDLESTICK open [1] close [2] low [3] high [4] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind CANDLESTICK open [1] close [2] low [0] high [1.5] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind CANDLESTICK open [1 2] close [2] low [0] high [3] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind CANDLESTICK open [1] close [2] low [0] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind CANDLESTICK open [] close [] low [] high [] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind CANDLESTICK open [1 null] close [2 1] low [0 0] high [3 3] {} ] {} ] {} ] {}..",
  'charts [ chart [ axes [ axis direction X categories ["a" "b" "c"] {} axis direction Y scale LOG {} ] {} plots [ plot kind CANDLESTICK open [1 2 3] close [2 1 3] low [0.5 0.5 0] high [3 3 4] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction X categories ["a"] {} axis direction Y {} ] {} plots [ plot kind CANDLESTICK open [1 2] close [2 1] low [0 0] high [3 3] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction X {} axis direction Y categories ["a" "b"] {} ] {} plots [ plot kind CANDLESTICK open [1 2] close [2 1] low [0 0] high [3 3] {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind HEATMAP values [[1 2] [3 null]] {} ] {} ] {} ] {}..",
  'charts [ chart [ axes [ axis direction X categories ["a" "b"] {} axis direction Y categories ["u" "v"] {} ] {} plots [ plot kind HEATMAP values [[1 2] [3 null]] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction X categories ["a" "b"] {} axis direction Y categories ["u" "v"] inverse true {} ] {} plots [ plot kind HEATMAP values [[1 2] [3 null]] {} ] {} legend show true position RIGHT {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction X categories ["a" "b"] {} axis direction Y categories ["u"] {} ] {} plots [ plot kind HEATMAP values [[1 2] [3 4]] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction X categories ["a" "b"] {} axis direction Y categories ["u" "v"] {} ] {} plots [ plot kind HEATMAP values [[1 2] [3]] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction X categories ["a"] {} axis direction Y categories ["u"] {} ] {} plots [ plot kind HEATMAP values [[null]] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction X {} axis direction Y categories ["u"] {} ] {} plots [ plot kind HEATMAP values [[1]] {} ] {} ] {} ] {}..',
  "charts [ chart [ axes [ axis direction X scale LINEAR {} axis direction Y {} ] {} plots [ plot kind HEATMAP values [[1]] {} ] {} ] {} ] {}..",
  "charts [ chart [ axes [ axis direction X {} ] {} plots [ plot kind HEATMAP values [[1]] {} ] {} ] {} ] {}..",
  'charts [ chart [ axes [ axis direction X {} axis direction Y {} axis direction RADIAL categories ["a" "b" "c"] {} ] {} plots [ plot kind HEATMAP values [[1]] {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind HEATMAP values [1 2] {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind HEATMAP values "v" {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind HEATMAP x ["a"] values [[1]] {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind HEATMAP x ["a"] y ["b"] {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind HEATMAP x ["a" "a"] y ["b" "b"] values [1 2] {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind HEATMAP x ["a" "b"] y ["b" "b"] values [1 null] {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind HEATMAP x ["a" "b"] y ["b"] values [1 2] {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind HEATMAP x [1 2] y [true false] values [1 2] {} ] {} ] {} ] {}..",
  'charts [ chart [ axes [ axis direction X categories ["a"] {} axis direction Y {} ] {} plots [ plot kind HEATMAP x ["z"] y ["b"] values [1] {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind GAUGE {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind GAUGE value 150 {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind GAUGE value -1 {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind GAUGE value 5 min-value 10 max-value 0 {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind GAUGE value 5 min-value "a" {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind GAUGE value 5 max-value "b" {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind GAUGE value 5 {} plot kind BAR values [1] {} ] {} ] {} ] {}..",
  "charts [ chart [ axes [ axis direction X {} ] {} plots [ plot kind GAUGE value 5 {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind RADAR values [1 2 3] {} ] {} ] {} ] {}..",
  "charts [ chart [ axes [ axis direction X {} ] {} plots [ plot kind RADAR values [1 2 3] {} ] {} ] {} ] {}..",
  'charts [ chart [ axes [ axis direction RADIAL categories ["a" "b" "c"] {} axis direction RADIAL categories ["a" "b" "c"] {} ] {} plots [ plot kind RADAR values [1 2 3] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction RADIAL categories ["a" "b" "c"] {} ] {} plots [ plot kind RADAR values [1 2] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction RADIAL categories ["a" "b" "c"] max-value 2 {} ] {} plots [ plot kind RADAR values [1 2 3] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction RADIAL categories ["a" "b" "c"] {} ] {} plots [ plot kind RADAR values [-1 2 3] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction RADIAL categories ["a" "b" "c"] min-value 1 {} ] {} plots [ plot kind RADAR values [0 2 3] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction RADIAL categories ["a" "b" "c"] {} ] {} plots [ plot kind RADAR values [0 0 0] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction RADIAL categories ["a" "b" "c"] {} ] {} plots [ plot kind RADAR name "A" values [1 2 3] area true {} plot kind RADAR name "B" values [3 2 1] color "red-500" {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction RADIAL categories ["a" "b" "c"] {} ] {} plots [ plot kind RADAR values [1 2 3] {} plot kind GAUGE value 1 {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction RADIAL categories ["a" "b" "c"] {} axis direction X {} axis direction Y {} ] {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction X categories ["a"] {} ] {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..',
  "charts [ chart [ axes [ axis direction Y {} ] {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..",
  "charts [ chart [ axes [ ] {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..",
  'charts [ chart [ axes [ axis direction X categories ["a"] {} axis direction Y categories ["b"] {} ] {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction X categories ["a"] {} axis direction Y scale TIME {} ] {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..',
  "charts [ chart [ axes [ axis direction X scale TIME {} axis direction Y scale TIME {} ] {} plots [ plot kind LINE x [1] y [1] {} ] {} ] {} ] {}..",
  "charts [ chart [ axes [ axis direction X scale LOG {} axis direction Y scale LOG {} ] {} plots [ plot kind SCATTER x [1 0] y [1 2] {} ] {} ] {} ] {}..",
  "charts [ chart [ axes [ axis direction X scale LOG {} axis direction Y scale LOG {} ] {} plots [ plot kind SCATTER x [1 2] y [1 -2] {} ] {} ] {} ] {}..",
  "charts [ chart [ axes [ axis direction X scale LOG {} axis direction Y scale LOG {} ] {} plots [ plot kind SCATTER x [1 2] y [1 null] {} ] {} ] {} ] {}..",
  'charts [ chart [ axes [ axis direction X categories ["a" "b"] {} axis direction Y scale LOG {} ] {} plots [ plot kind BAR values [1 null] {} ] {} ] {} ] {}..',
  "charts [ chart [ axes [ axis direction X categories [1 2] {} axis direction Y {} ] {} plots [ plot kind BAR values [1 2] {} ] {} ] {} ] {}..",
  "charts [ chart [ axes [ axis direction X categories [null] {} axis direction Y {} ] {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..",
  'charts [ chart [ axes [ axis direction X categories ["a" "a"] {} axis direction Y {} ] {} plots [ plot kind BAR values [1 2] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction X scale LINEAR categories ["a"] {} axis direction Y {} ] {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..',
  "charts [ chart [ axes [ axis direction X scale LINEAR min-value 5 max-value 1 {} axis direction Y {} ] {} plots [ plot kind LINE x [1] y [1] {} ] {} ] {} ] {}..",
  'charts [ chart [ axes [ axis direction X scale LINEAR min-value "5" {} axis direction Y {} ] {} plots [ plot kind LINE x [1] y [1] {} ] {} ] {} ] {}..',
  "charts [ chart [ axes [ axis direction X scale LOG min-value 0 {} axis direction Y {} ] {} plots [ plot kind LINE x [1] y [1] {} ] {} ] {} ] {}..",
  'charts [ chart [ axes [ axis direction X scale TIME min-value "2026-01-01" max-value 1790006180386 {} axis direction Y {} ] {} plots [ plot kind LINE x [1790006180386] y [1] {} ] {} ] {} ] {}..',
  "charts [ chart [ axes [ axis direction X scale TIME min-value 10 max-value 5 {} axis direction Y {} ] {} plots [ plot kind LINE x [7] y [1] {} ] {} ] {} ] {}..",
  "charts [ chart [ axes [ axis direction X scale TIME {} axis direction Y {} ] {} plots [ plot kind LINE x [null] y [1] {} ] {} ] {} ] {}..",
  "charts [ chart [ axes [ axis direction X scale TIME {} axis direction Y {} ] {} plots [ plot kind LINE x [true] y [1] {} ] {} ] {} ] {}..",
  "charts [ chart [ axes [ axis direction X {} axis direction Y {} ] {} plots [ plot kind LINE values [1] {} ] {} ] {} ] {}..",
  "charts [ chart [ axes [ axis direction X {} axis direction Y {} ] {} plots [ plot kind CANDLESTICK open [1] close [1] low [1] high [1] {} ] {} ] {} ] {}..",
  'charts [ chart [ axes [ axis direction X categories ["a"] {} axis direction Y {} ] {} plots [ plot kind BAR x-axis "x1" y-axis "x1" values [1] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction X categories ["a"] {} axis direction Y {} ] {} plots [ plot kind BAR y-axis "zz" values [1] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction X categories ["a"] {} axis direction X categories ["b"] {} axis direction Y {} ] {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction X categories ["a"] {} axis direction Y position TOP {} ] {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..',
  "charts [ chart [ axes [ axis direction X position LEFT {} axis direction Y {} ] {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..",
  'charts [ chart [ axes [ axis direction X categories ["a"] rotate -91 {} axis direction Y {} ] {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..',
  'charts [ chart [ axes [ axis direction X categories ["a"] rotate -90 {} axis direction Y {} ] {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..',
  "charts [ chart [ legend position INSIDE {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..",
  "charts [ chart [ legend position INSIDE show false {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..",
  "charts [ chart [ legend show true {} legend show true {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..",
  'charts [ chart [ tooltip trigger AXIS {} plots [ plot kind PIE names ["a"] values [1] {} ] {} ] {} ] {}..',
  "charts [ chart [ tooltip {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..",
  "charts [ chart [ legend {} plots [ plot kind BAR values [1] {} plot kind BAR values [1] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [1] label {} {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind BAR values [1] label show false formatter "" {} {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind BAR values [1] label trigger ITEM {} {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [1] label kind BAR {} {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind PIE names ["a"] values [1] label position CENTER formatter "{d}%" {} radius "60%" inner-radius 20 rose RADIUS {} ] {} ] {} ] {}..',
  'charts [ datasets [ dataset id "d" columns ["m" "v"] rows [["a" 1] ["b" 2]] {} ] {} chart [ plots [ plot kind PIE names "m" values "v" {} ] {} ] {} chart [ plots [ plot kind BAR values "v" {} ] {} ] dataset-id "d" {} ] {}..',
  'charts [ datasets [ dataset columns ["m" "v"] rows [["a" 1] ["b" 2]] {} ] {} chart [ datasets [ dataset columns ["w"] rows [[5] [6]] {} ] {} plots [ plot kind BAR values "w" {} ] {} ] {} ] {}..',
  'charts [ datasets [ dataset columns ["m" "v"] rows [["a" 1] ["b" 2]] {} ] {} chart [ datasets [ dataset id "e" columns ["w"] rows [[5] [6]] {} ] {} plots [ plot kind BAR values "w" {} ] {} ] {} ] {}..',
  'charts [ datasets [ dataset columns ["m" "v"] rows [["a" 1] ["b" 2]] {} ] {} chart [ plots [ plot kind HEATMAP values "v" {} ] {} ] {} ] {}..',
  'charts [ datasets [ dataset columns ["m" "v"] rows [["a" 1] ["b" 2]] {} ] {} chart [ plots [ plot kind BOXPLOT values "v" {} ] {} ] {} ] {}..',
  'charts [ datasets [ dataset columns ["m" "v"] rows [["a" 1] ["b" 2]] {} ] {} chart [ plots [ plot kind BOXPLOT values "v" group "m" {} ] {} ] {} ] {}..',
  'charts [ datasets [ dataset columns ["m" "v"] rows [["a" 1] ["b" 2]] {} ] {} chart [ plots [ plot kind HEATMAP x "m" y "m" values "v" {} ] {} ] {} ] {}..',
  'charts [ datasets [ dataset columns ["m" "v"] rows [["a" 1] ["b" 2]] {} ] {} chart [ plots [ plot kind CANDLESTICK open "v" close "v" low "v" high "v" {} ] {} ] {} ] {}..',
  'charts [ datasets [ dataset columns ["m" "v"] rows [["a" 1] ["b" 2]] {} ] {} chart [ plots [ plot kind SCATTER x "v" y "v" names "m" {} ] {} ] {} ] {}..',
  'charts [ datasets [ dataset columns ["m" "v"] rows [["a" 1] ["b" 2]] {} ] {} chart [ plots [ plot kind RADAR values "v" {} ] {} axes [ axis direction RADIAL categories "m" {} ] {} ] {} ] {}..',
  'charts [ datasets [ dataset columns ["m" "v"] rows [["a" 1] ["b" 2] ["c" 3]] {} ] {} chart [ axes [ axis direction RADIAL categories "m" {} ] {} plots [ plot kind RADAR values "v" {} ] {} ] {} ] {}..',
  'charts [ datasets [ dataset columns ["m" "v"] rows [["a" 1] ["b" 2]] {} ] {} chart [ plots [ plot kind BAR values "v" {} ] {} ] {} ] {}..',
  "charts [ datasets [ dataset {} ] {} chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..",
  'charts [ datasets [ ] {} chart [ plots [ plot kind BAR values "v" {} ] {} ] {} ] {}..',
  "charts [ datasets [ ] {} datasets [ ] {} chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..",
  "charts [ chart [ datasets [ ] {} datasets [ ] {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} datasets [ dataset columns ["v"] rows [[1]] {} ] {} ] {}..',
  'charts [ datasets [ dataset columns ["v"] rows [[1]] {} ] title "x" {} chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..',
  'charts [ datasets [ dataset columns ["v"] rows [[1]] {} plot kind BAR {} ] {} chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..',
  'charts [ datasets [ dataset columns ["v"] rows [[1]] {} rows [[2]] {} ] {} chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..',
  "charts [ chart [ axes [ axis direction X {} axis direction Y {} ] {} legend show true {} tooltip show true {} axis direction X {} plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..",
  "charts [ chart [ plot kind BAR values [1] {} ] {} ] {}..",
  "charts [ chart [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] {} ] {}..",
  "charts [ charts [ ] {} ] {}..",
  "charts [ legend show true {} ] {}..",
  'charts [ title "x" {} ] {}..',
  "charts [ {} ] {}..",
  "plot kind BAR values [1] {}..",
  "plots [ plot kind BAR values [1] {} ] {}..",
  "chart [ plots [ plot kind BAR values [1] {} ] {} ] {}..",
  "BAR..",
  "kind BAR {}..",
  "charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] {} {}..",
  "{} charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..",
  'print "x" charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..',
  "plot kind BAR {} charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] {} 42..",
  'charts [ chart [ plots [ plot kind BAR values [1 2] {} ] {} ] title "Sales" subtitle "Q1" description "Bars." animation false width 400 {} ] title "All" instructions "Read." theme DARK palette ["red-500"] background "#FFF" show-chart-tabs true show-chart-menu true {}..',
  'charts [ chart [ plots [ plot kind BAR name "a\\"b" values [1 2] {} plot kind LINE name "π ✓ \\n" values [1 2] {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot id "a\\"b" kind BAR values [1 "x"] {} ] {} ] id "é" {} ] {}..',
  "charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] id 5 {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] id 0.5 name 1e-7 {} ] {}..",
  "charts [ chart [ plots [ plot kind PIE names [1.5 2] values [1 2] {} ] {} ] {} ] {}..",
  "charts [ chart [ axes [ axis direction X categories [0.1 1e21] {} axis direction Y {} ] {} plots [ plot kind BAR values [1 2] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [1.5e-7 0.000001 1e21 123456789012] {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] width "50.5%" {} ] {}..',
  'charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] width " 50% " {} ] {}..',
  'charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] width "50.%" {} ] {}..',
  "charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] width 0 {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] width -0 {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] title 5 {} ] {}..",
  'charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] title "" {} ] {}..',
  'charts [ chart [ plots [ plot kind BAR values [1] label formatter "" {} {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind BAR values [1] label formatter "  " {} {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind BAR values [1] kind LINE {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] title "a" title "b" {} ] {}..',
  'charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] title "a" title "b" {}..',
  "charts [ chart [ plots [ plot kind BAR {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [true] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [[1]] {} ] {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [{a: 1}] {} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind BAR values "v" {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind BAR values "  " {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind BAR values [1] stack "s" {} plot kind BAR values [2] stack "s" {} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot kind BAR values [1 2] {} ] {} legend show false {} ] {} ] {}..",
  "charts [ chart [ plots [ plot kind BAR values [1 2] {} plot kind BAR values [3 4] {} ] {} legend show false {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind BAR values "x" {} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] dataset-id "x" {} ] {}..',
  // A chain that does not end in a record.
  "charts [ chart [ plots [ plot kind BAR values [1] 5 ] {} ] {} ] {}..",
  'charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] title "t" BAR ] {}..',
  'charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] title "t" [1]..',
  'charts [ chart [ plots [ plot kind BAR values [1] {} ] {} ] {} ] theme DARK "x"..',
  // Fields written as a record literal instead of with their words.
  'charts [ chart [ plots [ plot {kind: "BAR" values: [1 2] name: "z"} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot {kind: "BAR" values: [1 2] name: 5} ] {} ] {} ] {}..',
  'charts [ chart [ plots [ plot {kind: "FOO" values: [1 2]} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ plot {values: [1 2]} ] {} ] {} ] {}..",
  'charts [ chart [ plots [ {plot: {kind: "BAR" values: [1]}} ] {} ] {} ] {}..',
  "charts [ chart [ plots [ {plot: null} ] {} ] {} ] {}..",
  'charts [ chart [ {plots: {items: [{kind: "BAR" values: [3]}]}} ] {} ] {}..',
  'charts [ chart [ plots [ plot kind PIE names ["a" "b"] values [1 2] {} ] {} ] {} ] {id: "k" name: "K"}..',
  'charts [ datasets [ dataset {id: "d" columns: ["v"] rows: [[1] [2]]} ] {} chart [ plots [ plot kind BAR values "v" {} ] {} ] {} ] {}..',
];

/* ------------------------------------------------------------------ the spec and the suite */

function blocks(path) {
  const out = [];
  let current = null;
  for (const line of readFileSync(join(root, path), "utf8").split("\n")) {
    if (line.trim().startsWith("```")) {
      if (current) {
        out.push(current.join("\n"));
        current = null;
      } else current = [];
      continue;
    }
    if (current) current.push(line);
  }
  return out;
}
const fragments = ["packages/core/spec/spec.md", "packages/core/spec/instructions.md"]
  .flatMap(blocks)
  .map((block) => block.trim())
  .filter((src) => src && !src.includes("…") && !src.includes("..."))
  .map((src) => (src.endsWith("..") ? src : `${src}..`));

// Every program the TypeScript suite compiles, with its data, recorded while the suite runs.
const scratch = mkdtempSync(join(tmpdir(), "l0184-record-"));
const recording = join(scratch, "compiles.jsonl");
writeFileSync(recording, "");
execFileSync("npx", ["vitest", "run", "--config", join(here, "record.config.mjs")], {
  cwd: join(root, "packages/core"),
  env: { ...process.env, L0184_RECORD: recording },
  stdio: ["ignore", "ignore", "inherit"],
});
const suite = readFileSync(recording, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .map(({ src, data }) => ({ src: src.trim().endsWith("..") ? src : `${src}..`, data }));
rmSync(scratch, { recursive: true, force: true });
console.log(`recorded ${suite.length} compiles from the TypeScript suite`);

/* ------------------------------------------------------------------ compile */

// `data use "0185"` reads L0185's published schema; serve this repository's copy instead of
// fetching it.
const schemaPath = join(root, "..", "l0185", "packages", "core", "spec", "schema.json");
const schema185 = existsSync(schemaPath)
  ? JSON.parse(readFileSync(schemaPath, "utf8"))
  : { title: "L0185 compiled output" };
setSchemaFetcher(async (url) => {
  if (!url.endsWith("/L0185/schema.json"))
    return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
  return {
    ok: true,
    status: 200,
    json: async () => schema185,
    text: async () => JSON.stringify(schema185),
  };
});

function run(code, data) {
  const compiled = new Promise((resolve) =>
    compiler.compile(code, data, {}, (err, val) => {
      const errors = (Array.isArray(err) ? err : err ? [err] : []).filter(Boolean);
      const messages = errors.map((e) => String(e.message ?? e));
      if (errors.length > 0) resolve({ errors: messages });
      else resolve(val === undefined ? {} : { text: JSON.stringify(val) });
    }),
  );
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 3000));
  return Promise.race([compiled, timeout]);
}

process.on("uncaughtException", () => {});

const programs = [...generated, ...fragments, ...suite, ...handwritten].map((p) =>
  typeof p === "string" ? { src: p, data: {} } : p,
);

const log = console.log;
const seen = new Set();
const cases = [];
for (const { src, data } of programs) {
  const key = JSON.stringify([src, data]);
  if (seen.has(key)) continue;
  seen.add(key);
  console.log = () => {};
  let ast, expect;
  try {
    ast = await parser.parse(184, src, structuredClone(lexicon));
    expect = await run(ast, structuredClone(data));
  } catch {
    expect = null;
  } finally {
    console.log = log;
  }
  if (expect === null) {
    console.warn(`skipped: ${src.slice(0, 100).replace(/\s+/g, " ")}`);
    continue;
  }
  const usesSchema = src.includes('use "0185"');
  cases.push({
    src,
    ast,
    ...(Object.keys(data).length || Array.isArray(data) ? { data } : {}),
    ...(usesSchema ? { schema: schema185 } : {}),
    expect,
  });
}
writeFileSync(
  join(here, "cases.json"),
  "[\n" + cases.map((entry) => JSON.stringify(entry)).join(",\n") + "\n]\n",
);
console.log(
  `wrote ${cases.length} cases (${cases.filter((c) => c.expect.errors).length} with errors)`,
);
process.exit(0);
