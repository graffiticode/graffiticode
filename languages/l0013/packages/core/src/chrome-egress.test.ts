import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CA_NICKNAME, chromeEgress, nssCommands, pacScript, pacUrl, prepareChromeEgress } from "./chrome-egress.js";

describe("chromeEgress", () => {
  it("adds nothing without a proxy", () => {
    expect(chromeEgress({})).toEqual({ args: [] });
    expect(chromeEgress({ HTTPS_PROXY: " ", NODE_EXTRA_CA_CERTS: "/ca.pem" })).toEqual({ args: [] });
  });

  it("sets the proxy server and the CA under HTTPS_PROXY", () => {
    expect(chromeEgress({ HTTPS_PROXY: "http://10.8.0.2:3128", NODE_EXTRA_CA_CERTS: "/etc/egress/ca.pem" })).toEqual({
      args: [`--proxy-pac-url=${pacUrl("http://10.8.0.2:3128")}`],
      ca: "/etc/egress/ca.pem",
    });
    expect(chromeEgress({ https_proxy: "http://p:3128", SSL_CERT_FILE: "/ca.pem" })).toEqual({
      args: [`--proxy-pac-url=${pacUrl("http://p:3128")}`],
      ca: "/ca.pem",
    });
  });

  it("refuses a proxy without a CA", () => {
    expect(() => chromeEgress({ HTTPS_PROXY: "http://10.8.0.2:3128" })).toThrow(/without NODE_EXTRA_CA_CERTS/);
  });
});

describe("prepareChromeEgress", () => {
  it("builds an NSS database trusting the CA, and points HOME at it", () => {
    const calls: string[][] = [];
    const launch = prepareChromeEgress({ HTTPS_PROXY: "http://p:3128", NODE_EXTRA_CA_CERTS: "/ca.pem" }, (file, args) => {
      calls.push([file, ...args]);
    });
    const home = launch.env.HOME;
    expect(launch.args).toEqual([`--proxy-pac-url=${pacUrl("http://p:3128")}`]);
    expect(calls).toEqual(nssCommands(`${home}/.pki/nssdb`, "/ca.pem"));
    expect(calls[1]).toEqual(["certutil", "-A", "-d", `sql:${home}/.pki/nssdb`, "-n", CA_NICKNAME, "-t", "C,,", "-i", "/ca.pem"]);
    launch.cleanup();
    expect(existsSync(home)).toBe(false);
  });

  it("fails closed without certutil", () => {
    const missing = () => {
      throw Object.assign(new Error("spawn certutil ENOENT"), { code: "ENOENT" });
    };
    expect(() => prepareChromeEgress({ HTTPS_PROXY: "http://p:3128", NODE_EXTRA_CA_CERTS: "/ca.pem" }, missing)).toThrow(
      /certutil not found/,
    );
  });

  it("runs nothing without a proxy", () => {
    const launch = prepareChromeEgress({}, () => {
      throw new Error("should not run");
    });
    expect(launch).toMatchObject({ args: [] });
    expect(launch.env).toBeUndefined();
  });
});

describe("Chrome's background traffic", () => {
  it("is switched off for every capture (2026-10-20)", async () => {
    const { QUIET_ARGS } = await import("./chrome-egress.js");
    for (const a of ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run"]) expect(QUIET_ARGS).toContain(a);
    expect(QUIET_ARGS.find((a) => a.startsWith("--disable-features="))).toMatch(/AutofillServerCommunication/);
  });
});

describe("Chrome's PAC script", () => {
  it("sends Graffiticode hosts to the proxy, loopback direct, and the rest to a closed port", () => {
    const FindProxyForURL = new Function("dnsDomainIs", `${pacScript("http://10.8.0.2:3128")}; return FindProxyForURL;`)((h: string, d: string) => h.endsWith(d));
    expect(FindProxyForURL("https://api.graffiticode.org/form", "api.graffiticode.org")).toBe("PROXY 10.8.0.2:3128");
    expect(FindProxyForURL("https://l0179.graffiticode.org/a.js", "l0179.graffiticode.org")).toBe("PROXY 10.8.0.2:3128");
    expect(FindProxyForURL("http://127.0.0.1:9222/", "127.0.0.1")).toBe("DIRECT");
    for (const h of ["accounts.google.com", "www.google.com", "items.learnosity.com", "graffiticode.org.evil.example", "evilgraffiticode.org"]) {
      expect(FindProxyForURL(`https://${h}/`, h)).toBe("PROXY 127.0.0.1:9");
    }
  });
});
