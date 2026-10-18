// ISOLATE-01 rollout step 0: L0013's headless Chrome behind the egress proxy, launched
// through L0013's own helper (languages/l0013/packages/core/src/chrome-egress.ts), the way
// snap.ts launches it: the proxy flag, and a HOME whose NSS database trusts the proxy's CA.
//   node --experimental-strip-types chrome.mjs <listed-url> <unlisted-url>
// It loads a listed page (it must render: the terminated TLS is trusted) and an unlisted one
// (it must fail at the proxy). One line, AT11-RUNTIME chrome <json>.
import { execFileSync } from "node:child_process";
import { prepareChromeEgress } from "./chrome-egress.ts";

const [listed = "https://api.graffiticode.org/", unlisted = "https://example.com/"] = process.argv.slice(2);
const launch = prepareChromeEgress();
const load = url => {
  try {
    const dom = execFileSync("/usr/bin/chromium-browser", ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
      "--virtual-time-budget=5000", ...launch.args, "--dump-dom", url], { env: launch.env, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
    return { bytes: dom.length, dom: dom.slice(0, 300), chromeError: /chrome-error|ERR_[A-Z_]+|NET::|Your connection is not private/.exec(dom)?.[0] ?? null };
  } catch (e) {
    return { error: String(e.stderr ?? e.message).match(/ERR_[A-Z_]+/)?.[0] ?? String(e.message).slice(0, 200) };
  }
};
const ok = load(listed);
const refused = load(unlisted);
launch.cleanup?.();
// A rendered page with a body and no Chrome error or certificate interstitial; the unlisted
// load must yield nothing or an error.
const passed = ok.bytes > 0 && /<body/i.test(ok.dom ?? "") && !ok.chromeError && !ok.error && (Boolean(refused.error) || Boolean(refused.chromeError) || !refused.bytes);
console.log(`AT11-RUNTIME chrome ${JSON.stringify({ passed, proxyArgs: launch.args, listed: { url: listed, ...ok }, unlisted: { url: unlisted, ...refused } })}`);
process.exit(passed ? 0 : 1);
