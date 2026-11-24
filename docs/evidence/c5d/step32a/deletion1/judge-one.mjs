import { readFileSync } from "node:fs";
const lib = await import("<runner-checkout>/scripts/lib/c5d-drive-checks.js");
const [phase, file] = process.argv.slice(2);
const r = lib.judgePhase(phase, JSON.parse(readFileSync(file, "utf8")).observations);
for (const c of r.checks) console.log(`${c.ok ? "ok    " : "FAILED"} ${c.id}: ${c.detail}`);
console.log(r.passed ? `${phase} PASSED` : `${phase} NOT PASSED`); process.exit(r.passed ? 0 : 1);
