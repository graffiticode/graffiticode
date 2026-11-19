// Installations: the frontends that call this backend, and the rules that keep
// their records apart (docs/installation-boundary-plan.md, I1).
//
// This module is inert: nothing imports it yet. Policy, the API, auth and
// Broker adopt it in later slices (I2-I5). It holds the parts every service
// must agree on, written once:
//
//   - the registry's schema and parser (I-1): one JSON document, pinned by
//     version in Secret Manager, holding references to secrets, never values;
//   - installationOf (I-3): a record without an installation is Graffiticode's;
//   - key derivation (I-3): Graffiticode's is today's, byte for byte, and
//     every other installation's is prefixed with its id;
//   - item resource names (I-4): Graffiticode keeps today's, and every other
//     installation's live in a hierarchy of their own;
//   - the identity-leniency guard (I-8).
//
// Nothing here reads an installation from a request. The installation comes
// from a verified service identity (I-2); these helpers only apply it.

import { createHash } from "node:crypto";

// The installation every record without one belongs to (I-3).
export const GRAFFITICODE = "graffiticode";

// Installation ids, as auth's migration routes already accept them.
export const INSTALLATION_ID_RE = /^[a-z][a-z0-9-]{1,62}$/;

// Item ids, the one pattern every service validates them with (I-4). It is
// Policy's ITEM_ID_RE: Broker's narrower one (^[A-Za-z0-9_-]{1,128}$) moves to
// this in I2b. It excludes "/", so a Graffiticode object name never contains
// one, and every other installation's always does.
export const ITEM_ID_RE = /^[A-Za-z0-9_:.-]{1,200}$/;

export const isInstallationId = (value: unknown): value is string =>
  typeof value === "string" && INSTALLATION_ID_RE.test(value);

export class InstallationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallationError";
  }
}

const checkInstallation = (installation: unknown): string => {
  if (!isInstallationId(installation)) throw new InstallationError("not an installation id");
  return installation;
};

const checkItem = (item: unknown): string => {
  if (typeof item !== "string" || !ITEM_ID_RE.test(item)) throw new InstallationError("not an item id");
  return item;
};

// The installation an existing stored record belongs to. A record with no
// `installation` field is Graffiticode's: every record written before
// installations, and every record a release that doesn't know them writes.
// Anything else that isn't an installation id fails closed, including an
// explicit null (no writer stores one) and a missing record: there is no
// record to own, so there is nothing to fall back for.
export const installationOf = (record: { installation?: unknown } | null | undefined): string => {
  if (!record || typeof record !== "object") throw new InstallationError("no record");
  if (!Object.prototype.hasOwnProperty.call(record, "installation") || record.installation === undefined) return GRAFFITICODE;
  return checkInstallation(record.installation);
};

// Whether an existing stored record belongs to the given (verified)
// installation. A mismatch, a malformed tag or a missing record is false:
// callers read it as not found.
export const belongsTo = (record: { installation?: unknown } | null | undefined, installation: string): boolean => {
  checkInstallation(installation);
  try {
    return installationOf(record) === installation;
  } catch {
    return false;
  }
};

// The tag to store on every new record, Graffiticode's included, so that
// every writer that adopts it tags (I-6's prerequisite for the backfill).
// Compatibility doesn't depend on the tag: keys are derived as before
// (installationKeyParts), an older release ignores the field, and untagged
// records keep reading as Graffiticode's.
export const installationTag = (installation: string): { installation: string } =>
  ({ installation: checkInstallation(installation) });

// The parts a key is derived from. Graffiticode's are exactly today's;
// every other installation's are prefixed with its id. Within one derivation
// (one collection, one id scheme) the two can't collide: the arrays differ in
// length. Compare derivations only within the same scheme.
export const installationKeyParts = (installation: string, parts: readonly unknown[]): unknown[] =>
  checkInstallation(installation) === GRAFFITICODE ? [...parts] : [installation, ...parts];

// sha256 hex of the parts' JSON. For Graffiticode it is byte-identical to
// Policy's hashId(parts) and keyDigest(uid, key) (policy/src/firestore.ts,
// policy/src/commands.ts).
export const installationKeyDigest = (installation: string, parts: readonly unknown[]): string =>
  createHash("sha256").update(JSON.stringify(installationKeyParts(installation, parts))).digest("hex");

