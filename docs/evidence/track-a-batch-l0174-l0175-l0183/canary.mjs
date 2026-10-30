// Track A canary for a batch switch (L0174, L0175, L0183): a staged api (tag URL) routing each
// language to its lNNNNr, against production (still TypeScript), language by language.
//
//   node docs/evidence/track-a-batch-l0174-l0175-l0183/canary.mjs <stagedBase> [--items <file>]
//
// --items names a JSON file { "0174": ["<item id>", …], … } of real, public items: each item's
// GET /data must be the same on both (anonymous, so only public items answer).
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const staged = args[0];
const itemsFile = args.includes("--items") ? args[args.indexOf("--items") + 1] : null;
const items = itemsFile ? JSON.parse(readFileSync(itemsFile, "utf8")) : {};
const prod = "https://api.graffiticode.org";
const LANGS = ["0174", "0175", "0183"];
const UA = { "user-agent": "Mozilla/5.0 (Macintosh) Chrome/130 Safari/537.36" };
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail: String(detail).slice(0, 200) });
  console.log(`${pass ? "PASS" : "FAIL"} ${name} ${String(detail).slice(0, 160)}`);
};
const post = async (base, path, body) => {
  const r = await fetch(base + path, { method: "POST", headers: { ...UA, "content-type": "application/json", "x-graffiticode-storage-type": "ephemeral" }, body: JSON.stringify(body) });
  return { status: r.status, headers: r.headers, body: await r.json() };
};
const get = async (base, path) => {
  const r = await fetch(base + path, { headers: UA });
  return { status: r.status, headers: r.headers, body: await r.json() };
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const task = async t => (await post(prod, "/task", { task: t })).body.data.id;
const L0000_ONE = { 1: { tag: "NUM", elts: ["1"] }, 2: { tag: "EXPRS", elts: [1] }, 3: { tag: "PROG", elts: [2] }, root: 3 };
const ids = {};

for (const lang of LANGS) {
  const cases = JSON.parse(readFileSync(new URL(`../../../languages/l${lang}/crates/core/tests/conformance/cases.json`, import.meta.url), "utf8"));
  const ok = cases.filter(c => !c.expect?.errors);
  const plain = ok.find(c => !c.data) ?? ok[0];
  const withData = ok.find(c => c.data && typeof c.data === "object" && Object.keys(c.data).length);
  const bad = cases.find(c => c.expect?.errors);
  const id = await task({ lang, code: plain.ast });
  ids[lang] = { plain: id };
  const [p1, s1] = await Promise.all([get(prod, `/data?id=${id}`), get(staged, `/data?id=${id}`)]);
  check(`L${lang} /data equals production`, same(s1.body.data, p1.body.data), JSON.stringify(s1.body.data));
  check(`L${lang} /data immutable (legacy, switched)`, s1.headers.get("cache-control")?.includes("immutable"), s1.headers.get("cache-control"));
  const form = await fetch(`${staged}/form?id=${id}`, { headers: UA, redirect: "manual" });
  const location = new URL(form.headers.get("location"));
  check(`L${lang} /form redirects to l${lang}r`, location.hostname.startsWith(`l${lang}r-`), location.origin);
  check(`L${lang} /form data URL names @L${lang}=rust-1`, new URL(location.searchParams.get("url")).searchParams.get("generations") === `@L${lang}=rust-1`);
  if (withData) {
    const did = await task({ lang, code: withData.ast });
    ids[lang].withData = did;
    const [pc, sc] = await Promise.all([post(prod, "/compile", { id: did, data: withData.data }), post(staged, "/compile", { id: did, data: withData.data })]);
    check(`L${lang} /compile over data equals production`, same(sc.body.data, pc.body.data), JSON.stringify(sc.body.data));
  }
  const [pc2, sc2] = await Promise.all([post(prod, "/compile", { id, data: { a: 1 } }), post(staged, "/compile", { id, data: { a: 1 } })]);
  check(`L${lang} /compile over {a: 1} equals production`, same(sc2.body.data, pc2.body.data), JSON.stringify(sc2.body.data));
  const head = await task({ lang: "0000", code: L0000_ONE });
  const chain = `${head}+${id}`;
  const [pch, sch] = await Promise.all([get(prod, `/data?id=${chain}`), get(staged, `/data?id=${chain}`)]);
  check(`L0000 over L${lang} equals production`, same(sch.body.data, pch.body.data), JSON.stringify(sch.body.data));
  const bid = await task({ lang, code: bad.ast });
  const [pb, sb] = await Promise.all([get(prod, `/data?id=${bid}`), get(staged, `/data?id=${bid}`)]);
  check(`L${lang} compile errors equal production`, same(sb.body.data, pb.body.data), JSON.stringify(sb.body.data));
  for (const item of items[lang] ?? []) {
    const [pi, si] = await Promise.all([get(prod, `/data?id=${item}`), get(staged, `/data?id=${item}`)]);
    check(`L${lang} real item ${item.slice(0, 12)}… equals production`, pi.status === 200 && si.status === 200 && same(si.body.data, pi.body.data), `${pi.status}/${si.status}`);
  }
}

const failed = results.filter(r => !r.pass).length;
console.log(JSON.stringify({ ranAt: new Date().toISOString(), staged, ids, items, results, failed }));
process.exitCode = failed ? 1 : 0;
