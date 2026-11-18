// Owner-approved: retire only the 13th anonymous capture's command, left
// pending after its rate-limited reserve. Policy's fenced takeover and an empty
// finish, as the gateway (canary-window-c5a covers api-run), through the same
// c5a-gate-fixtures.js code the gate's cleanup uses; then its status and both
// due queries.
import { writeFileSync } from "node:fs";
import { createCanaryEnv, loadDeployServices, http } from "../../../scripts/lib/canary-env.js";
import { retireFixtures, verifyRetired } from "../../../scripts/lib/c5a-gate-fixtures.js";

const ID = "c:399e8095f07904917f3de189a3ab0655610e48120267b2a45211471a46857457";
const GATEWAY = "api-run@graffiticode.iam.gserviceaccount.com";
const dir = new URL(".", import.meta.url).pathname;
const deploy = await loadDeployServices();
const policyUrl = deploy.api.env.POLICY_URL;
const { idToken } = createCanaryEnv({ uid: "995cc0bc98105563168b7fbee7b1e59a4256331c", authUrl: deploy.api.env.AUTH_URL });

const call = async (method, route, body) => {
  const headers = {
    "X-Serverless-Authorization": `Bearer ${await idToken(GATEWAY, policyUrl)}`,
    "X-Caller-Identity": await idToken(GATEWAY, "urn:graffiticode:policy"),
  };
  const res = await http({ method, url: `${policyUrl}${route}`, headers, body });
  if (res.status !== 200 || res.json?.status !== "success") {
    throw Object.assign(new Error(`policy ${method} ${route}: ${res.status} ${res.json?.error?.reason ?? ""}`), { reason: res.json?.error?.reason ?? null });
  }
  return res.json.data;
};
const at = id => `/v1/commands/${encodeURIComponent(id)}`;
const client = {
  get: id => call("GET", at(id)),
  lease: (id, body) => call("POST", `${at(id)}/lease`, body),
  finish: (id, generation) => call("POST", `${at(id)}/finish`, { generation, result: null }),
  due: ({ scopes }) => call("GET", `/v1/commands-due?limit=50&recording=1&repairs=1${scopes ? "&scopes=1" : ""}`),
};

const before = await client.get(ID);
console.log("before", JSON.stringify(before));
if (before.status !== "pending") throw new Error(`expected pending, found ${before.status}`);
const startedAt = new Date().toISOString();
const statuses = await retireFixtures({ client, ids: [ID], worker: "c5a-gate-retire:53ce1137" });
const verified = await verifyRetired({ client, ids: [ID] });
const after = await client.get(ID);
const record = { command: ID, startedAt, finishedAt: new Date().toISOString(), before, statuses, verified, after };
writeFileSync(`${dir}retire-13th.json`, `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify({ statuses, verified, after }));
