// Act-as grants: the job-bound half of the auth service's /internal/act-as
// check. An app-tier producer signs one when it reserves work it will later run
// as a user (a generation job, or a write effect that follows one); the worker
// presents it, and the auth service verifies it before issuing that user a
// short-lived token. The other half is the worker's own Cloud Run identity
// (X-Caller-Identity, see ./caller.js).
//
// A grant binds a purpose, a uid, a subject (the job or effect it was signed
// for) and an expiry. It carries no secret and grants nothing on its own: only
// an allowed caller identity can exchange it. The signing secret is
// ACT_AS_GRANT_SECRET, shared by the producers and the auth service only.

import { createHmac, timingSafeEqual } from "node:crypto";

export const ACT_AS_PURPOSES = ["generation", "effect"] as const;
export type ActAsPurpose = (typeof ACT_AS_PURPOSES)[number];

export type ActAsGrant = {
  purpose: ActAsPurpose;
  uid: string;
  // The job or effect this grant is for (e.g. a generationId, or
  // "<sourceId>:<effectKind>:<taskId>"). Opaque here; compared exactly.
  subject: string;
  // Milliseconds since the epoch; the grant is refused at or after this time.
  notAfter: number;
};

// Why a grant was refused. Stable codes, safe to log.
export type ActAsRefusal =
  | "malformed"
  | "bad-signature"
  | "wrong-purpose"
  | "uid-mismatch"
  | "subject-mismatch"
  | "expired";

export class ActAsGrantError extends Error {
  readonly reason: ActAsRefusal;
  constructor(reason: ActAsRefusal) {
    super(`act-as grant refused: ${reason}`);
    this.reason = reason;
    this.name = "ActAsGrantError";
  }
}

const MIN_SECRET_LENGTH = 32;

