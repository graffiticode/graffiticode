// Headless Chrome behind the ISOLATE-01 egress proxy. The global undici dispatcher
// (@graffiticode/l0000/egress) doesn't reach Chrome: it needs the proxy on its command line, and
// it trusts only its own NSS database, not NODE_EXTRA_CA_CERTS. With HTTPS_PROXY set, every
// launch goes through prepareChromeEgress.
//
// Inventory: the pages Chrome loads are the api's /form (GRAFFITICODE_API_URL, by default
// api.graffiticode.org) and whatever that form loads in turn (the language's view bundle, served
// by the api). Loopback stays direct, by Chrome's own implicit bypass.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CA_NICKNAME = "isolate01-egress-ca";

// Chrome's own background traffic, off: sign-in, component updates, sync, autofill, its
// connectivity and default-search checks. A capture needs none of it, and through the egress
// proxy each request is a refusal in the log (accounts.google.com, update.googleapis.com,
// www.google.com, start.duckduckgo.com and others on 2026-10-20).
export const QUIET_ARGS = [
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-default-apps",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-domain-reliability",
  "--disable-client-side-phishing-detection",
  "--disable-features=OptimizationHints,Translate,MediaRouter,AutofillServerCommunication",
];

type Env = Record<string, string | undefined>;

export interface ChromeEgress {
  args: string[];
  ca?: string;
}

const set = (env: Env, name: string) => (env[name] && env[name].trim() ? env[name] : undefined);

// The proxy arguments and CA from the environment. No proxy: no arguments. A proxy without a CA is
// refused: the proxy terminates TLS with a private CA, so Chrome could reach nothing.
export function chromeEgress(env: Env = process.env): ChromeEgress {
  const proxy = set(env, "HTTPS_PROXY") ?? set(env, "https_proxy");
  if (!proxy) return { args: [] };
  const ca = set(env, "NODE_EXTRA_CA_CERTS") ?? set(env, "SSL_CERT_FILE");
  if (!ca) {
    throw new Error("HTTPS_PROXY is set without NODE_EXTRA_CA_CERTS or SSL_CERT_FILE: Chrome can't trust the egress proxy");
  }
  return { args: [`--proxy-server=${proxy}`], ca };
}

// The certutil invocations that make an NSS database at `nssdb` trusting `ca` for TLS.
export function nssCommands(nssdb: string, ca: string): string[][] {
  const db = `sql:${nssdb}`;
  return [
    ["certutil", "-N", "-d", db, "--empty-password"],
    ["certutil", "-A", "-d", db, "-n", CA_NICKNAME, "-t", "C,,", "-i", ca],
  ];
}

type Exec = (file: string, args: string[]) => void;
const run: Exec = (file, args) => {
  execFileSync(file, args, { stdio: ["ignore", "ignore", "pipe"] });
};

export interface PreparedLaunch {
  args: string[];
  env?: Env;
  cleanup: () => void;
}

// What puppeteer.launch adds: the proxy arguments, and a HOME whose $HOME/.pki/nssdb (where
// Chrome on Linux looks) trusts the CA. Fails closed: without certutil, a proxied launch is an
// error, never a launch that can't verify anything.
export function prepareChromeEgress(env: Env = process.env, exec: Exec = run): PreparedLaunch {
  const egress = chromeEgress(env);
  if (!egress.ca) return { args: egress.args, cleanup: () => {} };
  const home = mkdtempSync(join(tmpdir(), "l0013-chrome-home-"));
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  try {
    const nssdb = join(home, ".pki", "nssdb");
    mkdirSync(nssdb, { recursive: true });
    for (const [file, ...args] of nssCommands(nssdb, egress.ca)) {
      try {
        exec(file, args);
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          throw new Error("certutil not found: the image needs NSS tools (nss-tools) to trust the egress proxy's CA", { cause: err });
        }
        throw new Error(`certutil ${args[0]} failed: ${String(err?.stderr ?? err?.message ?? err).trim()}`, { cause: err });
      }
    }
  } catch (err) {
    cleanup();
    throw err;
  }
  return { args: egress.args, env: { ...env, HOME: home }, cleanup };
}
