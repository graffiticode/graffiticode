// ISOLATE-01: a language server's outbound HTTP goes through the compiler
// network's egress proxy. Node's fetch (undici) ignores HTTPS_PROXY, so this
// installs undici's EnvHttpProxyAgent as the global dispatcher whenever
// HTTPS_PROXY or HTTP_PROXY is set; NO_PROXY (the deploy CLI sets it to the
// metadata server only) keeps identity tokens direct. The proxy's CA comes
// from NODE_EXTRA_CA_CERTS, which Node already adds to its roots.
//
// Every language server imports this first, before anything else that might
// make a request:
//
//   import "@graffiticode/l0000/egress";
//
// It is a separate entry point, not part of "@graffiticode/l0000", so that
// importing the language never changes the process's dispatcher.

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

export interface EgressStatus {
  installed: boolean;
  httpsProxy: string | null;
  httpProxy: string | null;
  noProxy: string | null;
}

const MARKER = Symbol.for("graffiticode.egress");

const read = (env: NodeJS.ProcessEnv, name: string): string | null =>
  env[name] || env[name.toLowerCase()] || null;

// Installs the proxy dispatcher if the environment names a proxy, and records
// what it did. Called once on import; tests call it with their own env.
export function installEgress(env: NodeJS.ProcessEnv = process.env): EgressStatus {
  const status: EgressStatus = {
    installed: false,
    httpsProxy: read(env, "HTTPS_PROXY"),
    httpProxy: read(env, "HTTP_PROXY"),
    noProxy: read(env, "NO_PROXY"),
  };
  if (status.httpsProxy || status.httpProxy) {
    setGlobalDispatcher(new EnvHttpProxyAgent({
      httpsProxy: status.httpsProxy ?? undefined,
      httpProxy: status.httpProxy ?? undefined,
      noProxy: status.noProxy ?? "",
    }));
    status.installed = true;
  }
  (globalThis as any)[MARKER] = status;
  return status;
}

// What was installed, for a health check: a server with a proxy configured
// but no dispatcher installed would send its requests direct.
export function egressStatus(): EgressStatus | null {
  return (globalThis as any)[MARKER] ?? null;
}

installEgress();
