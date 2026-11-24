// Approved 2026-11-24 (non-owner only, run d1ca6da0): the verify account as
// the non-owner. The key and its token stay in memory: neither is printed,
// written, or passed on argv; the token reaches the runner only through its
// environment (C5D_NON_OWNER_TOKEN). Prints only checks and the runner's
// own output, which never prints the token.
//   node non-owner-run.mjs <runner dir> <evidence dir> <private task>
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const [runnerDir, evidenceDir, privateTask] = process.argv.slice(2);
const AUTH = "https://auth-sja7fatcta-uc.a.run.app"; // api-c5d-drive's AUTH_URL (deploy.json)
const API = "https://api.graffiticode.org";
const UID = "a35c2c8948de39fd03bb60d9d44259612dc56470";
const CANARY = "995cc0bc98105563168b7fbee7b1e59a4256331c";
const ITEM = "7vwaCAIyMNCJEzgIfyYY";
const log = (...a) => console.log(new Date().toISOString(), ...a);
const fail = m => { log(`STOP: ${m}`); process.exit(3); };
const post = async (url, body) => { const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };

// 1. Exchange and verify, in memory.
const key = execFileSync("gcloud", ["secrets", "versions", "access", "latest", "--secret=verify-api-key", "--project=graffiticode", "--quiet"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
const ex = await post(`${AUTH}/authenticate/api-key`, { token: key });
const token = ex.json?.data?.accessToken;
log(`1a exchange: ${ex.status}, token ${token ? "received" : "absent"}`);
if (!token) fail("api-key exchange failed");
const ver = await post(`${AUTH}/oauth/verify`, { idToken: token });
const uid = ver.json?.data?.uid;
log(`1b verify: ${ver.status}, uid ${uid}`);
if (uid !== UID) fail(`the token is ${uid ?? "nobody"}'s, not ${UID}`);

// 2. Task read access, and still a non-owner of the fixture item.
const [taskDoc] = JSON.parse(Buffer.from(privateTask, "base64url").toString()).taskIds;
const op = execFileSync("gcloud", ["auth", "print-access-token"]).toString().trim();
const fs = (project, path) => fetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${path}`, { headers: { Authorization: `Bearer ${op}` } });
const task = await (await fs("graffiticode", `tasks/${taskDoc}`)).json();
const uids = Object.keys(task.fields?.acls?.mapValue?.fields?.uids?.mapValue?.fields ?? {});
const isPublicTask = task.fields?.acls?.mapValue?.fields?.public?.booleanValue;
log(`2a task ${taskDoc} acl: uids [${uids.join(", ")}], public ${isPublicTask}`);
if (!uids.includes(UID) || isPublicTask !== false) fail("the verify account isn't on the private task's ACL");
const read = await fetch(`${API}/task?id=${encodeURIComponent(privateTask)}`, { headers: { Authorization: token } });
const readBody = await read.json().catch(() => null);
const readTask = Array.isArray(readBody?.data) ? readBody.data[0] : null;
log(`2b task read as the verify account: ${read.status}, lang ${readTask?.lang ?? "-"}`);
if (read.status !== 200 || readTask?.lang !== "0013") fail("the verify account can't read the private snap task");
const owner = (await fs("graffiticode-app", `users/${CANARY}/items/${ITEM}`)).status;
const mine = (await fs("graffiticode-app", `users/${UID}/items/${ITEM}`)).status;
log(`2c item ${ITEM}: canary's ${owner}, verify account's ${mine}`);
if (owner !== 200 || mine !== 404) fail("the item's ownership isn't the canary's alone");
writeFileSync(`${evidenceDir}/non-owner-preconditions.json`, `${JSON.stringify({ at: new Date().toISOString(), uid, taskDoc, taskAclUids: uids, taskPublic: isPublicTask, taskReadStatus: read.status, taskReadLang: readTask?.lang, itemCanary: owner, itemVerify: mine }, null, 2)}\n`);

// 3. The runner, the token only in its environment.
const r = spawnSync(process.execPath, ["scripts/c5d-drive.js", "--phase", "non-owner", "--run", "d1ca6da0", "--dir", `${evidenceDir}/../drive`, "--private-task", privateTask, "--non-owner-uid", UID],
  { cwd: runnerDir, env: { ...process.env, C5D_NON_OWNER_TOKEN: token }, encoding: "utf8" });
const out = `${r.stdout}${r.stderr}`;
if (out.includes(token) || out.includes(key)) fail("the runner's output contains a credential; not shown");
process.stdout.write(out);
log(`runner exit ${r.status}`);
process.exit(r.status ?? 1);
