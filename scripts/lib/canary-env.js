// The canary account's cloud environment, shared by scripts/canary.js and
// scripts/at10-provider.js: gcloud, JSON over HTTP, deploy.json, Cloud Run
// service URLs, ID tokens for service accounts (IAM Credentials API), the
// canary user's access token (Secret Manager `canary-api-key`) and L0176's
// parser. Nothing here runs until a function is called.

import { readFile } from "node:fs/promises";
import { parser } from "@graffiticode/parser";
import { run } from "../../packages/deploy/src/process.js";

export const loadDeployServices = async () =>
  JSON.parse(await readFile(new URL("../../deploy.json", import.meta.url), "utf8")).services;

// Where the api routes a language: { service, tag }. The api's
// BASE_URL_L<lang>, when it is a Cloud Run URL, names the service (a
// language switched to its Rust service, interpreter plan Track A): a service
// URL is `<service>-<hash>-<region>.a.run.app`, and a revision tag's is
// `<tag>---<service>-<hash>-<region>.a.run.app`, which also pins the tag.
// Otherwise it is l<lang>, untagged.
export const languageRoute = (lang, apiEnv = {}) => {
  const url = apiEnv[`BASE_URL_L${lang}`];
  if (typeof url === "string") {
    let host = null;
    try {
      host = new URL(url).hostname;
    } catch {}
    if (host?.endsWith(".run.app")) {
      const [tag, rest] = host.includes("---") ? host.split("---") : [null, host];
      return { service: rest.split("-")[0], tag };
    }
  }
  return { service: `l${lang}`, tag: null };
};

// The revision a route reaches: its tag's revision, or the one serving all
// of the service's traffic.
export const routedRevision = (service, tag) => {
  const traffic = service?.status?.traffic ?? [];
  if (tag) return traffic.find(t => t.tag === tag)?.revisionName ?? null;
  const full = traffic.find(t => t.percent === 100);
  return full?.revisionName ?? (full?.latestRevision ? service.status?.latestReadyRevisionName : null) ?? null;
};

export const http = async ({ method, url, headers = {}, body }) => {
  const res = await fetch(url, { method, headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  // Headers too, lower-cased (the AT-10 cache checks read Cache-Control).
  return { status: res.status, json, headers: Object.fromEntries(res.headers) };
};

export const createCanaryEnv = ({ uid, project = "graffiticode", region = "us-central1", authUrl, apiUrl = () => null }) => {
  const gcloud = async gcloudArgs => String(await run("gcloud", [...gcloudArgs, `--project=${project}`, "--quiet"])).trim();
  const serviceUrl = name => gcloud(["run", "services", "describe", name, `--region=${region}`, "--format=value(status.url)"]);

  const accessToken = async () => {
    const key = await gcloud(["secrets", "versions", "access", "latest", "--secret=canary-api-key"]);
    const res = await http({ method: "POST", url: `${authUrl}/authenticate/api-key`, body: { token: key } });
    const token = res.json?.data?.accessToken;
    if (!token) throw new Error(`canary api key exchange failed: ${res.status}`);
    const verified = await http({ method: "POST", url: `${authUrl}/oauth/verify`, body: { idToken: token } });
    if (verified.json?.data?.uid !== uid) throw new Error(`the canary api key belongs to ${verified.json?.data?.uid ?? "nobody"}, not --uid ${uid}`);
    return token;
  };

  // Minted with the IAM Credentials API under the operator's own credentials,
  // which needs only iam.serviceAccounts.getOpenIdToken (OpenIdTokenCreator).
  // `gcloud auth print-identity-token --impersonate-service-account` first
  // generates an access token for the account, which that role does not allow.
  let operatorToken;
  const idToken = async (account, audience) => {
    operatorToken ??= await gcloud(["auth", "print-access-token"]);
    const res = await http({
      method: "POST",
      url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${account}:generateIdToken`,
      headers: { Authorization: `Bearer ${operatorToken}` },
      body: { audience, includeEmail: true }
    });
    if (!res.json?.token) throw new Error(`minting an ID token for ${account} failed: ${res.status} ${res.json?.error?.message ?? ""}`);
    return res.json.token;
  };

  let lexicon;
  const parse = async src => {
    if (!lexicon) {
      const res = await fetch(`${await apiUrl()}/L0176/lexicon.json`);
      const text = await res.text();
      lexicon = JSON.parse(text.substring(text.indexOf("{")));
    }
    return parser.parse(176, src, lexicon);
  };

  return { gcloud, serviceUrl, http, accessToken, idToken, parse };
};
