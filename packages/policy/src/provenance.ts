// The authority a session or an execution token rests on (spec EXEC-01:
// tokens cannot switch provenance):
//
//   user         a user's own run through a connection they own or were granted
//   publication  a viewer of a live publication (`pub`), on its publisher's
//                authority, restricted to view-safe functions
//   system       a system preview on the configured system connection, with no
//                user (`sub` is SYSTEM_PREVIEW_SUBJECT)
//   anonymous    a capture of a public item by a caller who isn't signed in,
//                through the bridge (C5 plan decision 4; `sub` is
//                ANONYMOUS_SUBJECT). Only for a function the registry gives
//                the public-capture exception, acting on one item scope under
//                contract v3, with no connection: never an L0176 operation.
//
// A session records it as `sys` / `pub`; an execution token as `prv` (and
// `pub` for a publication). Mint copies the session's into the token, so
// Policy's live checks (liveRefusal) and Broker re-read the authority the
// token was actually issued for.

import { protectedFunctionsForLang, credentialOf } from "@graffiticode/common/protected-registry";
import { CONTRACT_VERSION_SCOPED } from "@graffiticode/common/contract";

// The subject of a system preview session: there is no user.
export const SYSTEM_PREVIEW_SUBJECT = "system-preview";
// The subject of an anonymous public capture: there is no user.
export const ANONYMOUS_SUBJECT = "anonymous";

export const PROVENANCES = Object.freeze(["user", "publication", "system", "anonymous"]);

// May an execution token act anonymously? Only on its own item, for a
// function with the public-capture exception, under contract v3, with no
// connection or owner (decision 4). Whether this capture is allowed at all
// (the item is public, the rate limit, the exception's dates) is Policy's
// decision at every authorization.
const anonymousCaptureAllowed = claims => {
  const spec = protectedFunctionsForLang(claims.lang)?.[claims.fn];
  return Boolean(spec?.publicCapture) && spec.scope === "item" && credentialOf(spec) === "service" &&
    claims.cv === CONTRACT_VERSION_SCOPED && claims.scp?.kind === "item" &&
    claims.conn === undefined && claims.own === undefined && claims.backend === undefined;
};

// A session's provenance, or the refusal for a session whose claims don't
// form one: a system session is the system subject without a publication; a
// user session never claims the system subject or carries any `sys`.
export const sessionProvenance = (session): { provenance?: string, refusal?: string } => {
  if (session.sys === true) {
    if (session.sub !== SYSTEM_PREVIEW_SUBJECT || session.pub) return { refusal: "bad-session" };
    return { provenance: "system" };
  }
  if (session.sys !== undefined || session.sub === SYSTEM_PREVIEW_SUBJECT) return { refusal: "bad-session" };
  return { provenance: session.pub ? "publication" : "user" };
};

// The refusal for an execution token whose provenance claims don't form one
// of the four, or null. `pub` is present exactly for a publication; only the
// system provenance carries the system subject, and only the anonymous one
// the anonymous subject, within its narrow scope.
export const provenanceRefusal = (claims): string | null => {
  const { prv, pub, sub } = claims;
  if (!PROVENANCES.includes(prv)) return "bad-provenance";
  if ((prv === "publication") !== (typeof pub === "string" && pub.length > 0)) return "bad-provenance";
  if (pub !== undefined && prv !== "publication") return "bad-provenance";
  if ((prv === "system") !== (sub === SYSTEM_PREVIEW_SUBJECT)) return "bad-provenance";
  if ((prv === "anonymous") !== (sub === ANONYMOUS_SUBJECT)) return "bad-provenance";
  if (prv === "anonymous" && !anonymousCaptureAllowed(claims)) return "bad-provenance";
  return null;
};
