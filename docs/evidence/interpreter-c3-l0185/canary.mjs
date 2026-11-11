// C3 canary: a staged api (tag URL) interpreting L0185, against production (legacy path).
// node docs/evidence/interpreter-c3-l0185/canary.mjs <stagedBase> <stagedRevision>
// docs/c3-l0185-interpreter-plan.md §6 step 6. The L0185 -> L0176 save is deferred until
// l0185r is pinnable (owner, 2026-11-11): Policy refuses it at admission (stage-not-pinnable).
// Reads the staged revision's stage records from Cloud Logging (the operator's gcloud), and
// waits out one fetch's 5-minute expiry, so it takes about 7 minutes.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [staged, revision] = process.argv.slice(2);
if (!staged || !revision) throw new Error("usage: canary.mjs <stagedBase> <stagedRevision>");
const prod = "https://api.graffiticode.org";
const UA = { "user-agent": "Mozilla/5.0 (Macintosh) Chrome/130 Safari/537.36" };
const TTL_S = 300;
const corpus = lang => JSON.parse(readFileSync(new URL(`../../../languages/l${lang}/crates/core/tests/conformance/cases.json`, import.meta.url), "utf8"));
const l0185 = corpus("0185");
const l0184 = corpus("0184");
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cc = r => r.headers.get("cache-control");
const maxAge = header => Number(/^public, max-age=(\d+)$/.exec(header ?? "")?.[1] ?? NaN);
const bounded = (header, limit = TTL_S) => maxAge(header) > 0 && maxAge(header) <= limit;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const generations = suffix => `generations=${encodeURIComponent(suffix)}`;
// The staged revision's stage records for L0185 within [since, until] (it serves only this
// canary), in time order.
const stageRecords = (since, until) => {
  const filter = [
    "resource.type=\"cloud_run_revision\"", "resource.labels.service_name=\"api\"",
    `resource.labels.revision_name="${revision}"`, "textPayload:\"stage {\"", "textPayload:\"\\\"lang\\\":\\\"0185\\\"\"",
    `timestamp>="${new Date(since).toISOString()}"`, `timestamp<="${new Date(until).toISOString()}"`,
  ].join(" AND ");
  const out = execFileSync("gcloud", ["logging", "read", filter, "--project=graffiticode", "--order=asc", "--limit=200", "--format=value(textPayload)"], { encoding: "utf8" });
  return out.split("\n").filter(Boolean).map(line => JSON.parse(line.slice(line.indexOf("{"))));
};
const outcomesIn = (since, until) => stageRecords(since, until).map(r => `${r.stage}:${r.run}:${r.cache}:${r.result?.cacheClass}`);

