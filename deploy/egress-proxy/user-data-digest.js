#!/usr/bin/env node
// ISOLATE-01: the logical digest of a generated cloud-init (generate.js, logicalUserData): the
// digest an instance template is named by (egress-proxy-<first 12>). It decodes gz+b64 files
// first, so it's the same on any machine, whatever zlib compressed them.
//
//   node deploy/egress-proxy/user-data-digest.js <workdir>/out/cloud-init.yaml

import { readFile } from "node:fs/promises";
import { userDataDigest } from "./generate.js";

const file = process.argv[2];
if (!file) { console.error("usage: user-data-digest.js <cloud-init.yaml>"); process.exit(2); }
const text = await readFile(file, "utf8");
if (!text.trim()) { console.error(`${file} is empty`); process.exit(1); }
const digest = userDataDigest(text);
console.log(`${digest}  (template egress-proxy-${digest.slice(0, 12)}; ${Buffer.byteLength(text)} bytes)`);
