import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CA_NICKNAME, chromeEgress, nssCommands, prepareChromeEgress } from "./chrome-egress.js";

describe("chromeEgress", () => {
  it("adds nothing without a proxy", () => {
    expect(chromeEgress({})).toEqual({ args: [] });
    expect(chromeEgress({ HTTPS_PROXY: " ", NODE_EXTRA_CA_CERTS: "/ca.pem" })).toEqual({ args: [] });
  });

  it("sets the proxy server and the CA under HTTPS_PROXY", () => {
    expect(chromeEgress({ HTTPS_PROXY: "http://10.8.0.2:3128", NODE_EXTRA_CA_CERTS: "/etc/egress/ca.pem" })).toEqual({
      args: ["--proxy-server=http://10.8.0.2:3128"],
      ca: "/etc/egress/ca.pem",
    });
    expect(chromeEgress({ https_proxy: "http://p:3128", SSL_CERT_FILE: "/ca.pem" })).toEqual({
      args: ["--proxy-server=http://p:3128"],
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
    expect(launch.args).toEqual(["--proxy-server=http://p:3128"]);
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
