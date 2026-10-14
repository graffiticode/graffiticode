// AT-11 helpers shared by the probes: arguments and evidence files.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

// `--flag value` pairs from `flags`, everything else positional in `_`.
export function parseArgs(argv, flags) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (flags.includes(argv[i])) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`${argv[i]} requires a value`);
      out[argv[i]] = argv[++i];
    } else if (argv[i].startsWith("--")) {
      throw new Error(`unknown option ${argv[i]}`);
    } else {
      out._.push(argv[i]);
    }
  }
  return out;
}

// Evidence goes to .gc-deploy/at11/<subject>/<probe>-<timestamp>.json (or --out).
export async function writeEvidence(outDir, subject, probe, result) {
  if (!/^[a-z0-9-]+$/.test(subject)) throw new Error(`not a subject name: ${subject}`);
  const dir = path.join(outDir ?? path.join(ROOT, ".gc-deploy", "at11"), subject);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${probe}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify(result, null, 2) + "\n");
  return file;
}
