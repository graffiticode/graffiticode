// SPDX-License-Identifier: MIT
/**
 * The guarded fetcher L0185's `fetch` uses in the language server. Source text controls the URL,
 * so this is the SSRF boundary: only public https addresses, checked where the socket connects.
 *
 * - The URL: https only, port 443, no credentials, no local/internal host names.
 * - Every address the host resolves to must be public unicast — checked INSIDE the socket's own
 *   lookup, so the connection uses exactly the address that passed (no DNS-rebinding window).
 *   IPv4-mapped IPv6 is unwrapped; private, loopback, link-local (the metadata server), CGNAT,
 *   multicast, reserved, NAT64/6to4/Teredo and other non-unicast ranges are refused.
 * - Redirects are followed by hand, at most 3, each checked like the original URL.
 * - 10 s per URL (5 s to connect); 5 MB of DECODED body, counted while streaming.
 * - GET with fixed headers; source text sets none. A 60 s in-process cache, and in-flight
 *   requests shared — safe because only public data is ever fetched.
 *
 * Messages never echo a resolved address.
 */
import { lookup as dnsLookup } from "node:dns";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import ipaddr from "ipaddr.js";
import { Agent, request } from "undici";
import type { Fetcher, FetchResult } from "@graffiticode/l0185";

export interface GuardOptions {
  timeoutMs?: number;
  connectTimeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  cacheTtlMs?: number;
  /** TEST ONLY: allow these protocols (default https only). Source text can never reach this. */
  protocols?: string[];
  /** TEST ONLY: resolve host names (default: the system resolver). */
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** TEST ONLY: which addresses may be connected to (default: public unicast). */
  isAllowedAddress?: (address: string) => boolean;
}

const DENIED_HOSTS = [/^localhost$/i, /\.localhost$/i, /\.local$/i, /\.internal$/i, /^metadata\.google\.internal$/i];

/** Public unicast only. Anything ipaddr.js does not class as `unicast` is refused. */
export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

const blocked = (url: string) =>
  new Error(`fetch: ${JSON.stringify(url)} cannot be fetched. Only public https:// addresses are allowed (no private, local or internal hosts), e.g. fetch "https://example.org/data.csv".`);

class BlockedAddress extends Error {}

/** Check a URL before connecting: scheme, port, credentials, host name, literal IPs. */
export function checkUrl(raw: string, opts: GuardOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`fetch: ${JSON.stringify(raw)} is not a URL. Write a full https address, e.g. fetch "https://example.org/data.json".`);
  }
  const protocols = opts.protocols ?? ["https:"];
  const allowed = opts.isAllowedAddress ?? isPublicAddress;
  if (!protocols.includes(url.protocol) || url.username || url.password) throw blocked(raw);
  if (url.protocol === "https:" && url.port && url.port !== "443") throw blocked(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (DENIED_HOSTS.some((re) => re.test(host))) throw blocked(raw);
  if (ipaddr.isValid(host) && !allowed(host)) throw blocked(raw);
  return url;
}

const systemResolve = (host: string) =>
  new Promise<{ address: string; family: number }[]>((resolve, reject) =>
    dnsLookup(host, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs as any))),
  );

