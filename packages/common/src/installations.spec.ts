import { createHash } from "node:crypto";
import { describe, expect, it } from "@jest/globals";
import {
  GRAFFITICODE, INSTALLATION_IDENTITY_LENIENT, ITEM_ID_RE, InstallationError,
  belongsTo, identityLeniency, installationCommandId, installationKeyDigest, installationKeyParts,
  installationOf, installationTag, itemCapturePath, itemObjectName, parseInstallationRegistry,
  registeredInstallation, registryCallers,
} from "./installations.js";

// Today's derivations, restated exactly as Policy writes them
// (policy/src/firestore.ts hashId, policy/src/commands.ts keyDigest).
const hashId = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

const SA = (name: string, project = "graffiticode-app") => `${name}@${project}.iam.gserviceaccount.com`;

const entry = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
  id,
  callers: {
    api: { [SA(`${id}-app`)]: { role: "frontend" } },
    policy: { [SA(`${id}-console`)]: { role: "console" } },
    actAs: { [SA(`${id}-console`)]: { role: "console" } },
  },
  itemAuthority: { url: `https://console.${id}.example/api/item-authority`, audience: `https://console.${id}.example` },
  actAsSecret: `${id}-act-as-grant-secret:${n}`,
  internalKey: `${id}-internal-api-key:${n}`,
  ...extra,
});

const registry = (...installations: unknown[]) => ({ revision: 1, installations });
const graffiticodeOnly = () => registry(entry("graffiticode", 1));
const two = () => registry(entry("graffiticode", 1), entry("artcompiler", 2));

const refused = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(InstallationError);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
};

describe("Graffiticode's derivations are today's, byte for byte (I-3)", () => {
  it("matches fixed digests taken from today's algorithm", () => {
    // Computed with policy's hashId before this change; must never move.
    expect(installationKeyDigest(GRAFFITICODE, ["alice", "key-1"]))
      .toBe("d3319bccb37ed1b9772c3cf392e9c28a0dd6c0295fb272fcf3e61316acc6e8d9");
    expect(installationKeyDigest(GRAFFITICODE, ["alice", "task-1", "conn-1"]))
      .toBe("ec7d3fc1d4b6d76dab9e7f20425353f238ac9dbdecfc70f2a6ee28ef5c93bc40");
  });

  it("equals hashId and commandIdFor for keys, sequences and command ids", () => {
    for (const [uid, key] of [["alice", "k"], ["anonymous", "k"], ["u:1", "a\"b"], ["ü", ""]]) {
      expect(installationKeyDigest(GRAFFITICODE, [uid, key])).toBe(hashId([uid, key]));
      expect(installationCommandId(GRAFFITICODE, uid, key)).toBe(`c:${hashId([uid, key])}`);
      expect(installationKeyDigest(GRAFFITICODE, [uid, "task", "conn"])).toBe(hashId([uid, "task", "conn"]));
    }
  });

  it("keeps the parts unprefixed for Graffiticode and prefixes every other installation", () => {
    expect(installationKeyParts(GRAFFITICODE, ["alice", "k"])).toEqual(["alice", "k"]);
    expect(installationKeyParts("artcompiler", ["alice", "k"])).toEqual(["artcompiler", "alice", "k"]);
  });

  it("gives one user's key in two installations two commands", () => {
    const a = installationCommandId(GRAFFITICODE, "alice", "k");
    const b = installationCommandId("artcompiler", "alice", "k");
    expect(a).not.toBe(b);
    expect(b).toMatch(/^c:[a-f0-9]{64}$/);
    // Including the shared anonymous uid.
    expect(installationCommandId(GRAFFITICODE, "anonymous", "k")).not.toBe(installationCommandId("artcompiler", "anonymous", "k"));
  });

  it("can't be reached by constructing a Graffiticode key from another installation", () => {
    // Artcompiler's [installation, uid, key] has three parts; a Graffiticode
    // key always has two, whatever uid a caller picks.
    const theirs = installationKeyDigest("artcompiler", ["alice", "k"]);
    expect(installationKeyDigest(GRAFFITICODE, ["artcompiler", "alice"])).not.toBe(theirs);
    expect(installationKeyDigest(GRAFFITICODE, ["artcompiler", JSON.stringify(["alice", "k"])])).not.toBe(theirs);
  });

  it("refuses an invalid installation", () => {
    for (const bad of ["", "Graffiticode", "a", "1abc", "a/b", null, undefined, 7]) {
      refused(() => installationKeyDigest(bad as string, ["alice", "k"]));
    }
  });
});