const checkSecret = (secret: string) => {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`act-as grant secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
};

const mac = (secret: string, payload: string) =>
  createHmac("sha256", secret).update(`act-as.v1.${payload}`).digest();

const isPurpose = (p: unknown): p is ActAsPurpose =>
  typeof p === "string" && (ACT_AS_PURPOSES as readonly string[]).includes(p);

// "<base64url(json)>.<base64url(hmac)>"
export function signActAsGrant(secret: string, grant: ActAsGrant): string {
  checkSecret(secret);
  if (!isPurpose(grant.purpose) || !grant.uid || !grant.subject || !Number.isFinite(grant.notAfter)) {
    throw new Error("act-as grant needs a purpose, uid, subject and notAfter");
  }
  const payload = Buffer.from(JSON.stringify({
    p: grant.purpose, u: grant.uid, s: grant.subject, n: grant.notAfter,
  })).toString("base64url");
  return `${payload}.${mac(secret, payload).toString("base64url")}`;
}

// Verifies the signature first, then that the grant is for exactly this
// purpose, uid and subject, and that it hasn't expired. Throws ActAsGrantError.
export function verifyActAsGrant(
  secret: string,
  token: unknown,
  expect: { purpose: ActAsPurpose; uid: string; subject: string },
  now: number = Date.now(),
): ActAsGrant {
  checkSecret(secret);
  if (typeof token !== "string") throw new ActAsGrantError("malformed");
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new ActAsGrantError("malformed");
  const [payload, signature] = parts;
  const given = Buffer.from(signature, "base64url");
  const wanted = mac(secret, payload);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    throw new ActAsGrantError("bad-signature");
  }
  let body: any;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new ActAsGrantError("malformed");
  }
  const grant: ActAsGrant = { purpose: body?.p, uid: body?.u, subject: body?.s, notAfter: body?.n };
  if (!isPurpose(grant.purpose) || typeof grant.uid !== "string" || typeof grant.subject !== "string" ||
      !Number.isFinite(grant.notAfter)) {
    throw new ActAsGrantError("malformed");
  }
  if (grant.purpose !== expect.purpose) throw new ActAsGrantError("wrong-purpose");
  if (grant.uid !== expect.uid) throw new ActAsGrantError("uid-mismatch");
  if (grant.subject !== expect.subject) throw new ActAsGrantError("subject-mismatch");
  if (now >= grant.notAfter) throw new ActAsGrantError("expired");
  return grant;
}

// ---------------------------------------------------------------------------
// act-as.v2 (docs/installation-boundary-plan.md, I-5). Inert until auth's I5
// slice: nothing signs or verifies v2 yet, and v1 above is unchanged.
//
// A v2 grant also names the installation whose producer signed it (field
// `i`), and is signed with that installation's own secret. The MAC's domain
// differs from v1's ("act-as.v2." vs "act-as.v1."), so a token of one version
// never verifies as the other. Auth (I5) refuses a grant whose installation
// isn't the presenting caller's, and accepts v1 only from Graffiticode's
// callers, under Graffiticode's secret, until every Graffiticode producer
// sends v2.

export type ActAsGrantV2 = ActAsGrant & {
  installation: string;
};

export type ActAsRefusalV2 = ActAsRefusal | "installation-mismatch";

export class ActAsGrantV2Error extends Error {
  readonly reason: ActAsRefusalV2;
  constructor(reason: ActAsRefusalV2) {
    super(`act-as grant refused: ${reason}`);
    this.reason = reason;
    this.name = "ActAsGrantV2Error";
  }
}

// Installation ids, as in ./installations.js (kept local so v1's module has no
// new import).
const INSTALLATION_RE = /^[a-z][a-z0-9-]{1,62}$/;

const macV2 = (secret: string, payload: string) =>
  createHmac("sha256", secret).update(`act-as.v2.${payload}`).digest();

export function signActAsGrantV2(secret: string, grant: ActAsGrantV2): string {
  checkSecret(secret);
  if (!isPurpose(grant.purpose) || !grant.uid || !grant.subject || !Number.isFinite(grant.notAfter) ||
      typeof grant.installation !== "string" || !INSTALLATION_RE.test(grant.installation)) {
    throw new Error("act-as grant needs a purpose, uid, subject, notAfter and installation");
  }
  const payload = Buffer.from(JSON.stringify({
    p: grant.purpose, u: grant.uid, s: grant.subject, n: grant.notAfter, i: grant.installation,
  })).toString("base64url");
  return `${payload}.${macV2(secret, payload).toString("base64url")}`;
}

// As verifyActAsGrant, and the grant must be for exactly this installation.
// `secret` is that installation's own. Throws ActAsGrantV2Error.
export function verifyActAsGrantV2(
  secret: string,
  token: unknown,
  expect: { purpose: ActAsPurpose; uid: string; subject: string; installation: string },
  now: number = Date.now(),
): ActAsGrantV2 {
  checkSecret(secret);
  if (typeof token !== "string") throw new ActAsGrantV2Error("malformed");
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new ActAsGrantV2Error("malformed");
  const [payload, signature] = parts;
  const given = Buffer.from(signature, "base64url");
  const wanted = macV2(secret, payload);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    throw new ActAsGrantV2Error("bad-signature");
  }
  let body: any;
  try {
    body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new ActAsGrantV2Error("malformed");
  }
  const grant: ActAsGrantV2 = {
    purpose: body?.p, uid: body?.u, subject: body?.s, notAfter: body?.n, installation: body?.i,
  };
  if (!isPurpose(grant.purpose) || typeof grant.uid !== "string" || typeof grant.subject !== "string" ||
      !Number.isFinite(grant.notAfter) || typeof grant.installation !== "string" ||
      !INSTALLATION_RE.test(grant.installation)) {
    throw new ActAsGrantV2Error("malformed");
  }
  if (grant.installation !== expect.installation) throw new ActAsGrantV2Error("installation-mismatch");
  if (grant.purpose !== expect.purpose) throw new ActAsGrantV2Error("wrong-purpose");
  if (grant.uid !== expect.uid) throw new ActAsGrantV2Error("uid-mismatch");
  if (grant.subject !== expect.subject) throw new ActAsGrantV2Error("subject-mismatch");
  if (now >= grant.notAfter) throw new ActAsGrantV2Error("expired");
  return grant;
}
