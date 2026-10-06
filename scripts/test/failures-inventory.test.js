// Every refusal reason Policy and Broker can emit has a failure category
// (@graffiticode/common/failures, spec FAIL-01). Scans their sources for each
// form a reason takes there, so a new reason without a category fails here
// instead of reaching callers as `unavailable`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { REASON_CATEGORIES, FAILURE_CATEGORIES, classify } from "@graffiticode/common/failures";

const sources = dir => readdirSync(new URL(`../../packages/${dir}/src/`, import.meta.url))
  .filter(f => f.endsWith(".ts") && !f.endsWith(".spec.ts"))
  .map(f => ({ file: `${dir}/src/${f}`, text: readFileSync(new URL(`../../packages/${dir}/src/${f}`, import.meta.url), "utf8") }));

// The forms a refusal reason takes in Policy and Broker.
const FORMS = [
  /\bdeny\("([a-z0-9-]+)"/g, // policy: deny("reason", record)
  /\brefuse\("([a-z0-9-]+)"/g, // broker: refuse("reason", status)
  /\brefusal: "([a-z0-9-]+)"/g, // policy: { refusal: "reason" }
  /\bnew (?:BrokerRefused|PolicyDenied|AuthorizationDenied)\("([a-z0-9-]+)"/g,
  /\breason: "([a-z0-9-]+)"/g, // audited denials (caller-rejected, route-not-allowed-for-caller)
  /\bdeny\([^;]*?\? "([a-z0-9-]+)" : "([a-z0-9-]+)"/g, // policy: deny(expired ? "token-expired" : "bad-token", …)
];
// Reasons returned from a function rather than in one of the forms above.
const RETURNED = { liveRefusal: /return "([a-z0-9-]+)";/g, provenanceRefusal: /return "([a-z0-9-]+)";/g, authorizationReason: /return "([a-z0-9-]+)";/g };

// Strings the forms also match that aren't refusals: audit annotations of an
// allowed or recorded outcome.
const NOT_REFUSALS = new Set(["canary-during-maintenance", "system-preview", "publication", "outcome-not-recorded", "unclassified-reason", "new", "reused"]);

const functionBody = (text, name) => {
  const start = text.search(new RegExp(`const ${name} = `));
  if (start < 0) return "";
  const end = text.indexOf("\n  };", start) >= 0 ? text.indexOf("\n  };", start) : text.indexOf("\n};", start);
  return text.slice(start, end < 0 ? undefined : end);
};

const emitted = () => {
  const found = new Map();
  const add = (reason, file) => { if (!NOT_REFUSALS.has(reason)) found.set(reason, [...(found.get(reason) ?? []), file]); };
  for (const { file, text } of [...sources("policy"), ...sources("broker")]) {
    for (const form of FORMS) {
      for (const m of text.matchAll(form)) for (const reason of m.slice(1)) if (reason) add(reason, file);
    }
    for (const [name, form] of Object.entries(RETURNED)) {
      for (const m of functionBody(text, name).matchAll(form)) add(m[1], file);
    }
    // MAINTENANCE and other reason constants.
    for (const m of text.matchAll(/export const [A-Z_]+ = "([a-z-]+)";/g)) if (/maintenance/.test(m[1])) add(m[1], file);
  }
  return found;
};

test("every refusal reason Policy and Broker emit has a category", () => {
  const found = emitted();
  assert.ok(found.size > 40, `found only ${found.size} reasons: the scan is broken`);
  const missing = [...found].filter(([reason]) => !REASON_CATEGORIES[reason]).map(([reason, files]) => `${reason} (${[...new Set(files)].join(", ")})`);
  assert.deepEqual(missing, [], `unclassified reasons:\n  ${missing.join("\n  ")}`);
});

test("every category in the table is one of the five", () => {
  for (const [reason, category] of Object.entries(REASON_CATEGORIES)) assert.ok(FAILURE_CATEGORIES.includes(category), `${reason}: ${category}`);
});

test("the table has no stale reasons the code no longer emits", () => {
  const found = emitted();
  // Reasons only reached through a wrapper or a constant the scan reads.
  const stale = Object.keys(REASON_CATEGORIES).filter(r => !found.has(r));
  assert.deepEqual(stale, [], `reasons in the table that nothing emits: ${stale.join(", ")}`);
});

test("wrapped reasons classify as the reason they wrap", () => {
  assert.equal(classify("authorization-denied:token-expired").category, "authentication");
  assert.equal(classify("authorization-denied:maintenance").category, "unavailable");
  assert.equal(classify("authorization-denied:not-granted").category, "permission");
  assert.deepEqual(classify("authorization-denied:something-new"), { category: "unavailable", classified: false });
});