describe("installationOf (I-3)", () => {
  it("reads an untagged record as Graffiticode's", () => {
    expect(installationOf({})).toBe(GRAFFITICODE);
    expect(installationOf({ installation: undefined })).toBe(GRAFFITICODE);
    expect(installationOf({ installation: "graffiticode" })).toBe(GRAFFITICODE);
    expect(installationOf({ installation: "artcompiler" })).toBe("artcompiler");
  });

  it("fails closed on a malformed tag", () => {
    for (const bad of [null, "", "Artcompiler", 1, {}, ["artcompiler"]]) refused(() => installationOf({ installation: bad }));
  });

  it("has nothing to fall back for when there is no record", () => {
    expect(refused(() => installationOf(null))).toMatch(/no record/);
    expect(refused(() => installationOf(undefined))).toMatch(/no record/);
    for (const installation of [GRAFFITICODE, "artcompiler"]) {
      expect(belongsTo(null, installation)).toBe(false);
      expect(belongsTo(undefined, installation)).toBe(false);
    }
  });

  it("makes an untagged record Graffiticode's and invisible to every other installation", () => {
    expect(belongsTo({}, GRAFFITICODE)).toBe(true);
    expect(belongsTo({}, "artcompiler")).toBe(false);
    expect(belongsTo({ installation: "graffiticode" }, "artcompiler")).toBe(false);
    expect(belongsTo({ installation: "artcompiler" }, GRAFFITICODE)).toBe(false);
    expect(belongsTo({ installation: "artcompiler" }, "artcompiler")).toBe(true);
  });

  it("matches nobody on a malformed tag, and refuses an invalid caller installation", () => {
    expect(belongsTo({ installation: "" }, GRAFFITICODE)).toBe(false);
    expect(belongsTo({ installation: 3 }, GRAFFITICODE)).toBe(false);
    expect(belongsTo({ installation: null }, GRAFFITICODE)).toBe(false);
    refused(() => belongsTo({}, "Not-An-Id"));
  });

  it("tags every new record, Graffiticode's included", () => {
    expect(installationTag(GRAFFITICODE)).toEqual({ installation: "graffiticode" });
    expect(installationTag("artcompiler")).toEqual({ installation: "artcompiler" });
    expect(installationOf(installationTag(GRAFFITICODE))).toBe(GRAFFITICODE);
    expect(installationOf(installationTag("artcompiler"))).toBe("artcompiler");
    // A tagged and an untagged Graffiticode record read the same.
    expect(belongsTo(installationTag(GRAFFITICODE), GRAFFITICODE)).toBe(belongsTo({}, GRAFFITICODE));
    refused(() => installationTag("Not-An-Id"));
  });
});

describe("item resources (I-4)", () => {
  it("keeps Graffiticode's names", () => {
    expect(itemCapturePath(GRAFFITICODE, "item-1")).toEqual(["item-captures", "item-1"]);
    expect(itemObjectName(GRAFFITICODE, "item-1")).toBe("item-1.png");
  });

  it("puts every other installation's in a hierarchy of its own", () => {
    expect(itemCapturePath("artcompiler", "item-1")).toEqual(["installation-item-captures", "artcompiler", "items", "item-1"]);
    expect(itemObjectName("artcompiler", "item-1")).toBe("artcompiler/item-1.png");
  });

  it("can't collide with Graffiticode's, even for ids containing ':'", () => {
    // A prefix inside item-captures would make these the same record.
    expect(itemCapturePath(GRAFFITICODE, "artcompiler:example")).not.toEqual(itemCapturePath("artcompiler", "example"));
    expect(itemCapturePath(GRAFFITICODE, "artcompiler:example")[0]).toBe("item-captures");
    // A Graffiticode object name never contains "/", every other always does.
    expect(itemObjectName(GRAFFITICODE, "artcompiler:example")).not.toContain("/");
    expect(itemObjectName("artcompiler", "example")).toContain("/");
  });

  it("validates items with Policy's ITEM_ID_RE, which excludes '/'", () => {
    expect(ITEM_ID_RE.source).toBe("^[A-Za-z0-9_:.-]{1,200}$");
    for (const ok of ["a", "a:b.c-d_e", "x".repeat(200)]) expect(itemObjectName(GRAFFITICODE, ok)).toBe(`${ok}.png`);
    for (const bad of ["", "a/b", "../x", "x".repeat(201), "a b", 5]) {
      refused(() => itemObjectName(GRAFFITICODE, bad as string));
      refused(() => itemCapturePath("artcompiler", bad as string));
    }
  });
});

