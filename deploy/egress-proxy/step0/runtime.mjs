// ISOLATE-01 rollout step 0: the Node egress helper, run in a compiler class behind the egress
// proxy, the way a language server starts: `@graffiticode/l0000/egress` imported first.
//   node runtime.mjs <listed-host> <unlisted-host>
// It shows, through the real helper and global fetch:
//   - an ID token from the metadata server, which NO_PROXY keeps off the proxy;
//   - a listed HTTPS host through the proxy, trusting NODE_EXTRA_CA_CERTS;
//   - an unlisted host refused by the proxy.
// One line, AT11-RUNTIME node <json>; exit 0 only if all three hold.
import "./egress.js";
import { egressStatus } from "./egress.js";

const [listed = "api.graffiticode.org", unlisted = "example.com"] = process.argv.slice(2);
const attempt = async f => { try { return { value: await f() }; } catch (e) { return { error: String(e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e) }; } };

const token = await attempt(async () => {
  const res = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=urn%3Agraffiticode%3Aat11", { headers: { "Metadata-Flavor": "Google" } });
  return res.ok && (await res.text()).split(".").length === 3;
});
const listedRes = await attempt(async () => (await fetch(`https://${listed}/`)).status);
const unlistedRes = await attempt(async () => (await fetch(`https://${unlisted}/`)).status);

const status = egressStatus();
const passed = status?.installed === true && token.value === true && listedRes.value < 500 && unlistedRes.error !== undefined;
console.log(`AT11-RUNTIME node ${JSON.stringify({ passed, egress: status, idToken: token, listed: { host: listed, ...listedRes }, unlisted: { host: unlisted, ...unlistedRes } })}`);
process.exit(passed ? 0 : 1);
