// Fresh console-route refusals (plan: "Step 27's policy-run probe evidence,
// and a fresh unauthenticated and wrong-audience probe"): POST the console's
// item-authority route with no identity, and as api-run (minted through the
// IAM Credentials API under canary-window-c5a) with the route's audience, and
// as console-run with a wrong audience. Each must be 403. Tokens never printed.
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const URL_ = "https://console-cfdwwd7ega-uc.a.run.app/api/internal/item-authority";
const AUD = "https://console.graffiticode.org/api/internal/item-authority";
const op = execFileSync("gcloud", ["auth", "print-access-token"]).toString().trim();
const mint = async (sa, audience) => {
  const r = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${sa}:generateIdToken`, { method: "POST", headers: { Authorization: `Bearer ${op}`, "Content-Type": "application/json" }, body: JSON.stringify({ audience, includeEmail: true }) });
  if (!r.ok) throw new Error(`mint ${sa}: ${r.status}`);
  return (await r.json()).token;
};
const post = async (label, caller, headers) => {
  const r = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ itemId: "3UItj2wroJ80BnHXkpR9" }) });
  return { label, caller, status: r.status, cacheControl: r.headers.get("cache-control"), at: new Date().toISOString() };
};
const probes = [
  await post("unauthenticated", "anonymous", {}),
  await post("api-run, route audience", "api-run@graffiticode.iam.gserviceaccount.com", { Authorization: `Bearer ${await mint("api-run@graffiticode.iam.gserviceaccount.com", AUD)}` }),
  await post("console-run, wrong audience", "console-run@graffiticode-app.iam.gserviceaccount.com", { Authorization: `Bearer ${await mint("console-run@graffiticode-app.iam.gserviceaccount.com", "https://wrong.example/item-authority")}` }),
];
writeFileSync(new URL("./fresh.json", import.meta.url), `${JSON.stringify({ url: URL_, audience: AUD, probes }, null, 2)}\n`);
console.log(JSON.stringify(probes));
