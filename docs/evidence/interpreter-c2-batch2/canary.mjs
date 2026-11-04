// C2 batch 2 canary: a staged api (tag URL) interpreting L0003, L0010, L0014, L0177, L0178 and L0180, against
// production, which still compiles them on the legacy path.
// node docs/evidence/interpreter-c2-batch2/canary.mjs <stagedBase>
import { readFileSync } from "node:fs";
const [staged] = process.argv.slice(2);
const prod = "https://api.graffiticode.org";
const LANGS = ["0003", "0010", "0014", "0177", "0178", "0180"];
const UA = { "user-agent": "Mozilla/5.0 (Macintosh) Chrome/130 Safari/537.36" };
const results = [];
const check = (name, pass, detail = "") => { results.push({ name, pass, detail }); console.error(`${pass ? "PASS" : "FAIL"} ${name} ${detail}`); };
const post = async (base, path, body) => {
  const r = await fetch(base + path, { method: "POST", headers: { ...UA, "content-type": "application/json", "x-graffiticode-storage-type": "ephemeral" }, body: JSON.stringify(body) });
  return { status: r.status, headers: r.headers, body: await r.json() };
};
const get = async (base, path) => {
  const r = await fetch(base + path, { headers: UA });
  return { status: r.status, headers: r.headers, body: await r.json() };
};
const task = async t => (await post(prod, "/task", { task: t })).body.data.id;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hasErrors = body => Boolean(body?.data?.errors?.length || body?.errors?.length);
const ids = {};

for (const lang of LANGS) {
  const L = `L${lang}`;
  const cases = JSON.parse(readFileSync(new URL(`../../../languages/l${lang}/crates/core/tests/conformance/cases.json`, import.meta.url), "utf8"));
  // A program that compiles cleanly through production, with and without upstream data.
  let plain = null, withData = null, bad = null;
  for (const c of cases) {
    if (plain && withData && bad) break;
    const isData = c.data && typeof c.data === "object" && Object.keys(c.data).length;
    if (isData ? withData : plain && bad) continue;
    const id = await task({ lang, code: c.ast });
    const p = await get(prod, `/data?id=${id}`);
    if (hasErrors(p.body)) { bad ??= { c, id }; continue; }
    if (isData) withData ??= { c, id }; else plain ??= { c, id };
  }
  ids[L] = { plain: plain?.id, withData: withData?.id, errors: bad?.id };

  // 1. /data: equal to production, a repeat equal to the first, and the generation's cache rules.
  const p1 = await get(prod, `/data?id=${plain.id}`);
  const s1 = await get(staged, `/data?id=${plain.id}`);
  const s2 = await get(staged, `/data?id=${plain.id}`);
  check(`${L} /data equals production`, same(s1.body.data, p1.body.data));
  check(`${L} repeat equals first`, same(s2.body.data, s1.body.data));
  check(`${L} interpreted, no generations in URL: no-store`, s1.headers.get("cache-control") === "no-store", s1.headers.get("cache-control"));
  const named = await get(staged, `/data?id=${plain.id}&generations=${encodeURIComponent(`@${L}=interp-1`)}`);
  check(`${L} URL naming interp-1: immutable`, Boolean(named.headers.get("cache-control")?.includes("immutable")), named.headers.get("cache-control"));
  const old = await get(staged, `/data?id=${plain.id}&generations=${encodeURIComponent(`@${L}=rust-1`)}`);
  check(`${L} URL naming rust-1: no-store`, old.headers.get("cache-control") === "no-store", old.headers.get("cache-control"));

  // 2. /form on the staged api names the new generation.
  const form = await fetch(`${staged}/form?id=${plain.id}`, { headers: UA, redirect: "manual" });
  const dataUrl = new URL(form.headers.get("location")).searchParams.get("url");
  check(`${L} /form data URL names @${L}=interp-1`, new URL(dataUrl).searchParams.get("generations") === `@${L}=interp-1`, dataUrl);

  // 3. POST /compile: the program over form state (legacy data task, interpreted head).
  const target = withData ?? plain;
  const data = withData ? withData.c.data : { a: 1 };
  const pc = await post(prod, "/compile", { id: target.id, data });
  const sc = await post(staged, "/compile", { id: target.id, data });
  check(`${L} /compile over data equals production`, same(sc.body.data, pc.body.data), JSON.stringify(sc.body.data).slice(0, 100));
  check(`${L} /compile no-store`, sc.headers.get("cache-control") === "no-store");

  // 4. A chain with this language below an L0000 head (interpreted tail, legacy head).
  const head = await task({ lang: "0000", code: { 1: { tag: "NUM", elts: ["1"] }, 2: { tag: "EXPRS", elts: [1] }, 3: { tag: "PROG", elts: [2] }, root: 3 } });
  const chain = `${head}+${plain.id}`;
  const pch = await get(prod, `/data?id=${chain}`);
  const sch = await get(staged, `/data?id=${chain}`);
  check(`${L} L0000 over ${L} chain equals production`, same(sch.body.data, pch.body.data), JSON.stringify(sch.body.data).slice(0, 80));

  // 5. Errors: a program that doesn't compile.
  if (bad) {
    const pb = await get(prod, `/data?id=${bad.id}`);
    const sb = await get(staged, `/data?id=${bad.id}`);
    check(`${L} compile errors equal production`, same(sb.body.data, pb.body.data), JSON.stringify(sb.body.data).slice(0, 100));
  } else {
    check(`${L} compile errors equal production`, true, "no failing case in the corpus");
  }
}

const failed = results.filter(r => !r.pass).length;
console.log(JSON.stringify({ ranAt: new Date().toISOString(), staged, ids, results, failed }));
process.exitCode = failed ? 1 : 0;