// Command ids: `c:` plus the key digest of [uid, idempotencyKey], as
// commandIdFor does today.
export const installationCommandId = (installation: string, uid: string, idempotencyKey: string): string =>
  `c:${installationKeyDigest(installation, [uid, idempotencyKey])}`;

// Policy's per-item capture record. Graffiticode's is today's
// `item-captures/{item}`. Every other installation's lives in its own
// hierarchy: a prefix inside `item-captures` could collide, because item ids
// may contain ":".
export const itemCapturePath = (installation: string, item: string): string[] =>
  checkInstallation(installation) === GRAFFITICODE
    ? ["item-captures", checkItem(item)]
    : ["installation-item-captures", installation, "items", checkItem(item)];

// Broker's published thumbnail. Graffiticode's is today's `{item}.png`.
export const itemObjectName = (installation: string, item: string): string =>
  checkInstallation(installation) === GRAFFITICODE
    ? `${checkItem(item)}.png`
    : `${installation}/${checkItem(item)}.png`;

// ---------------------------------------------------------------------------
// The registry (I-1)
//
// {
//   "revision": 3,                       only increases; reported on health
//   "installations": [
//     {
//       "id": "graffiticode",
//       "callers": {                       service-account email -> role
//         "api":    { "app-run@p.iam.gserviceaccount.com": { "role": "frontend" } },
//         "policy": { "console-run@p.iam.gserviceaccount.com": { "role": "console" } },
//         "actAs":  { "console-run@p.iam.gserviceaccount.com": { "role": "console" } }
//       },
//       "itemAuthority": { "url": "https://…", "audience": "https://…" },
//       "actAsSecret": "act-as-grant-secret:1",     Secret Manager name:version
//       "internalKey": "internal-api-key:3",
//       "internalRoutes": ["linked-emails"]          grants beyond the default
//     }
//   ]
// }
//
// The parser checks what one document can show: the schema, Graffiticode's
// presence, a caller mapped to two installations, a secret shared by two, and
// (given a lookup) a reference to a missing secret. Whether every service
// pinned the same version is gc-deploy's check (release-check), not this one.

export const REGISTRY_SERVICES = ["api", "policy", "actAs"] as const;
export type RegistryService = (typeof REGISTRY_SERVICES)[number];

// What an installation's caller may be, per service. Policy admits a
// frontend only as "console": the backend roles (gateway, compiler, broker,
// policy) are never an installation's, so a frontend can't attest an
// installation or mint. Act-as roles are a closed list too, though auth
// doesn't check them yet: "console" is today's caller.
const ROLE_CHECK: Record<RegistryService, (role: unknown) => boolean> = {
  api: role => role === "frontend",
  policy: role => role === "console",
  actAs: role => role === "console",
};

// Internal routes another installation may be granted (I-5). The legacy
// OAuth and migration routes are Graffiticode's alone and can't be granted.
export const GRANTABLE_INTERNAL_ROUTES = ["linked-emails", "authenticate-exists"] as const;
export type GrantableInternalRoute = (typeof GRANTABLE_INTERNAL_ROUTES)[number];

const SERVICE_ACCOUNT_RE = /^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/;
// A pinned Secret Manager reference, as deploy.json's secrets are written.
const SECRET_REF_RE = /^[A-Za-z0-9_-]{1,255}:[1-9][0-9]{0,9}$/;

export type RegistryCaller = { role: string };

export type InstallationEntry = {
  id: string;
  callers: Record<RegistryService, Record<string, RegistryCaller>>;
  itemAuthority: { url: string; audience: string };
  actAsSecret: string;
  internalKey: string;
  internalRoutes: GrantableInternalRoute[];
};

export type InstallationRegistry = {
  revision: number;
  installations: Record<string, InstallationEntry>;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const onlyKeys = (where: string, value: Record<string, unknown>, allowed: readonly string[], required = allowed) => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new InstallationError(`${where}: unknown field ${key}`);
  }
  for (const key of required) {
    if (!(key in value)) throw new InstallationError(`${where}: missing ${key}`);
  }
};

