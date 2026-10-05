// Security audit records. One record per decision — allowed or denied — with
// principals pseudonymized: Graffiticode uids can be wallet addresses, which
// must never be logged. Records never carry tokens, secrets, request bodies or
// argument values; an args digest is the most a record says about a request.

import { createHmac } from "node:crypto";

export const createPseudonymizer = ({ secret }) => {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new Error("audit pseudonymization secret must be at least 16 characters");
  }
  return value =>
    value == null ? null : createHmac("sha256", secret).update(String(value)).digest("hex").slice(0, 24);
};

// Opaque identifiers only; uid and owner are pseudonymized below. decisionId,
// jti, opid, step, purpose and provenance tie an execution decision (W2) to
// its token, operation and step.
const FIELDS = [
  "event", "outcome", "reason", "lang", "fn", "op", "connectionId", "registryVersion",
  "decisionId", "jti", "opid", "step", "purpose", "provenance",
];

export const createAudit = ({ sink, pseudonymize }) => record => {
  const out: Record<string, unknown> = { at: new Date().toISOString() };
  for (const field of FIELDS) {
    if (record[field] !== undefined) out[field] = record[field];
  }
  if (record.uid !== undefined) out.user = pseudonymize(record.uid);
  if (record.ownerUid !== undefined) out.owner = pseudonymize(record.ownerUid);
  return sink(out);
};
