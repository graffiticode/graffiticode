// The authority a session or an execution token rests on (spec EXEC-01:
// tokens cannot switch provenance):
//
//   user         a user's own run through a connection they own or were granted
//   publication  a viewer of a live publication (`pub`), on its publisher's
//                authority, restricted to view-safe functions
//   system       a system preview on the configured system connection, with no
//                user (`sub` is SYSTEM_PREVIEW_SUBJECT)
//
// A session records it as `sys` / `pub`; an execution token as `prv` (and
// `pub` for a publication). Mint copies the session's into the token, so
// Policy's live checks (liveRefusal) and Broker re-read the authority the
// token was actually issued for.

// The subject of a system preview session: there is no user.
export const SYSTEM_PREVIEW_SUBJECT = "system-preview";

export const PROVENANCES = Object.freeze(["user", "publication", "system"]);

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
// of the three, or null. `pub` is present exactly for a publication; only the
// system provenance carries the system subject.
export const provenanceRefusal = (claims): string | null => {
  const { prv, pub, sub } = claims;
  if (!PROVENANCES.includes(prv)) return "bad-provenance";
  if ((prv === "publication") !== (typeof pub === "string" && pub.length > 0)) return "bad-provenance";
  if (pub !== undefined && prv !== "publication") return "bad-provenance";
  if ((prv === "system") !== (sub === SYSTEM_PREVIEW_SUBJECT)) return "bad-provenance";
  return null;
};
