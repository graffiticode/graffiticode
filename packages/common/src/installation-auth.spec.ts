import { describe, expect, it } from "@jest/globals";
import { signActAsGrant, signActAsGrantV2 } from "./act-as.js";
import {
  INTERNAL_ROUTES, PresentedGrantError, internalKeyOwner, internalRouteAllows,
  loadInstallationCredentials, verifyPresentedActAsGrant,
} from "./installation-auth.js";
import { GRANTABLE_INTERNAL_ROUTES, InstallationError, parseInstallationRegistry, registryCallers } from "./installations.js";

const SA = (name: string) => `${name}@graffiticode-app.iam.gserviceaccount.com`;

const entry = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
  id,
  callers: { actAs: { [SA(`${id}-console`)]: { role: "console" } } },
  itemAuthority: { url: `https://console.${id}.example/x`, audience: `https://console.${id}.example` },
  actAsSecret: `${id}-act-as:${n}`,
  internalKey: `${id}-internal:${n}`,
  ...extra,
});

const parse = (...installations: unknown[]) => parseInstallationRegistry({ revision: 1, installations });

// Distinct, long-enough values for every reference in these tests.
const VALUES: Record<string, string> = {
  "graffiticode-act-as:1": "g".repeat(32),
  "graffiticode-internal:1": "graffiticode-key-1",
  "graffiticode-internal:2": "graffiticode-key-2",
  "artcompiler-act-as:2": "a".repeat(32),
  "artcompiler-internal:2": "artcompiler-key-2",
};
const resolveFrom = (values: Record<string, string>) => (ref: string) =>
  (Object.prototype.hasOwnProperty.call(values, ref) ? values[ref] : undefined);
const resolve = resolveFrom(VALUES);

const refused = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(InstallationError);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
};

const grantRefusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PresentedGrantError);
    return (err as PresentedGrantError).reason;
  }
  throw new Error("expected a refusal");
};

describe("loadInstallationCredentials", () => {
  it("loads each installation's act-as secret and internal keys, frozen", () => {
    const credentials = loadInstallationCredentials(parse(entry("graffiticode", 1), entry("artcompiler", 2)), resolve);
    expect(credentials.graffiticode).toEqual({ actAsSecret: "g".repeat(32), internalKeys: ["graffiticode-key-1"] });
    expect(credentials.artcompiler.internalKeys).toEqual(["artcompiler-key-2"]);
    expect(Object.isFrozen(credentials)).toBe(true);
    expect(Object.isFrozen(credentials.graffiticode.internalKeys)).toBe(true);
    expect((credentials as Record<string, unknown>).toString).toBeUndefined();
  });

  it("loads the current key first, then the previous one", () => {
    const credentials = loadInstallationCredentials(
      parse(entry("graffiticode", 2, { actAsSecret: "graffiticode-act-as:1", internalKeyPrevious: "graffiticode-internal:1" })), resolve);
    expect(credentials.graffiticode.internalKeys).toEqual(["graffiticode-key-2", "graffiticode-key-1"]);
  });

  it("refuses a reference that doesn't resolve", () => {
    expect(refused(() => loadInstallationCredentials(parse(entry("graffiticode", 1)), resolveFrom({ "graffiticode-act-as:1": "g".repeat(32) }))))
      .toMatch(/internalKey graffiticode-internal:1 did not resolve/);
    expect(refused(() => loadInstallationCredentials(parse(entry("graffiticode", 1)), resolveFrom({ ...VALUES, "graffiticode-internal:1": "" }))))
      .toMatch(/did not resolve/);
  });

  it("refuses a short act-as secret", () => {
    expect(refused(() => loadInstallationCredentials(parse(entry("graffiticode", 1)), resolveFrom({ ...VALUES, "graffiticode-act-as:1": "short" }))))
      .toMatch(/actAsSecret graffiticode-act-as:1 must be at least 32 characters/);
  });

  it("refuses equal values across installations, across purposes, and for a current and previous key", () => {
    const shared = "s".repeat(32);
    const cases: [unknown[], Record<string, string>][] = [
      [[entry("graffiticode", 1), entry("artcompiler", 2)], { ...VALUES, "artcompiler-internal:2": "graffiticode-key-1" }],
      [[entry("graffiticode", 1), entry("artcompiler", 2)], { ...VALUES, "artcompiler-act-as:2": "g".repeat(32) }],
      [[entry("graffiticode", 1)], { ...VALUES, "graffiticode-act-as:1": shared, "graffiticode-internal:1": shared }],
      [[entry("graffiticode", 1), entry("artcompiler", 2)], { ...VALUES, "artcompiler-internal:2": "g".repeat(32) }],
      [[entry("graffiticode", 2, { actAsSecret: "graffiticode-act-as:1", internalKeyPrevious: "graffiticode-internal:1" })],
        { ...VALUES, "graffiticode-internal:1": "graffiticode-key-2" }],
    ];
    for (const [installations, values] of cases) {
      const message = refused(() => loadInstallationCredentials(parse(...installations), resolveFrom(values)));
      expect(message).toMatch(/has the same value as/);
      // Never the value itself.
      for (const value of Object.values(values)) expect(message).not.toContain(value);
    }
  });
});