// The cases: a live fetch (the 16 l0185.graffiticode.org/data cases are the real fetches), a
// fetch that fails (an example.org path, 404 live), and a program that fetches nothing.
const fetching = l0185.filter(c => c.src.includes("l0185.graffiticode.org/data/")).sort((a, b) => a.src.length - b.src.length)[0];
const failing = l0185.find(c => /fetch "https:\/\/example\.org\//.test(c.src));
const pure = l0185.find(c => !/fetch/i.test(c.src) && !c.expect?.errors && c.src.length < 80);
const chart = l0184.filter(c => !c.expect?.errors).find(c => c.src.includes("rows data {}") && c.data);

// 1. L0185 alone, a live fetch: production's data; held until it expires, under the URL
//    /form hands out; no-store without it, or naming rust-1.
const fid = await task({ lang: "0185", code: fetching.ast });
const form = await fetch(`${staged}/form?id=${fid}`, { headers: UA, redirect: "manual" });
const formUrl = new URL(new URL(form.headers.get("location")).searchParams.get("url"));
check("/form data URL names @L0185=interp-1", formUrl.searchParams.get("generations") === "@L0185=interp-1", formUrl.toString());
const started = Date.now();
const p1 = await get(prod, `/data?id=${fid}`);
const s1 = await get(staged, `/data?id=${fid}&${generations("@L0185=interp-1")}`);
check("fetch /data equals production", s1.status === 200 && same(s1.body.data, p1.body.data), JSON.stringify(s1.body.data).slice(0, 100));
check("fetch: bounded public max-age within the TTL", bounded(cc(s1)), cc(s1));
check("fetch: refreshAt names its expiry", typeof s1.body.refreshAt === "string" && Date.parse(s1.body.refreshAt) > started && Date.parse(s1.body.refreshAt) <= Date.now() + TTL_S * 1000, s1.body.refreshAt);
check("fetch, no generations in URL: no-store", cc(await get(staged, `/data?id=${fid}`)) === "no-store");
check("fetch, URL naming rust-1: no-store", cc(await get(staged, `/data?id=${fid}&${generations("@L0185=rust-1")}`)) === "no-store");
check("production (flag off) unchanged: immutable, no metadata", cc(p1).includes("immutable") && !("cache" in p1.body.data) && !("expiresAt" in p1.body.data), cc(p1));
const s2 = await get(staged, `/data?id=${fid}&${generations("@L0185=interp-1")}`);
check("repeat equals first", same(s2.body.data, s1.body.data));
const repeatedAt = Date.now();

// 2. A fetch that fails: the same errors as production, and never held.
const xid = await task({ lang: "0185", code: failing.ast });
const px = await get(prod, `/data?id=${xid}`);
const sx = await get(staged, `/data?id=${xid}&${generations("@L0185=interp-1")}`);
check("failed fetch equals production", same(sx.body.data, px.body.data), JSON.stringify(sx.body.data).slice(0, 100));
check("failed fetch: no-store, even under the current generations", cc(sx) === "no-store", cc(sx));

// 3. A program that fetches nothing: immutable under the current generations.
const nid = await task({ lang: "0185", code: pure.ast });
const pn = await get(prod, `/data?id=${nid}`);
const sn = await get(staged, `/data?id=${nid}&${generations("@L0185=interp-1")}`);
check("no fetch: equals production", same(sn.body.data, pn.body.data));
check("no fetch: immutable", cc(sn)?.includes("immutable"), cc(sn));

// 4. L0184 over L0185: production's chart; the chain is shared until the fetch expires.
const cid = await task({ lang: "0184", code: chart.ast });
const chain = `${cid}+${fid}`;
const chainForm = await fetch(`${staged}/form?id=${chain}`, { headers: UA, redirect: "manual" });
const chainSuffix = new URL(new URL(chainForm.headers.get("location")).searchParams.get("url")).searchParams.get("generations");
check("chain /form names both generations", chainSuffix === "@L0184=interp-1@L0185=interp-1", chainSuffix);
const pc = await get(prod, `/data?id=${chain}`);
const sc = await get(staged, `/data?id=${chain}&${generations(chainSuffix)}`);
check("L0184 over L0185 equals production", sc.status === 200 && same(sc.body.data, pc.body.data), JSON.stringify(sc.body.data).slice(0, 100));
check("L0184 over L0185: bounded public max-age", bounded(cc(sc)), cc(sc));

// 5. The stage cache: the fetch's repeat was a hit; after the expiry, a miss that fetches again.
const wait = started + (TTL_S + 15) * 1000 - Date.now();
console.log(`waiting ${Math.round(wait / 1000)} s for the fetch to expire`);
await sleep(wait);
const expiredAt = Date.now();
const s3 = await get(staged, `/data?id=${fid}&${generations("@L0185=interp-1")}`);
const refetchedAt = Date.now();
check("after expiry: still production's data", same(s3.body.data, p1.body.data));
check("after expiry: a fresh max-age", bounded(cc(s3)), cc(s3));
// Logs arrive with a delay.
await sleep(45_000);
// The first two requests for the fetch (both under the current generations; the no-store reads
// between them run it too): a miss, then hits, every one shared and interpreted.
const early = outcomesIn(started, repeatedAt);
check("stage cache: the first fetch a miss, then hits", early[0] === "s0:interpret:miss:shared" && early.slice(1).some(o => o === "s0:interpret:hit:shared"), JSON.stringify(early));
const late = outcomesIn(expiredAt, refetchedAt);
check("stage cache: a miss after the expiry", same(late, ["s0:interpret:miss:shared"]), JSON.stringify(late));
const all = stageRecords(started, Date.now());
check("every L0185 stage was interpreted, none from rust-1", all.length > 0 && all.every(r => r.run === "interpret"), `${all.length} records, runs ${JSON.stringify([...new Set(all.map(r => r.run))])}`);
check("shared stages carry an expiry", all.filter(r => r.result?.cacheClass === "shared").every(r => Number.isFinite(r.result?.expiresAt)));

const failed = results.filter(r => !r.pass).length;
console.log(JSON.stringify({ ranAt: new Date(started).toISOString(), staged, revision, ids: { fetch: fid, failing: xid, pure: nid, chain }, cases: { fetch: fetching.src, failing: failing.src, pure: pure.src, chart: chart.src }, results, failed }));
process.exitCode = failed ? 1 : 0;
