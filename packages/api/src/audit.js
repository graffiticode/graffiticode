// api's security audit (spec AUDIT-01): the same validated records and stdout
// sink as Policy and Broker, but never a user identifier. api correlates by
// trusted ids (invocation, request, attempt), so it holds no pseudonymization
// secret, and a record carrying `uid` or `ownerUid` is refused outright.
import { createAudit, auditSink } from "@graffiticode/policy/audit";

export class AuditIdentifierRefused extends Error {}

const noPseudonyms = () => {
  throw new AuditIdentifierRefused("api audit records carry no user identifiers");
};

export const createApiAudit = ({ sink = auditSink } = {}) => {
  const audit = createAudit({ sink, pseudonymize: noPseudonyms });
  return record => {
    if (record?.uid !== undefined || record?.ownerUid !== undefined) noPseudonyms();
    return audit(record);
  };
};

// For code that runs without an audit (tests, local servers).
export const noAudit = _record => {};