describe("the registry (I-1)", () => {
  it("parses Graffiticode alone, frozen", () => {
    const parsed = parseInstallationRegistry(JSON.stringify(graffiticodeOnly()));
    expect(parsed.revision).toBe(1);
    expect(Object.keys(parsed.installations)).toEqual(["graffiticode"]);
    expect(parsed.installations.graffiticode.internalRoutes).toEqual([]);
    expect(Object.isFrozen(parsed.installations.graffiticode.callers.api)).toBe(true);
  });

  it("parses two installations and attaches each caller's installation", () => {
    const parsed = parseInstallationRegistry(two());
    expect(registryCallers(parsed, "api")).toEqual({
      [SA("graffiticode-app")]: { role: "frontend", installation: "graffiticode" },
      [SA("artcompiler-app")]: { role: "frontend", installation: "artcompiler" },
    });
    expect(registryCallers(parsed, "policy")[SA("artcompiler-console")]).toEqual({ role: "console", installation: "artcompiler" });
    expect(registeredInstallation(parsed, "artcompiler")?.id).toBe("artcompiler");
  });

  it("knows no installation it doesn't list", () => {
    const parsed = parseInstallationRegistry(graffiticodeOnly());
    expect(registeredInstallation(parsed, "artcompiler")).toBeNull();
    expect(registeredInstallation(parsed, "toString")).toBeNull();
    expect(registeredInstallation(parsed, "__proto__")).toBeNull();
    expect(registryCallers(parsed, "api").toString).toBeUndefined();
  });

  it("refuses a caller mapped to two installations at the same service", () => {
    const shared = SA("shared-app");
    const doc = registry(
      entry("graffiticode", 1, { callers: { api: { [shared]: { role: "frontend" } } } }),
      entry("artcompiler", 2, { callers: { api: { [shared]: { role: "frontend" } } } }),
    );
    expect(refused(() => parseInstallationRegistry(doc))).toMatch(/mapped to both graffiticode and artcompiler/);
  });

  it("refuses a caller mapped to two installations at different services", () => {
    const shared = SA("shared-run");
    for (const [theirs, role] of [["policy", "console"], ["actAs", "console"]]) {
      const doc = registry(
        entry("graffiticode", 1, { callers: { api: { [shared]: { role: "frontend" } } } }),
        entry("artcompiler", 2, { callers: { [theirs]: { [shared]: { role } } } }),
      );
      expect(refused(() => parseInstallationRegistry(doc))).toMatch(/mapped to both graffiticode and artcompiler/);
    }
  });

  it("allows one installation's account to hold roles at several services", () => {
    const sa = SA("graffiticode-console");
    const doc = registry(entry("graffiticode", 1, { callers: { policy: { [sa]: { role: "console" } }, actAs: { [sa]: { role: "console" } } } }));
    expect(() => parseInstallationRegistry(doc)).not.toThrow();
  });

  it("refuses a role an installation may not hold", () => {
    for (const [service, role] of [
      ["policy", "gateway"], ["policy", "compiler"], ["policy", "broker"], ["policy", "policy"],
      ["api", "console"], ["api", "gateway"],
      ["actAs", ""], ["actAs", "gateway"], ["actAs", "worker"], ["actAs", "frontend"],
    ]) {
      const doc = registry(entry("graffiticode", 1, { callers: { [service]: { [SA("x")]: { role } } } }));
      expect(refused(() => parseInstallationRegistry(doc))).toMatch(/role it may not hold/);
    }
  });

  it("refuses a secret shared by two installations, whatever the version", () => {
    const doc = registry(entry("graffiticode", 1), entry("artcompiler", 2, { internalKey: "graffiticode-internal-api-key:7" }));
    expect(refused(() => parseInstallationRegistry(doc))).toMatch(/also used by graffiticode/);
    const self = registry(entry("graffiticode", 1, { internalKey: "graffiticode-act-as-grant-secret:2" }));
    expect(refused(() => parseInstallationRegistry(self))).toMatch(/also used by graffiticode/);
  });

  it("accepts a previous version of an entry's own internal key during a rotation", () => {
    const parsed = parseInstallationRegistry(registry(entry("graffiticode", 2, { internalKeyPrevious: "graffiticode-internal-api-key:1" })));
    expect(parsed.installations.graffiticode.internalKey).toBe("graffiticode-internal-api-key:2");
    expect(parsed.installations.graffiticode.internalKeyPrevious).toBe("graffiticode-internal-api-key:1");
    expect(parseInstallationRegistry(graffiticodeOnly()).installations.graffiticode.internalKeyPrevious).toBeNull();
  });

  it("refuses a previous key that isn't another version of the entry's own internal key", () => {
    const cases: [unknown, RegExp][] = [
      // The same version as the current key.
      [registry(entry("graffiticode", 1, { internalKeyPrevious: "graffiticode-internal-api-key:1" })), /is the current internalKey/],
      // An otherwise unused name, unrelated to the current key's.
      [registry(entry("graffiticode", 2, { internalKeyPrevious: "unrelated-key:1" })), /another version of internalKey's secret/],
      [registry(entry("graffiticode", 1), entry("artcompiler", 2, { internalKeyPrevious: "unrelated-key:1" })), /another version of internalKey's secret/],
      // Another installation's internal key.
      [registry(entry("graffiticode", 1), entry("artcompiler", 2, { internalKeyPrevious: "graffiticode-internal-api-key:7" })), /another version of internalKey's secret/],
      // The entry's own act-as secret: another purpose.
      [registry(entry("graffiticode", 1, { internalKeyPrevious: "graffiticode-act-as-grant-secret:9" })), /another version of internalKey's secret/],
      // Another installation's act-as secret.
      [registry(entry("graffiticode", 1), entry("artcompiler", 2, { internalKeyPrevious: "graffiticode-act-as-grant-secret:9" })), /another version of internalKey's secret/],
      // Unpinned.
      [registry(entry("graffiticode", 1, { internalKeyPrevious: "graffiticode-internal-api-key" })), /pinned secret reference/],
      [registry(entry("graffiticode", 1, { internalKeyPrevious: null })), /pinned secret reference/],
    ];
    for (const [doc, message] of cases) expect(refused(() => parseInstallationRegistry(doc))).toMatch(message);
  });

  it("refuses another installation reusing a name some entry rotates", () => {
    // Artcompiler's current key can't take Graffiticode's name at any version.
    const doc = registry(
      entry("graffiticode", 2, { internalKeyPrevious: "graffiticode-internal-api-key:1" }),
      entry("artcompiler", 2, { internalKey: "graffiticode-internal-api-key:3" }),
    );
    expect(refused(() => parseInstallationRegistry(doc))).toMatch(/also used by graffiticode/);
  });

  it("checks a previous key exists, given a lookup", () => {
    const doc = registry(entry("graffiticode", 2, { internalKeyPrevious: "graffiticode-internal-api-key:1" }));
    const known = new Set(["graffiticode-act-as-grant-secret:2", "graffiticode-internal-api-key:2"]);
    expect(refused(() => parseInstallationRegistry(doc, { secretExists: ref => known.has(ref) })))
      .toMatch(/internalKeyPrevious graffiticode-internal-api-key:1 does not exist/);
  });

  it("refuses a reference to a missing secret, given a lookup", () => {
    const known = new Set(["graffiticode-act-as-grant-secret:1", "graffiticode-internal-api-key:1"]);
    expect(() => parseInstallationRegistry(graffiticodeOnly(), { secretExists: ref => known.has(ref) })).not.toThrow();
    expect(refused(() => parseInstallationRegistry(two(), { secretExists: ref => known.has(ref) })))
      .toMatch(/artcompiler-act-as-grant-secret:2 does not exist/);
  });

  it("refuses unpinned or malformed secret references", () => {
    for (const ref of ["internal-api-key", "internal-api-key:latest", "internal-api-key:0", "a/b:1", "", 3]) {
      expect(refused(() => parseInstallationRegistry(registry(entry("graffiticode", 1, { internalKey: ref })))))
        .toMatch(/pinned secret reference/);
    }
  });

  it("requires Graffiticode", () => {
    expect(refused(() => parseInstallationRegistry(registry(entry("artcompiler", 2))))).toMatch(/graffiticode must be listed/);
  });

  it("refuses malformed documents and entries", () => {
    const cases: [unknown, RegExp][] = [
      ["{", /must be JSON/],
      [[], /must be an object/],
      [{ installations: [entry("graffiticode", 1)] }, /missing revision/],
      [{ revision: 0, installations: [entry("graffiticode", 1)] }, /positive integer/],
      [{ revision: 1.5, installations: [entry("graffiticode", 1)] }, /positive integer/],
      [{ revision: 1, installations: [] }, /non-empty/],
      [{ revision: 1, installations: [entry("graffiticode", 1)], extra: 1 }, /unknown field extra/],
      [registry(entry("graffiticode", 1), entry("graffiticode", 2)), /listed twice/],
      [registry(entry("Graffiticode", 1)), /invalid id/],
      [registry(entry("graffiticode", 1, { secretValue: "x" })), /unknown field secretValue/],
      [registry(entry("graffiticode", 1, { callers: { broker: {} } })), /unknown field broker/],
      [registry(entry("graffiticode", 1, { callers: { api: { "someone@gmail.com": { role: "frontend" } } } })), /not a service account/],
      [registry(entry("graffiticode", 1, { callers: { api: { [SA("x")]: { role: "frontend", lang: "0176" } } } })), /unknown field lang/],
      [registry(entry("graffiticode", 1, { itemAuthority: { url: "http://console.example/x", audience: "https://console.example" } })), /https URL/],
      [registry(entry("graffiticode", 1, { itemAuthority: { url: "https://u:p@console.example/x", audience: "https://console.example" } })), /https URL/],
      [registry(entry("graffiticode", 1, { itemAuthority: { url: "https://console.example/x" } })), /missing audience/],
    ];
    for (const [doc, message] of cases) expect(refused(() => parseInstallationRegistry(doc))).toMatch(message);
  });

  it("grants only the grantable internal routes", () => {
    const ok = parseInstallationRegistry(registry(entry("graffiticode", 1, { internalRoutes: ["linked-emails", "authenticate-exists"] })));
    expect(ok.installations.graffiticode.internalRoutes).toEqual(["linked-emails", "authenticate-exists"]);
    for (const route of ["oauth-tokens", "oauth-migration", "anything"]) {
      expect(refused(() => parseInstallationRegistry(registry(entry("graffiticode", 1, { internalRoutes: [route] })))))
        .toMatch(/can't be granted/);
    }
    expect(refused(() => parseInstallationRegistry(registry(entry("graffiticode", 1, { internalRoutes: ["linked-emails", "linked-emails"] })))))
      .toMatch(/listed twice/);
  });
});

describe("identity leniency (I-8)", () => {
  const only = parseInstallationRegistry(graffiticodeOnly());
  const both = parseInstallationRegistry(two());

  it("is strict by default", () => {
    expect(identityLeniency(only, {})).toBe(false);
    expect(identityLeniency(both, {})).toBe(false);
    expect(identityLeniency(both, { [INSTALLATION_IDENTITY_LENIENT]: "" })).toBe(false);
  });

  it("is lenient only when set to 1 with Graffiticode alone", () => {
    expect(identityLeniency(only, { [INSTALLATION_IDENTITY_LENIENT]: "1" })).toBe(true);
  });

  it("refuses to start lenient with a second installation", () => {
    expect(refused(() => identityLeniency(both, { [INSTALLATION_IDENTITY_LENIENT]: "1" }))).toMatch(/more than graffiticode/);
  });

  it("refuses any other value", () => {
    for (const value of ["true", "0", "yes", " 1"]) refused(() => identityLeniency(only, { [INSTALLATION_IDENTITY_LENIENT]: value }));
  });
});
