// Track A canary for the A2 batch switch (L0003, L0010, L0177, L0178, L0179, L0181, L0185): a staged api (tag URL) routing each
// language to its lNNNNr, against production (still TypeScript), language by language.
//
//   node docs/evidence/track-a2-batch/canary.mjs <stagedBase> [--items <file>]
//
// --items names a JSON file { "0003": ["<item id>", …], … } of real, public items: each item's
// GET /data must be the same on both (anonymous, so only public items answer).
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const staged = args[0];
const itemsFile = args.includes("--items") ? args[args.indexOf("--items") + 1] : null;
const items = itemsFile ? JSON.parse(readFileSync(itemsFile, "utf8")) : {};
const prod = "https://api.graffiticode.org";
const LANGS = ["0003", "0010", "0177", "0178", "0179", "0181", "0185"];
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
// Sorted keys, so two records with the same fields in another order compare equal.
const canonical = v => (Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v);
// The languages whose Rust unwraps the {data, errors} envelope a POST /compile's data task
// delivers (an `upstream-envelope` rule in scripts/lang-parity.allow.json), where TypeScript
// spreads it: production's answer with that envelope unwrapped is what Rust must give.
const rules = JSON.parse(readFileSync(new URL("../../../scripts/lang-parity.allow.json", import.meta.url), "utf8"));
const unwraps = lang => (rules[lang] ?? []).some(r => r.kind === "upstream-envelope");
// A TypeScript result that spread the envelope carries it as a `data` field (L0179 drops the
// envelope's `errors` key while spreading, the others keep it). The envelope's own `errors`
// is not part of the result on either side, so it is left out of the comparison.
const unwrapped = answer => {
  const value = answer?.data;
  if (!value || typeof value !== "object" || Array.isArray(value) || !value.data || typeof value.data !== "object" || Array.isArray(value.data)) return answer;
  const { data: posted, errors: _errors, ...rest } = value;
  return { ...answer, data: { ...rest, ...posted } };
};
const withoutErrorsField = answer => {
  const value = answer?.data;
  if (!value || typeof value !== "object" || Array.isArray(value)) return answer;
  const { errors: _errors, ...rest } = value;
  return { ...answer, data: rest };
};
const overData = (lang, staged, production) => same(staged, production) ||
  (unwraps(lang) && same(canonical(withoutErrorsField(staged)), canonical(withoutErrorsField(unwrapped(production)))));
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
    check(`L${lang} /compile over data equals production${unwraps(lang) ? " (envelope unwrapped)" : ""}`, overData(lang, sc.body.data, pc.body.data), JSON.stringify(sc.body.data));
  }
  const [pc2, sc2] = await Promise.all([post(prod, "/compile", { id, data: { a: 1 } }), post(staged, "/compile", { id, data: { a: 1 } })]);
  check(`L${lang} /compile over {a: 1} equals production${unwraps(lang) ? " (envelope unwrapped)" : ""}`, overData(lang, sc2.body.data, pc2.body.data), JSON.stringify(sc2.body.data));
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
