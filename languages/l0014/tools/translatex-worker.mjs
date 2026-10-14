// SPDX-License-Identifier: MIT
//
// Runs TransLaTeX for the Rust L0014 server, which cannot: the translator is a JavaScript
// library (@graffiticode/translatex, over @graffiticode/parselatex). One process per request.
//
//   stdin   { "rules": <rule set>, "sources": ["x+y", ...] }
//   stdout  [ { "value": "x + y", "errors": [] }, ... ]      one result per source, in order
//
// A source that cannot be translated is a result with errors and an empty value, never a
// failure of the process: that is how the TypeScript compiler treats it.
//
//   node tools/translatex-worker.mjs --self-test    exits 0 if the library loads and translates
import { TransLaTeX } from "@graffiticode/translatex";

function translate(source, rules) {
  let value = "";
  let errors = [];
  try {
    // A fresh translator per source, as the TypeScript compiler builds one.
    const run = TransLaTeX.buildTranslator({ ...rules }, undefined);
    run(source, (err, val) => {
      if (err && err.length) errors = errors.concat(err.map((e) => String(e)));
      value = val;
    });
  } catch (x) {
    errors = errors.concat(String(x && x.message ? x.message : x));
  }
  return { value: value === undefined ? null : value, errors };
}

if (process.argv.includes("--self-test")) {
  const { value, errors } = translate("1+2", {
    data: {},
    rules: { "?+?": ["%1 plus %2"], "?": ["%1"] },
  });
  if (value !== "1 plus 2" || errors.length > 0) {
    console.error(`translatex self-test failed: ${JSON.stringify({ value, errors })}`);
    process.exit(1);
  }
  console.log("translatex self-test passed");
  process.exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
const { rules, sources } = JSON.parse(input);
// TransLaTeX narrates to stdout; the answer must be the only thing there.
const log = console.log;
console.log = () => {};
const results = sources.map((source) => translate(String(source), rules ?? {}));
console.log = log;
process.stdout.write(JSON.stringify(results));
