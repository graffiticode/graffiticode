import test from "node:test";
import assert from "node:assert/strict";
import { BOOTSTRAP, HELPER, bootstrapState, chromeFindings, importedClientNames, nodeFindings, rustFindings, withoutTestModules, PENDING } from "../check-egress-clients.js";

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

test("a client built through an imported name is flagged, an alias included", () => {
  const files = [
    { file: "languages/l0099/crates/core/src/a.rs", source: "use reqwest::Client;\nfn f() { let c = Client::builder().build(); }\n" },
    { file: "languages/l0099/crates/core/src/b.rs", source: "use reqwest::{Certificate, Client as Http, Proxy};\nlet c = Http::new();\n" },
    { file: "languages/l0099/crates/core/src/c.rs", source: "use reqwest::{\n    ClientBuilder,\n    Url,\n};\nlet b = ClientBuilder::new();\n" },
    { file: "languages/l0099/crates/core/src/d.rs", source: "use reqwest::blocking::Client;\nlet c = Client::default();\n" },
    { file: "languages/l0099/crates/core/src/e.rs", source: "let c = reqwest::Client::default();\nlet d = reqwest::blocking::Client::new();\n" },
    // Not reqwest's Client: no use of it, or a path that only ends in the name.
    { file: "languages/l0099/crates/core/src/f.rs", source: "use crate::Client;\nlet c = Client::new();\n" },
    { file: "languages/l0099/crates/core/src/g.rs", source: "use reqwest::Client;\nlet c = my::Client::new();\nlet s = egress::client_builder()?;\n" },
  ];
  assert.deepEqual(rustFindings(files).map(f => `${f.file}:${f.line}`), [
    "languages/l0099/crates/core/src/a.rs:2",
    "languages/l0099/crates/core/src/b.rs:2",
    "languages/l0099/crates/core/src/c.rs:5",
    "languages/l0099/crates/core/src/d.rs:2",
    "languages/l0099/crates/core/src/e.rs:1",
    "languages/l0099/crates/core/src/e.rs:2",
  ]);
  assert.deepEqual(importedClientNames("use reqwest::{self, Client as A, ClientBuilder};"), { client: new Set(["A"]), builder: new Set(["ClientBuilder"]) });
});

test("a browser launch without the egress helper is flagged, Rust and Node", () => {
  const files = [
    { file: "languages/l0099/crates/capture/src/browser.rs", source: "let config = BrowserConfig::builder().build()?;\nlet (b, h) = Browser::launch(config).await?;\n" },
    { file: "languages/l0099/crates/capture/src/ok.rs", source: "let egress = chrome_egress(|n| std::env::var(n).ok())?;\nlet (b, h) = Browser::launch(config).await?;\n" },
    { file: "languages/l0099/crates/capture/src/spawn.rs", source: "let child = Command::new(\"/usr/bin/chromium\").spawn()?;\n" },
    { file: "languages/l0099/crates/capture/tests/chrome.rs", source: "Browser::launch(config)" },
    { file: "languages/l0099/packages/core/src/snap.ts", source: "const browser = await puppeteer.launch({ headless: true });\n" },
    { file: "languages/l0099/packages/core/src/ok.ts", source: "const egress = prepareChromeEgress();\nconst browser = await puppeteer.launch({ args: egress.args });\n" },
    { file: "languages/l0099/packages/core/src/play.ts", source: "// chromium.launch() in a comment\nconst b = await chromium.launch();\n" },
    { file: "languages/l0099/packages/core/src/snap.test.ts", source: "await puppeteer.launch();" },
    { file: "languages/l0099/packages/core/src/helper-in-comment.ts", source: "// prepareChromeEgress() later\nawait puppeteer.launch();\n" },
  ];
  assert.deepEqual(chromeFindings(files).map(f => `${f.file}:${f.line} ${f.helper}`), [
    "languages/l0099/crates/capture/src/browser.rs:1 chrome_egress",
    "languages/l0099/crates/capture/src/browser.rs:2 chrome_egress",
    "languages/l0099/crates/capture/src/spawn.rs:1 chrome_egress",
    "languages/l0099/packages/core/src/snap.ts:1 prepareChromeEgress",
    "languages/l0099/packages/core/src/play.ts:2 prepareChromeEgress",
    "languages/l0099/packages/core/src/helper-in-comment.ts:2 prepareChromeEgress",
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

test("since the l0000 publish, a missing bootstrap fails everywhere but a reviewed PENDING entry", () => {
  const worker = "languages/l0014/tools/translatex-worker.mjs";
  assert.ok(PENDING[worker], "the L0014 worker is the one reviewed exception");
  const out = nodeFindings([
    { lang: "l0000", file: "languages/l0000/packages/api/src/main.ts", source: "import x from \"y\";" },
    { lang: "l0184", file: "languages/l0184/packages/api/src/main.ts", source: "import x from \"y\";" },
    { lang: "l0014", file: worker, source: "import x from \"y\";" },
    { lang: "l0184", file: "languages/l0184/packages/api/src/main.ts", source: BOOTSTRAP },
  ]);
  assert.deepEqual(out.map(o => o.state), ["fail", "fail", "pending", "ok"]);
});
