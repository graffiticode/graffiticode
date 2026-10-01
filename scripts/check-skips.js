// Fails a jest run that skipped tests it was not allowed to skip.
//
//   node scripts/check-skips.js <jest --json output> [allowed skip ...]
//
// A skip is any test whose status is not passed or failed (pending, skipped,
// todo, disabled), so describe.skip suites that gate themselves on an env var
// (e.g. FIRESTORE_EMULATOR_HOST) count. An allowed skip is named
// "<repo-relative spec path> > <full test name>". A run with no tests at all
// also fails, so a target whose path filter matches nothing can't pass
// silently.

import { readFileSync } from "fs";
import { dirname, relative, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RAN = new Set(["passed", "failed"]);

export const findSkips = results =>
  results.testResults.flatMap(file =>
    file.assertionResults
      .filter(test => !RAN.has(test.status))
      .map(test => `${relative(ROOT, file.name)} > ${test.fullName}`));

export const checkSkips = (results, allowed = []) => {
  const problems = [];
  if (results.numTotalTests === 0) problems.push("no tests ran");
  const allow = new Set(allowed);
  const skipped = findSkips(results);
  for (const name of skipped) {
    if (!allow.has(name)) problems.push(`unexpected skip: ${name}`);
  }
  for (const name of allow) {
    if (!skipped.includes(name)) problems.push(`allowed skip did not occur (remove it from the allowlist?): ${name}`);
  }
  return problems;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, ...allowed] = process.argv.slice(2);
  if (!file) {
    console.error("usage: node scripts/check-skips.js <jest-json> [allowed skip ...]");
    process.exit(2);
  }
  const problems = checkSkips(JSON.parse(readFileSync(file, "utf8")), allowed);
  for (const problem of problems) console.error(problem);
  process.exit(problems.length ? 1 : 0);
}
