// Owner-approved: post the identical private snap program as the verify
// account, which adds that account to this fixture task's ACL only (the api
// dedupes by code hash). Refuses unless the program reparses to exactly the
// stored task's code, and unless the api answers the same task id.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { API, canaryToken, json } from "/private/tmp/claude-501/-Users-jeffdyer-work-graffiticode-graffiticode/3b9960ea-9e37-4af7-b859-610265f8269c/scratchpad/fixtures/lib.mjs";

const dir = new URL(".", import.meta.url).pathname;
const fixtures = JSON.parse(readFileSync(`${dir}../fixtures.json`, "utf8"));
const entry = fixtures.created.privateSnapTask;
const sheet = fixtures.created.privateSheetTask;
const VERIFY = "a35c2c8948de39fd03bb60d9d44259612dc56470";
const op = execFileSync("gcloud", ["auth", "print-access-token"]).toString().trim();
const v = f => f == null ? null : f.stringValue ?? f.booleanValue ?? (f.mapValue ? Object.fromEntries(Object.entries(f.mapValue.fields ?? {}).map(([k, x]) => [k, v(x)])) : null);
const taskDoc = async id => {
  const [doc] = JSON.parse(Buffer.from(id, "base64url").toString()).taskIds;
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/graffiticode/databases/(default)/documents/tasks/${doc}`, { headers: { Authorization: `Bearer ${op}` } });
  const f = (await res.json()).fields;
  return { doc, acls: v(f.acls), count: f.count?.integerValue ?? null };
};
const verifyToken = async () => {
  const key = execFileSync("gcloud", ["secrets", "versions", "access", "latest", "--secret=verify-api-key", "--project=graffiticode", "--quiet"]).toString().trim();
  const res = await fetch("https://auth.graffiticode.org/authenticate/api-key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: key }) });
  return (await res.json())?.data?.accessToken;
};

// The stored code, read as its owner, and the program reparsed.
const canary = await canaryToken();
const stored = (await json(await fetch(`${API}/task?id=${encodeURIComponent(entry.id)}`, { headers: { Authorization: canary } }))).data?.[0];
const { parse } = await import("/private/tmp/claude-501/-Users-jeffdyer-work-graffiticode-graffiticode/3b9960ea-9e37-4af7-b859-610265f8269c/scratchpad/fixtures/sources.mjs");
const code = await parse("0013", entry.program);
if (!stored || stored.lang !== "0013" || !isDeepStrictEqual(stored.code, code)) throw new Error("the reparsed program differs from the stored task; nothing posted");

const before = { snap: await taskDoc(entry.id), sheet: await taskDoc(sheet.id) };
const token = await verifyToken();
if (!token) throw new Error("verify key exchange failed");
const res = await fetch(`${API}/task`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: token, "x-graffiticode-storage-type": "persistent" }, body: JSON.stringify({ task: { lang: "0013", code } }) });
const body = await json(res);
const id = body?.data?.id ?? body?.data;
const after = { snap: await taskDoc(entry.id), sheet: await taskDoc(sheet.id) };
const record = { at: new Date().toISOString(), program: entry.program, postedAs: VERIFY, status: res.status, returnedId: id, sameTask: id === entry.id, before, after };
writeFileSync(`${dir}nonowner-acl.json`, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record, null, 1));
if (id !== entry.id) throw new Error("the api answered a different task id");
