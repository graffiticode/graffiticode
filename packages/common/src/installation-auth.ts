// Auth's installation helpers (docs/installation-boundary-plan.md, I5a).
//
// Inert: nothing imports this yet. I5 wires it into auth's startup, its
// internal routes and /internal/act-as, after C5d activation step 5. Until
// then auth keeps INTERNAL_API_KEY, ACT_AS_CALLERS and v1 grants as today.
//
//   - loadInstallationCredentials: each installation's act-as secret and
//     internal keys, resolved from the registry's pinned references;
//   - internalKeyOwner: whose internal key was presented;
//   - INTERNAL_ROUTES / internalRouteAllows: which installation's key may
//     reach which internal route;
//   - verifyPresentedActAsGrant: v1 and v2 grants, judged against the
//     presenting caller's installation.
//
// Error messages name references and installations, never secret values.

import { createHash, timingSafeEqual } from "node:crypto";
import {
  ActAsGrantError, ActAsGrantV2Error, verifyActAsGrant, verifyActAsGrantV2,
  type ActAsGrant, type ActAsPurpose, type ActAsRefusalV2,
} from "./act-as.js";
import {
  GRAFFITICODE, InstallationError, isInstallationId, registeredInstallation,
  type GrantableInternalRoute, type InstallationRegistry,
} from "./installations.js";

// ---------------------------------------------------------------------------
// Credentials

const MIN_ACT_AS_SECRET_LENGTH = 32;

export type InstallationCredentials = {
  actAsSecret: string;
  // Current first, then the one being rotated out, if any.
  internalKeys: readonly string[];
};

// Installation id -> its credentials. Null-prototype and frozen.
export type CredentialsByInstallation = Readonly<Record<string, Readonly<InstallationCredentials>>>;

// Turns a pinned reference ("name:version") into its value, or undefined.
// I5's production resolver reads it from the variables gc-deploy's
// PINNED_SECRETS binds (decision A); here it is injected.
export type SecretResolver = (ref: string) => string | undefined;

// Loads every installation's credentials. Throws InstallationError, and a
// service refuses to start, when a reference doesn't resolve, an act-as
// secret is too short, or any two loaded values are equal: across
// installations, across purposes, or a current and a previous key. Distinct
// names don't guarantee distinct values, and a shared value would make a
// key's owner ambiguous.
export const loadInstallationCredentials = (registry: InstallationRegistry, resolve: SecretResolver): CredentialsByInstallation => {
  const credentials: Record<string, InstallationCredentials> = Object.create(null);
  // Which reference each loaded value came from, keyed by the value's digest.
  const loaded = new Map<string, string>();
  const load = (id: string, field: string, ref: string, minLength = 1): string => {
    const value = resolve(ref);
    if (typeof value !== "string" || value.length === 0) {
      throw new InstallationError(`installation ${id}: ${field} ${ref} did not resolve`);
    }
    if (value.length < minLength) {
      throw new InstallationError(`installation ${id}: ${field} ${ref} must be at least ${minLength} characters`);
    }
    const digest = createHash("sha256").update(value).digest("hex");
    const other = loaded.get(digest);
    if (other !== undefined) throw new InstallationError(`installation ${id}: ${field} ${ref} has the same value as ${other}`);
    loaded.set(digest, `${id} ${field} ${ref}`);
    return value;
  };
  for (const entry of Object.values(registry.installations)) {
    const actAsSecret = load(entry.id, "actAsSecret", entry.actAsSecret, MIN_ACT_AS_SECRET_LENGTH);
    const internalKeys = [load(entry.id, "internalKey", entry.internalKey)];
    if (entry.internalKeyPrevious !== null) internalKeys.push(load(entry.id, "internalKeyPrevious", entry.internalKeyPrevious));
    credentials[entry.id] = Object.freeze({ actAsSecret, internalKeys: Object.freeze(internalKeys) });
  }
  return Object.freeze(credentials);
};

// Constant-time equality for values of any length: compare digests, which
// are always 32 bytes (as auth's requireInternalAuth does).
const digest = (value: string) => createHash("sha256").update(value).digest();

// The installation whose internal key (current or previous) was presented,
// or null. Every key of every installation is compared, not just until the
// first match, so which one matched doesn't show in the timing. A missing or
// empty key matches nothing: loaded keys are never empty.
export const internalKeyOwner = (credentials: CredentialsByInstallation, presented: unknown): string | null => {
  const given = digest(typeof presented === "string" ? presented : "");
  let owner: string | null = null;
  for (const [id, { internalKeys }] of Object.entries(credentials)) {
    for (const key of internalKeys) {
      if (timingSafeEqual(given, digest(key))) owner = id;
    }
  }
  return owner;
};