const httpsUrl = (where: string, value: unknown): string => {
  if (typeof value !== "string") throw new InstallationError(`${where} must be an https URL`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InstallationError(`${where} must be an https URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new InstallationError(`${where} must be an https URL`);
  }
  return value;
};

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

export type ParseRegistryOptions = {
  // Whether a pinned secret reference exists. Services pass one at startup;
  // without it, references are checked for shape only.
  secretExists?: (ref: string) => boolean;
};

// Parses and checks the registry document (a JSON string or a parsed value).
// Throws InstallationError on anything invalid: a service refuses to start on
// it. The result is deeply frozen.
export const parseInstallationRegistry = (input: unknown, { secretExists }: ParseRegistryOptions = {}): InstallationRegistry => {
  let doc: unknown = input;
  if (typeof input === "string") {
    try {
      doc = JSON.parse(input);
    } catch {
      throw new InstallationError("registry must be JSON");
    }
  }
  if (!isPlainObject(doc)) throw new InstallationError("registry must be an object");
  onlyKeys("registry", doc, ["revision", "installations"]);
  const { revision } = doc;
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    throw new InstallationError("registry: revision must be a positive integer");
  }
  if (!Array.isArray(doc.installations) || doc.installations.length === 0) {
    throw new InstallationError("registry: installations must be a non-empty list");
  }

  // Maps keyed by ids or emails have no prototype, so no inherited name
  // (toString, __proto__) ever reads as an installation or a caller.
  const installations: Record<string, InstallationEntry> = Object.create(null);
  // Which installation each caller email belongs to, across every service:
  // one Google identity belongs to one installation. It may hold roles at
  // several services, but only within that installation.
  const callerOwner = new Map<string, string>();
  const secretOwner = new Map<string, string>();

  for (const raw of doc.installations) {
    if (!isPlainObject(raw)) throw new InstallationError("registry: an installation must be an object");
    const id = raw.id;
    if (!isInstallationId(id)) throw new InstallationError("registry: an installation has an invalid id");
    const where = `installation ${id}`;
    if (Object.prototype.hasOwnProperty.call(installations, id)) throw new InstallationError(`${where}: listed twice`);
    onlyKeys(where, raw, ["id", "callers", "itemAuthority", "actAsSecret", "internalKey", "internalRoutes"],
      ["id", "callers", "itemAuthority", "actAsSecret", "internalKey"]);

    if (!isPlainObject(raw.callers)) throw new InstallationError(`${where}: callers must be an object`);
    onlyKeys(`${where} callers`, raw.callers, REGISTRY_SERVICES, []);
    const callers = { api: Object.create(null), policy: Object.create(null), actAs: Object.create(null) } as InstallationEntry["callers"];
    for (const service of REGISTRY_SERVICES) {
      const map = raw.callers[service] ?? {};
      if (!isPlainObject(map)) throw new InstallationError(`${where} callers.${service} must be an object`);
      for (const [email, spec] of Object.entries(map)) {
        if (!SERVICE_ACCOUNT_RE.test(email)) throw new InstallationError(`${where} callers.${service}: ${email} is not a service account`);
        if (!isPlainObject(spec)) throw new InstallationError(`${where} callers.${service}: ${email} must be an object`);
        onlyKeys(`${where} callers.${service} ${email}`, spec, ["role"]);
        if (!ROLE_CHECK[service](spec.role)) throw new InstallationError(`${where} callers.${service}: ${email} has a role it may not hold`);
        const owner = callerOwner.get(email);
        if (owner !== undefined && owner !== id) {
          throw new InstallationError(`callers.${service}: ${email} is mapped to both ${owner} and ${id}`);
        }
        callerOwner.set(email, id);
        callers[service][email] = { role: spec.role as string };
      }
    }

    if (!isPlainObject(raw.itemAuthority)) throw new InstallationError(`${where}: itemAuthority must be an object`);
    onlyKeys(`${where} itemAuthority`, raw.itemAuthority, ["url", "audience"]);
    const itemAuthority = {
      url: httpsUrl(`${where} itemAuthority.url`, raw.itemAuthority.url),
      audience: httpsUrl(`${where} itemAuthority.audience`, raw.itemAuthority.audience),
    };

    const secret = (field: "actAsSecret" | "internalKey"): string => {
      const ref = raw[field];
      if (typeof ref !== "string" || !SECRET_REF_RE.test(ref)) {
        throw new InstallationError(`${where}: ${field} must be a pinned secret reference (name:version)`);
      }
      // A secret held by two installations would make its owner ambiguous,
      // whatever the version.
      const name = ref.slice(0, ref.lastIndexOf(":"));
      const owner = secretOwner.get(name);
      if (owner !== undefined) throw new InstallationError(`${where}: ${field} ${name} is also used by ${owner}`);
      secretOwner.set(name, `${id} (${field})`);
      if (secretExists && !secretExists(ref)) throw new InstallationError(`${where}: ${field} ${ref} does not exist`);
      return ref;
    };
    const actAsSecret = secret("actAsSecret");
    const internalKey = secret("internalKey");

    const routes = raw.internalRoutes ?? [];
    if (!Array.isArray(routes)) throw new InstallationError(`${where}: internalRoutes must be a list`);
    const internalRoutes: GrantableInternalRoute[] = [];
    for (const route of routes) {
      if (!(GRANTABLE_INTERNAL_ROUTES as readonly unknown[]).includes(route)) {
        throw new InstallationError(`${where}: internalRoutes: ${String(route)} can't be granted`);
      }
      if (internalRoutes.includes(route)) throw new InstallationError(`${where}: internalRoutes: ${route} listed twice`);
      internalRoutes.push(route);
    }

    installations[id] = { id, callers, itemAuthority, actAsSecret, internalKey, internalRoutes };
  }

  // Records without an installation are Graffiticode's, so it must be known.
  if (!Object.prototype.hasOwnProperty.call(installations, GRAFFITICODE)) {
    throw new InstallationError(`registry: ${GRAFFITICODE} must be listed`);
  }
  return deepFreeze({ revision: revision as number, installations });
};

