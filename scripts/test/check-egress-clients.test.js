import test from "node:test";
import assert from "node:assert/strict";
import { BOOTSTRAP, HELPER, bootstrapState, nodeFindings, rustFindings, withoutTestModules } from "../check-egress-clients.js";

test("a reqwest client built outside the egress helper is flagged; the helper, tests and reviewed exceptions aren't", () => {
  const files = [
    { file: "languages/l0099/crates/server/src/main.rs", source: "fn main() {\n    let c = reqwest::Client::builder().build();\n}\n" },
    { file: "languages/l0099/crates/core/src/x.rs", source: "let c = reqwest::Client::new();\n// reqwest::Client::new() in a comment\n" },
    { file: HELPER, source: "reqwest::Client::builder()" },
    { file: "languages/l0099/crates/core/tests/t.rs", source: "reqwest::Client::new()" },
    { file: "languages/l0185/crates/core/src/fetch.rs", source: "reqwest::Client::builder()" },
    { file: "languages/l0099/crates/core/src/y.rs", source: "fn a() {}\n#[cfg(test)]\nmod tests {\n    fn b() { let c = reqwest::Client::new(); }\n}\n" },
    { file: "languages/l0099/crates/core/src/z.rs", source: "let c = l0000r_server::egress::client_builder()?.build()?;\n" },
  ];
  assert.deepEqual(rustFindings(files).map(f => `${f.file}:${f.line}`), [
    "languages/l0099/crates/server/src/main.rs:2",
    "languages/l0099/crates/core/src/x.rs:1",
  ]);
});

test("test modules are stripped, nested braces included", () => {
  assert.equal(withoutTestModules("a\n#[cfg(test)]\nmod t { fn f() { if x { y } } }\nb"), "a\n\nb");
});

test("the bootstrap must be the first statement", () => {
  assert.equal(bootstrapState(`// SPDX-License-Identifier: MIT\n// why\n${BOOTSTRAP}\nimport { a } from "b";\n`), "ok");
  assert.equal(bootstrapState(`import { a } from "b";\n${BOOTSTRAP}\n`), "missing");
  assert.equal(bootstrapState("import { a } from \"b\";\n"), "missing");
});

test("a missing bootstrap fails for a required language and is pending for the rest", () => {
  const out = nodeFindings([
    { lang: "l0000", file: "a", source: "import x from \"y\";" },
    { lang: "l0184", file: "b", source: "import x from \"y\";" },
    { lang: "l0184", file: "c", source: BOOTSTRAP },
  ]);
  assert.deepEqual(out.map(o => o.state), ["fail", "pending", "ok"]);
});
