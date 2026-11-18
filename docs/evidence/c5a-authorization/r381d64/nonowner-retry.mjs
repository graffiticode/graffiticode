// Owner-approved: only the non-owner case again, now that the verify account
// can read the private snap task: its /command through api-c5a-gate under the
// run's key, as scripts/c5a-gate.js sends it. The earlier observation and the
// api's task-ACL 404 are kept, separately, in the state's history.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createCanaryEnv, loadDeployServices, http } from "../../../scripts/lib/canary-env.js";

const dir = new URL(".", import.meta.url).pathname;
const statePath = `${dir}state.json`;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const fixtures = JSON.parse(readFileSync(`${dir}../fixtures.json`, "utf8"));
const key = `c5a-gate:${state.runId}:non-owner`;
const deploy = await loadDeployServices();
const { gcloud, idToken } = createCanaryEnv({ uid: "995cc0bc98105563168b7fbee7b1e59a4256331c", authUrl: deploy.api.env.AUTH_URL });

state.observationHistory ??= {};
state.observationHistory.privateNonOwner ??= [];
if (!state.observationHistory.privateNonOwner.some(h => h.source === "captures")) {
  state.observationHistory.privateNonOwner.push({
    source: "captures", at: "2026-11-18T04:20:05.174Z", value: state.observations.privateNonOwner,
    note: "api-c5a-gate answered 404 (75-byte body) from its own task lookup: the non-owner couldn't read the private snap task; Policy saw nothing",
  });
}
state.observations.privateNonOwnerTaskAcl = { status: 404, at: "2026-11-18T04:20:05.174Z", where: "api-c5a-gate task lookup, before Policy", taskAclUids: ["995cc0bc98105563168b7fbee7b1e59a4256331c"] };

const key0 = execFileSync("gcloud", ["secrets", "versions", "access", "latest", "--secret=verify-api-key", "--project=graffiticode", "--quiet"]).toString().trim();
const auth = await http({ method: "POST", url: `${deploy.api.env.AUTH_URL}/authenticate/api-key`, body: { token: key0 } });
const nonOwner = auth.json?.data?.accessToken;
if (!nonOwner) throw new Error("verify key exchange failed");
const gateUrl = await gcloud(["run", "services", "describe", "api-c5a-gate", "--region=us-central1", "--format=value(status.url)"]);
const headers = { "X-Serverless-Authorization": `Bearer ${await idToken("console-run@graffiticode-app.iam.gserviceaccount.com", gateUrl)}`, Authorization: nonOwner };
const at = new Date().toISOString();
const res = await http({ method: "POST", url: `${gateUrl}/command`, headers, body: { id: fixtures.flags["--private-task"], idempotencyKey: key } });
const d = res.json?.data ?? {};
const answer = { status: res.status, commandId: d.commandId ?? null, outcome: d.outcome ?? null, reason: d.reason ?? res.json?.error?.reason ?? null };
const value = { outcome: answer.outcome, reason: answer.reason };
state.observations.privateNonOwner = value;
state.observationHistory.privateNonOwner.push({ source: "nonowner-retry", at, key, answer, value });
writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
console.log(JSON.stringify({ at, key, answer }));