describe("internalKeyOwner", () => {
  const credentials = loadInstallationCredentials(parse(entry("graffiticode", 1), entry("artcompiler", 2)), resolve);

  it("names the installation whose key was presented", () => {
    expect(internalKeyOwner(credentials, "graffiticode-key-1")).toBe("graffiticode");
    expect(internalKeyOwner(credentials, "artcompiler-key-2")).toBe("artcompiler");
  });

  it("names nobody for a wrong, empty or missing key", () => {
    for (const presented of ["nope", "graffiticode-key-1 ", "", undefined, null, 7, ["graffiticode-key-1"]]) {
      expect(internalKeyOwner(credentials, presented)).toBeNull();
    }
  });

  it("compares every key, not stopping at the first match", () => {
    let compared = 0;
    const counted = (keys: string[]) => ({ [Symbol.iterator]: function * () { for (const k of keys) { compared += 1; yield k; } } });
    const counting = Object.assign(Object.create(null), {
      graffiticode: { actAsSecret: "g".repeat(32), internalKeys: counted(["graffiticode-key-2", "graffiticode-key-1"]) },
      artcompiler: { actAsSecret: "a".repeat(32), internalKeys: counted(["artcompiler-key-2"]) },
    });
    expect(internalKeyOwner(counting, "graffiticode-key-2")).toBe("graffiticode");
    expect(compared).toBe(3);
  });

  it("never accepts a previous key under an unrelated name", () => {
    // Refused at parse, so it can never be loaded as an accepted key.
    expect(refused(() => parse(entry("graffiticode", 1, { internalKeyPrevious: "unrelated-key:1" }))))
      .toMatch(/another version of internalKey's secret/);
  });

  it("accepts both keys during a rotation, and only the current one after it", () => {
    const rotating = loadInstallationCredentials(
      parse(entry("graffiticode", 2, { actAsSecret: "graffiticode-act-as:1", internalKeyPrevious: "graffiticode-internal:1" })), resolve);
    expect(internalKeyOwner(rotating, "graffiticode-key-2")).toBe("graffiticode");
    expect(internalKeyOwner(rotating, "graffiticode-key-1")).toBe("graffiticode");
    const rotated = loadInstallationCredentials(parse(entry("graffiticode", 2, { actAsSecret: "graffiticode-act-as:1" })), resolve);
    expect(internalKeyOwner(rotated, "graffiticode-key-2")).toBe("graffiticode");
    expect(internalKeyOwner(rotated, "graffiticode-key-1")).toBeNull();
  });
});

describe("internal routes", () => {
  const ROUTES = Object.keys(INTERNAL_ROUTES);
  const GRAFFITICODE_ONLY = ["oauth-tokens", "oauth-clients", "oauth-pending", "oauth-codes", "oauth-migration", "refresh-tokens-cleanup"];

  it("lists auth's internal-key routes once, and its grantable ones as the registry does", () => {
    expect(ROUTES.filter(r => INTERNAL_ROUTES[r] === "graffiticode-only").sort()).toEqual([...GRAFFITICODE_ONLY].sort());
    expect(ROUTES.filter(r => INTERNAL_ROUTES[r] === "grantable").sort()).toEqual([...GRANTABLE_INTERNAL_ROUTES].sort());
  });

  const registry = parse(
    entry("graffiticode", 1, { internalRoutes: ["linked-emails", "authenticate-exists"] }),
    entry("artcompiler", 2, { internalRoutes: ["linked-emails"] }),
    entry("ungranted", 3),
  );

  it("lets Graffiticode, with both grants, reach every route as today", () => {
    for (const route of ROUTES) expect(internalRouteAllows(registry, route, "graffiticode")).toBe(true);
  });

  it("keeps the Graffiticode-only routes from every other installation", () => {
    for (const route of GRAFFITICODE_ONLY) {
      expect(internalRouteAllows(registry, route, "artcompiler")).toBe(false);
      expect(internalRouteAllows(registry, route, "ungranted")).toBe(false);
    }
  });

  it("lets another installation reach only the routes it is granted", () => {
    expect(internalRouteAllows(registry, "linked-emails", "artcompiler")).toBe(true);
    expect(internalRouteAllows(registry, "authenticate-exists", "artcompiler")).toBe(false);
    expect(internalRouteAllows(registry, "linked-emails", "ungranted")).toBe(false);
    expect(internalRouteAllows(registry, "authenticate-exists", "ungranted")).toBe(false);
  });

  it("refuses Graffiticode a grantable route its entry doesn't grant", () => {
    const bare = parse(entry("graffiticode", 1));
    expect(internalRouteAllows(bare, "linked-emails", "graffiticode")).toBe(false);
    expect(internalRouteAllows(bare, "oauth-tokens", "graffiticode")).toBe(true);
  });

  it("refuses unknown routes and unregistered installations", () => {
    for (const route of ["act-as", "toString", "__proto__", "", null, 1]) expect(internalRouteAllows(registry, route, "graffiticode")).toBe(false);
    for (const who of ["nobody", "toString", "Graffiticode", null]) expect(internalRouteAllows(registry, "linked-emails", who)).toBe(false);
  });
});

describe("verifyPresentedActAsGrant", () => {
  const registry = parse(entry("graffiticode", 1), entry("artcompiler", 2));
  const credentials = loadInstallationCredentials(registry, resolve);
  // Callers as createCallerIdentity returns them, configured with the registry.
  const callers = registryCallers(registry, "actAs");
  const caller = (installation: string) => {
    const email = SA(`${installation}-console`);
    return { ...callers[email], email };
  };
  const G = caller("graffiticode");
  const A = caller("artcompiler");
  const grant = { purpose: "generation" as const, uid: "alice", subject: "gen-1", notAfter: 2_000 };
  const expect_ = { purpose: "generation" as const, uid: "alice", subject: "gen-1" };
  const verify = (c: typeof G, token: unknown, now = 1_000) =>
    verifyPresentedActAsGrant({ credentials, caller: c, token, expect: expect_, now });

  it("takes the caller's installation from the registry", () => {
    expect(G.installation).toBe("graffiticode");
    expect(A.installation).toBe("artcompiler");
  });

  it("accepts v2 from each installation's caller, under its own secret", () => {
    expect(verify(G, signActAsGrantV2("g".repeat(32), { ...grant, installation: "graffiticode" })))
      .toEqual({ grant, version: 2, installation: "graffiticode" });
    expect(verify(A, signActAsGrantV2("a".repeat(32), { ...grant, installation: "artcompiler" })))
      .toEqual({ grant, version: 2, installation: "artcompiler" });
  });

  it("accepts v1 from Graffiticode's caller, under Graffiticode's secret", () => {
    expect(verify(G, signActAsGrant("g".repeat(32), grant))).toEqual({ grant, version: 1, installation: "graffiticode" });
  });

  it("refuses v1 from any other caller, whatever secret signed it", () => {
    expect(grantRefusal(() => verify(A, signActAsGrant("g".repeat(32), grant)))).toBe("v1-not-accepted");
    expect(grantRefusal(() => verify(A, signActAsGrant("a".repeat(32), grant)))).toBe("v1-not-accepted");
  });

  it("refuses v2 under another installation's secret", () => {
    expect(grantRefusal(() => verify(A, signActAsGrantV2("g".repeat(32), { ...grant, installation: "artcompiler" })))).toBe("bad-signature");
    expect(grantRefusal(() => verify(G, signActAsGrantV2("a".repeat(32), { ...grant, installation: "graffiticode" })))).toBe("bad-signature");
  });

  it("refuses v2 naming another installation", () => {
    // Signed with the presenting caller's own secret, but for the other installation.
    expect(grantRefusal(() => verify(A, signActAsGrantV2("a".repeat(32), { ...grant, installation: "graffiticode" })))).toBe("installation-mismatch");
    // Another installation's grant, presented by Graffiticode's caller.
    expect(grantRefusal(() => verify(G, signActAsGrantV2("a".repeat(32), { ...grant, installation: "artcompiler" })))).toBe("bad-signature");
  });

  it("refuses v1 relabelled as v2 and v2 stripped to v1", () => {
    const [v1payload, v1sig] = signActAsGrant("g".repeat(32), grant).split(".");
    const asV2 = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(v1payload, "base64url").toString()), i: "graffiticode" })).toString("base64url");
    expect(grantRefusal(() => verify(G, `${asV2}.${v1sig}`))).toBe("bad-signature");
    const [v2payload, v2sig] = signActAsGrantV2("g".repeat(32), { ...grant, installation: "graffiticode" }).split(".");
    const body = JSON.parse(Buffer.from(v2payload, "base64url").toString());
    delete body.i;
    expect(grantRefusal(() => verify(G, `${Buffer.from(JSON.stringify(body)).toString("base64url")}.${v2sig}`))).toBe("bad-signature");
  });

  it("passes through the grant's own refusals", () => {
    const token = signActAsGrantV2("a".repeat(32), { ...grant, installation: "artcompiler" });
    expect(grantRefusal(() => verifyPresentedActAsGrant({ credentials, caller: A, token, expect: { ...expect_, uid: "bob" }, now: 1_000 }))).toBe("uid-mismatch");
    expect(grantRefusal(() => verify(A, token, 2_000))).toBe("expired");
    expect(grantRefusal(() => verify(G, signActAsGrant("g".repeat(32), grant), 2_000))).toBe("expired");
  });

  it("refuses malformed tokens", () => {
    for (const token of [undefined, 7, "", "nope", "!!!.sig"]) {
      expect(grantRefusal(() => verify(G, token))).toBe("malformed");
    }
    // A payload that parses but isn't a v2 body goes the v1 way, where the
    // signature is checked first, as v1 always has.
    expect(grantRefusal(() => verify(G, `${Buffer.from("null").toString("base64url")}.x`))).toBe("bad-signature");
  });

  it("refuses a caller with no registered installation", () => {
    for (const installation of [undefined, "nobody", "toString", "Graffiticode"]) {
      const token = signActAsGrant("g".repeat(32), grant);
      expect(grantRefusal(() => verify({ ...G, installation } as typeof G, token))).toBe("unknown-installation");
    }
  });
});