// ---------------------------------------------------------------------------
// Internal routes (I-5)
//
// Auth's internal-key routes, each listed once by id:
//   graffiticode-only  Graffiticode's legacy records, or auth's own
//                      maintenance; no other installation ever has any there
//   grantable          reachable by an installation only when its registry
//                      entry grants it (Graffiticode's entry grants both, to
//                      keep today's behavior)
// /internal/act-as takes no internal key and isn't listed.

export const INTERNAL_ROUTES = Object.freeze(Object.assign(Object.create(null), {
  "oauth-tokens": "graffiticode-only", // /oauth-tokens
  "oauth-clients": "graffiticode-only", // /oauth-clients
  "oauth-pending": "graffiticode-only", // /oauth-pending
  "oauth-codes": "graffiticode-only", // /oauth-codes
  "oauth-migration": "graffiticode-only", // /oauth-migration/v1, inventory included
  "refresh-tokens-cleanup": "graffiticode-only", // /v1/refresh-tokens/clean-expired, the internal-key fallback
  "linked-emails": "grantable", // /linked-emails/internal*
  "authenticate-exists": "grantable", // /authenticate/internal/exists/:address
})) as Readonly<Record<string, "graffiticode-only" | "grantable">>;

// Whether the given installation's internal key may reach the route. An
// unknown route, or an installation the registry doesn't list, is refused.
export const internalRouteAllows = (registry: InstallationRegistry, route: unknown, installation: unknown): boolean => {
  if (typeof route !== "string" || !Object.prototype.hasOwnProperty.call(INTERNAL_ROUTES, route)) return false;
  const entry = registeredInstallation(registry, installation);
  if (!entry) return false;
  if (INTERNAL_ROUTES[route] === "graffiticode-only") return entry.id === GRAFFITICODE;
  return entry.internalRoutes.includes(route as GrantableInternalRoute);
};

// ---------------------------------------------------------------------------
// Presented act-as grants (I-5)

export type PresentedGrantRefusal = ActAsRefusalV2 | "v1-not-accepted" | "unknown-installation";

export class PresentedGrantError extends Error {
  readonly reason: PresentedGrantRefusal;
  constructor(reason: PresentedGrantRefusal) {
    super(`act-as grant refused: ${reason}`);
    this.reason = reason;
    this.name = "PresentedGrantError";
  }
}

// The caller, as createCallerIdentity returns it when configured with
// registryCallers(registry, "actAs"): a verified service identity, carrying
// its installation. Never an entry chosen from request data.
export type AuthenticatedCaller = { email: string; role: string; installation: string };

export type PresentedGrant = {
  grant: ActAsGrant;
  version: 1 | 2;
  // The installation for the issued token's `act` claim.
  installation: string;
};

// Which version a token claims to be: a v2 payload carries `i`. Read before
// verification only to pick the MAC domain; the two domains differ, so the
// wrong pick only fails verification.
const claimsV2 = (token: unknown): boolean | null => {
  if (typeof token !== "string") return null;
  const [payload] = token.split(".");
  if (!payload) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return !!body && typeof body === "object" && Object.prototype.hasOwnProperty.call(body, "i");
  } catch {
    return null;
  }
};

// Verifies a grant presented by an authenticated caller:
//   v2  under the caller's installation's secret, naming that installation;
//   v1  only from a Graffiticode caller, under Graffiticode's secret.
// Throws PresentedGrantError.
export const verifyPresentedActAsGrant = ({ credentials, caller, token, expect, now = Date.now() }: {
  credentials: CredentialsByInstallation;
  caller: AuthenticatedCaller;
  token: unknown;
  expect: { purpose: ActAsPurpose; uid: string; subject: string };
  now?: number;
}): PresentedGrant => {
  const installation = caller?.installation;
  if (!isInstallationId(installation) || !Object.prototype.hasOwnProperty.call(credentials, installation)) {
    throw new PresentedGrantError("unknown-installation");
  }
  const v2 = claimsV2(token);
  if (v2 === null) throw new PresentedGrantError("malformed");
  try {
    if (v2) {
      const g = verifyActAsGrantV2(credentials[installation].actAsSecret, token, { ...expect, installation }, now);
      return { grant: { purpose: g.purpose, uid: g.uid, subject: g.subject, notAfter: g.notAfter }, version: 2, installation };
    }
    if (installation !== GRAFFITICODE) throw new PresentedGrantError("v1-not-accepted");
    const grant = verifyActAsGrant(credentials[GRAFFITICODE].actAsSecret, token, expect, now);
    return { grant, version: 1, installation: GRAFFITICODE };
  } catch (err) {
    if (err instanceof ActAsGrantError || err instanceof ActAsGrantV2Error) throw new PresentedGrantError(err.reason);
    throw err;
  }
};
