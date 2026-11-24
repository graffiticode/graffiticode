import { readFileSync } from "node:fs";
const lib = await import("<runner-checkout>/scripts/lib/c5d-drive-checks.js");
const [a, b] = process.argv.slice(2).map(f => JSON.parse(readFileSync(f, "utf8")).observations);
const merged = { ...a, ...b, errors: { ...(a.errors ?? {}), ...(b.errors ?? {}) } };
const r = lib.judgePhase("drop-outcome", merged);
for (const c of r.checks) console.log(`${c.ok ? "ok    " : "FAILED"} ${c.id}: ${c.detail}`);
console.log(r.passed ? "drop-outcome PASSED" : "drop-outcome NOT PASSED");
process.exit(r.passed ? 0 : 1);