/** Decode a body by its content-encoding, refusing past `maxBytes` of decoded output. */
async function readCapped(body: Readable, encoding: string, maxBytes: number, url: string): Promise<string> {
  const enc = encoding.toLowerCase().trim();
  const decoder =
    enc === "gzip" || enc === "x-gzip" ? zlib.createGunzip() : enc === "deflate" ? zlib.createInflate() : enc === "br" ? zlib.createBrotliDecompress() : null;
  const stream: Readable = decoder ? body.pipe(decoder) : body;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) {
      body.destroy();
      decoder?.destroy();
      throw new Error(`fetch: ${JSON.stringify(url)} is larger than ${Math.round(maxBytes / 1_000_000)} MB.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function makeGuardedFetcher(opts: GuardOptions = {}): Fetcher {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 5_000_000;
  const maxRedirects = opts.maxRedirects ?? 3;
  const cacheTtlMs = opts.cacheTtlMs ?? 60_000;
  const resolve = opts.resolve ?? systemResolve;
  const allowed = opts.isAllowedAddress ?? isPublicAddress;

  const agent = new Agent({
    connect: {
      timeout: opts.connectTimeoutMs ?? 5_000,
      // Every resolved address must pass; the socket then connects to one that did.
      lookup: (hostname: string, lookupOpts: any, cb: any) => {
        resolve(hostname).then(
          (addrs) => {
            if (!addrs.length) return cb(new Error(`ENOTFOUND ${hostname}`));
            if (addrs.some((a) => !allowed(a.address))) return cb(new BlockedAddress("blocked"));
            if (lookupOpts && lookupOpts.all) cb(null, addrs);
            else cb(null, addrs[0].address, addrs[0].family);
          },
          (err) => cb(err),
        );
      },
    } as any,
  });

  const once = async (raw: string): Promise<FetchResult> => {
    let current = raw;
    const signal = AbortSignal.timeout(timeoutMs);
    for (let hop = 0; ; hop++) {
      checkUrl(current, opts);
      let res;
      try {
        res = await request(current, {
          method: "GET",
          dispatcher: agent,
          signal,
          headers: {
            accept: "application/json, text/csv;q=0.9, text/plain;q=0.5, */*;q=0.1",
            "accept-encoding": "gzip, deflate, br",
            "user-agent": "Graffiticode-L0185/1",
          },
        });
      } catch (e: any) {
        if (e instanceof BlockedAddress || e?.cause instanceof BlockedAddress) throw blocked(raw);
        if (signal.aborted || e?.name === "TimeoutError" || e?.name === "AbortError") {
          throw new Error(`fetch: fetching ${JSON.stringify(raw)} timed out after ${Math.round(timeoutMs / 1000)} s.`, { cause: e });
        }
        throw new Error(`fetch: fetching ${JSON.stringify(raw)} failed: ${e?.code === "ENOTFOUND" || /ENOTFOUND/.test(e?.message) ? "no such host" : "could not connect"}.`, { cause: e });
      }
      const location = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && location) {
        await res.body.dump();
        if (hop >= maxRedirects) throw new Error(`fetch: ${JSON.stringify(raw)} redirected more than ${maxRedirects} times.`);
        current = new URL(String(location), current).toString();
        continue;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        await res.body.dump();
        throw new Error(`fetch: fetching ${JSON.stringify(raw)} failed: the server answered ${res.statusCode}.`);
      }
      const length = Number(res.headers["content-length"] ?? 0);
      if (length > maxBytes) {
        await res.body.dump();
        throw new Error(`fetch: ${JSON.stringify(raw)} is larger than ${Math.round(maxBytes / 1_000_000)} MB.`);
      }
      try {
        const text = await readCapped(res.body as unknown as Readable, String(res.headers["content-encoding"] ?? ""), maxBytes, raw);
        return { text, contentType: String(res.headers["content-type"] ?? "") };
      } catch (e: any) {
        if (signal.aborted) throw new Error(`fetch: fetching ${JSON.stringify(raw)} timed out after ${Math.round(timeoutMs / 1000)} s.`, { cause: e });
        throw e;
      }
    }
  };

  const cache = new Map<string, { at: number; result: Promise<FetchResult> }>();
  return (url: string) => {
    const now = Date.now();
    const hit = cache.get(url);
    if (hit && now - hit.at < cacheTtlMs) return hit.result;
    const result = once(url);
    cache.set(url, { at: now, result });
    // A failure is not cached; and the cache stays small.
    result.catch(() => cache.delete(url));
    if (cache.size > 200) cache.delete(cache.keys().next().value as string);
    return result;
  };
}
