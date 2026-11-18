// E3 (owner-approved, alone): one owner capture of the private fixture through
// api-c5a-gate, exactly as scripts/c5a-gate.js's captures phase sends it, under
// the key that phase will use (c5a-gate:<runId>:private), so the later gate run
// finds the same command.
import { readFileSync, writeFileSync } from "node:fs";
import { createCanaryEnv, loadDeployServices, http } from "../../../scripts/lib/canary-env.js";

const dir = new URL(".", import.meta.url).pathname;
const state = JSON.parse(readFileSync(`${dir}state.json`, "utf8"));
const fixtures = JSON.parse(readFileSync(`${dir}../fixtures.json`, "utf8"));
const key = `c5a-gate:${state.runId}:private`;
if (key !== "c5a-gate:53ce1137:private") throw new Error(`unexpected key ${key}`);
const id = fixtures.flags["--private-task"];

const deploy = await loadDeployServices();
const { gcloud, accessToken, idToken } = createCanaryEnv({ uid: "995cc0bc98105563168b7fbee7b1e59a4256331c", authUrl: deploy.api.env.AUTH_URL });
const gateUrl = await gcloud(["run", "services", "describe", "api-c5a-gate", "--region=us-central1", "--format=value(status.url)"]);
const headers = { "X-Serverless-Authorization": `Bearer ${await idToken("console-run@graffiticode-app.iam.gserviceaccount.com", gateUrl)}`, Authorization: await accessToken() };
const submittedAt = new Date().toISOString();
const res = await http({ method: "POST", url: `${gateUrl}/command`, headers, body: { id, idempotencyKey: key } });
const answeredAt = new Date().toISOString();
const d = res.json?.data ?? {};
const record = { gateUrl, task: id, key, submittedAt, answeredAt, status: res.status, commandId: d.commandId ?? null, outcome: d.outcome ?? null, reason: d.reason ?? res.json?.error?.reason ?? null, statusUrl: d.statusUrl ?? null, error: res.status === 200 ? null : JSON.stringify(res.json?.error ?? res.json ?? null).slice(0, 400) };
writeFileSync(`${dir}e3-command.json`, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify(record));
