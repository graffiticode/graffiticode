// B5 gate criterion 9, the rollback rehearsal (plan, "Gates for B5 and B6"): L0179's
// INTERPRETER flag is turned off and back on, each flip an api release that moves
// COMPILE_GENERATION_L0179. Before the first flip, `prime` sends a fixed set of requests so
// results sit in the stage cache under the current generation. After each flip, `check` sends
// the same requests and checks that every answer equals its oracle (the language's own
// service, directly), and that the View's data URL names the generation now current while a URL
// naming the one before is answered no-store. Whether L0179 ran through /interpret or the
// legacy path is read from the api's stage records for the window.
//
//   node rehearsal.mjs prime|check --expect <generation> [--out <file>]
import { readFileSync, writeFileSync } from "node:fs";
const [phase, ...rest] = process.argv.slice(2);
const flag = n => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const expect = flag("--expect");
const API = "https://api.graffiticode.org";
const TAG = "rehearsal-2026-11-06";
const cases = JSON.parse(readFileSync(new URL("../../../../languages/l0179/crates/core/tests/conformance/cases.json", import.meta.url), "utf8"));
const H = { "content-type": "application/json", "user-agent": "graffiticode-rehearsal" };
const answer = b => (b && typeof b === "object" ? { data: b.data ?? null, errors: b.errors ?? [] } : null);
const post = async (url, body) => { const r = await fetch(url, { method: "POST", headers: H, body: JSON.stringify(body) }); return { status: r.status, headers: r.headers, json: await r.json().catch(() => null) }; };
const results = [];
const startedAt = new Date().toISOString();
let n = 0;
for (const c of cases) {
  if (n >= 30) break;
  const o = await post("https://l0179r-sja7fatcta-uc.a.run.app/compile", { code: c.ast, data: { data: { rehearsal: TAG, i: n }, errors: [] } });
  if (o.status !== 200 || answer(o.json)?.errors?.length) continue;
  const id = (await post(`${API}/task`, { task: { lang: "0179", code: c.ast } })).json?.data?.id;
  const r = await post(`${API}/compile`, { id, data: { rehearsal: TAG, i: n } });
  const ok = JSON.stringify(answer(r.json?.data)) === JSON.stringify(answer(o.json));
  let current = null, stale = null, generations = null;
  if (phase === "check" && r.json?.id) {
    const form = await fetch(`${API}/form?id=${r.json.id}`, { headers: H, redirect: "manual" });
    const dataUrl = form.headers.get("location") ? new URL(form.headers.get("location")).searchParams.get("url") : null;
    generations = dataUrl ? new URL(dataUrl).searchParams.get("generations") : null;
    if (generations) {
      current = (await fetch(`${API}/data?id=${r.json.id}&generations=${encodeURIComponent(generations)}`, { headers: H })).headers.get("cache-control");
      const before = generations.replace(/@L0179=[^@]+/, "@L0179=interp-1") === generations ? generations.replace(/@L0179=[^@]+/, "@L0179=rust-2") : generations.replace(/@L0179=[^@]+/, "@L0179=interp-1");
      stale = (await fetch(`${API}/data?id=${r.json.id}&generations=${encodeURIComponent(before)}`, { headers: H })).headers.get("cache-control");
    }
  }
  results.push({ i: n, ok, status: r.status, generations, current, stale });
  n++;
}
const checks = {
  answersEqualOracles: results.every(r => r.ok),
  generationNamed: phase !== "check" || results.every(r => r.generations?.includes(`@L0179=${expect}`)),
  currentImmutable: phase !== "check" || results.every(r => r.current?.includes("immutable")),
  previousNoStore: phase !== "check" || results.every(r => r.stale === "no-store"),
};
const out = { phase, expect, startedAt, endedAt: new Date().toISOString(), requests: results.length, checks, passed: Object.values(checks).every(Boolean), results };
if (flag("--out")) writeFileSync(flag("--out"), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify({ phase, expect, requests: results.length, checks, passed: out.passed }));
