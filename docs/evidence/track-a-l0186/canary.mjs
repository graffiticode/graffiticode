// Track A canary for L0186: a staged api (tag URL) routing L0186 to l0186r, against production (l0186).
// node docs/evidence/track-a-l0186/canary.mjs <stagedBase>
import { readFileSync } from "node:fs";
const [staged] = process.argv.slice(2);
const prod = "https://api.graffiticode.org";
const UA = { "user-agent": "Mozilla/5.0 (Macintosh) Chrome/130 Safari/537.36" };
const cases = JSON.parse(readFileSync(new URL("../../../languages/l0186/crates/core/tests/conformance/cases.json", import.meta.url), "utf8"));
const ok = cases.filter(c => !c.expect?.errors);
const valueCase = ok.find(c => !c.src.includes("data") && !c.src.includes("get-var"));
// A board that compiles against upstream data (L0186 never lets it reach the board).
const planCase = ok.find(c => c.data && Object.keys(c.data).length) ?? valueCase;
const results = [];
const check = (name, pass, detail = "") => { results.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"} ${name} ${detail}`); };
const post = async (base, path, body) => {
  const r = await fetch(base + path, { method: "POST", headers: { ...UA, "content-type": "application/json", "x-graffiticode-storage-type": "ephemeral" }, body: JSON.stringify(body) });
  return { status: r.status, headers: r.headers, body: await r.json() };
};
const get = async (base, path) => {
  const r = await fetch(base + path, { headers: UA });
  return { status: r.status, headers: r.headers, body: await r.json() };
};
const task = async t => (await post(prod, "/task", { task: t })).body.data.id;

// 1. A value-model chart through /data: same data as production; repeated (stage cache).
const vid = await task({ lang: "0186", code: valueCase.ast });
const p1 = await get(prod, `/data?id=${vid}`);
const s1 = await get(staged, `/data?id=${vid}`);
const s2 = await get(staged, `/data?id=${vid}`);
check("board /data equals production", JSON.stringify(s1.body.data) === JSON.stringify(p1.body.data));
check("repeat equals first", JSON.stringify(s2.body.data) === JSON.stringify(s1.body.data));
check("legacy (switched) chain, no generations in URL: immutable as before", s1.headers.get("cache-control")?.includes("immutable"), s1.headers.get("cache-control"));
const named = await get(staged, `/data?id=${vid}&generations=${encodeURIComponent("@L0186=rust-1")}`);
check("URL naming rust-1: immutable", named.headers.get("cache-control")?.includes("immutable"), named.headers.get("cache-control"));
const old = await get(staged, `/data?id=${vid}&generations=${encodeURIComponent("@L0186=old")}`);
check("URL naming another generation: no-store", old.headers.get("cache-control") === "no-store", old.headers.get("cache-control"));

// 2. /form on the staged api names the new generation.
const form = await fetch(`${staged}/form?id=${vid}`, { headers: UA, redirect: "manual" });
const dataUrl = new URL(form.headers.get("location")).searchParams.get("url");
check("/form data URL names @L0186=rust-1", new URL(dataUrl).searchParams.get("generations") === "@L0186=rust-1", dataUrl);
check("/form redirects to l0186r", new URL(form.headers.get("location")).hostname.startsWith("l0186r-"), form.headers.get("location"));

// 3. POST /compile: the item over its L0000 data task.
const pid = await task({ lang: "0186", code: planCase.ast });
const pc = await post(prod, "/compile", { id: pid, data: planCase.data });
const sc = await post(staged, "/compile", { id: pid, data: planCase.data });
check("board over data: /compile equals production", JSON.stringify(sc.body.data) === JSON.stringify(pc.body.data), JSON.stringify(sc.body.data).slice(0, 120));
check("/compile no-store", sc.headers.get("cache-control") === "no-store");
const sc2 = await post(staged, "/compile", { id: vid, data: { a: 1 } });
const pc2 = await post(prod, "/compile", { id: vid, data: { a: 1 } });
check("board over other data: /compile equals production", JSON.stringify(sc2.body.data) === JSON.stringify(pc2.body.data));

// 4. A chain with L0186 below an L0000 head.
const head = await task({ lang: "0000", code: { 1: { tag: "NUM", elts: ["1"] }, 2: { tag: "EXPRS", elts: [1] }, 3: { tag: "PROG", elts: [2] }, root: 3 } });
const chain = `${head}+${vid}`;
const pch = await get(prod, `/data?id=${chain}`);
const sch = await get(staged, `/data?id=${chain}`);
check("L0000 over L0186 chain equals production", JSON.stringify(sch.body.data) === JSON.stringify(pch.body.data), JSON.stringify(sch.body.data).slice(0, 80));

// 5. Errors: a program that doesn't compile.
const bad = cases.find(c => c.expect?.errors);
const bid = await task({ lang: "0186", code: bad.ast });
const pb = await get(prod, `/data?id=${bid}`);
const sb = await get(staged, `/data?id=${bid}`);
check("compile errors equal production", JSON.stringify(sb.body.data) === JSON.stringify(pb.body.data), JSON.stringify(sb.body.data).slice(0, 100));

const failed = results.filter(r => !r.pass).length;
console.log(JSON.stringify({ ranAt: new Date().toISOString(), staged, ids: { value: vid, plan: pid, chain, errors: bid }, results, failed }));
process.exitCode = failed ? 1 : 0;