// The installation registered under an id, or null: an unknown installation
// is refused by every service, never read as Graffiticode.
export const registeredInstallation = (registry: InstallationRegistry, id: unknown): InstallationEntry | null =>
  isInstallationId(id) && Object.prototype.hasOwnProperty.call(registry.installations, id)
    ? registry.installations[id]
    : null;

// One service's caller map, in the shape createCallerIdentity takes, with
// each caller's installation attached. The parser has made each email belong
// to one installation.
export const registryCallers = (registry: InstallationRegistry, service: RegistryService): Record<string, RegistryCaller & { installation: string }> => {
  if (!(REGISTRY_SERVICES as readonly string[]).includes(service)) throw new InstallationError(`unknown service ${String(service)}`);
  const callers: Record<string, RegistryCaller & { installation: string }> = Object.create(null);
  for (const entry of Object.values(registry.installations)) {
    for (const [email, caller] of Object.entries(entry.callers[service])) {
      callers[email] = Object.freeze({ ...caller, installation: entry.id });
    }
  }
  return Object.freeze(callers);
};

// ---------------------------------------------------------------------------
// Identity leniency (I-8)
//
// A protected path with no service identity at all is read as Graffiticode's
// only while INSTALLATION_IDENTITY_LENIENT=1 is set, and only while
// Graffiticode is the sole installation. Strict is the default. A service
// calls this at startup and refuses to start when it throws.
export const INSTALLATION_IDENTITY_LENIENT = "INSTALLATION_IDENTITY_LENIENT";

export const identityLeniency = (registry: InstallationRegistry, env: Record<string, string | undefined>): boolean => {
  const value = env[INSTALLATION_IDENTITY_LENIENT];
  if (value === undefined || value === "") return false;
  if (value !== "1") throw new InstallationError(`${INSTALLATION_IDENTITY_LENIENT} must be 1 or unset`);
  const ids = Object.keys(registry.installations);
  if (ids.length !== 1 || ids[0] !== GRAFFITICODE) {
    throw new InstallationError(`${INSTALLATION_IDENTITY_LENIENT} is refused while the registry lists more than ${GRAFFITICODE}`);
  }
  return true;
};
