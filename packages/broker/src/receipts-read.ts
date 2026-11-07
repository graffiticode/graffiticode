// Receipt reads for command settlement (B5, docs/b5-commands-plan.md §7).
// Policy settles a command's outcomes from what Broker recorded, without the
// live permission or credential a replay needs: a revoked connection must not
// stop the record of writes that already ran.
//
// Reads `receipts` only. No token, no credential, no provider call, no jti:
// nothing here can dispatch an effect. A claim with no recorded outcome reads
// as uncertain, with the steps that were persisted.
//
//   readReceipts({ invocationId, operationIds? })
//     -> { invocationId, operations: [{ operationId, binding, status, steps, claimedAt, recorded, reason?, failedStep?, category? }] }

export class ReceiptReadRefused extends Error {
  declare reason: string;
  declare status: number;
  constructor(reason, status = 400) {
    super(`receipt read refused: ${reason}`);
    this.reason = reason;
    this.status = status;
  }
}

export const INVOCATION_ID_RE = /^inv-[A-Za-z0-9-]{1,64}$/;
export const MAX_OPERATION_IDS = 500;

const defined = fields => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

export const createReceiptReader = ({ receipts }) =>
  async ({ invocationId, operationIds = undefined }) => {
    if (!INVOCATION_ID_RE.test(invocationId ?? "")) throw new ReceiptReadRefused("bad-invocation-id");
    let claims;
    if (operationIds === undefined) {
      claims = await receipts.listClaims(invocationId);
    } else {
      if (!Array.isArray(operationIds) || operationIds.length > MAX_OPERATION_IDS) throw new ReceiptReadRefused("bad-operation-ids");
      // Only this invocation's operations: `<invocationId>/<stage>/<occurrence>`.
      if (!operationIds.every(id => typeof id === "string" && id.startsWith(`${invocationId}/`) && id.split("/").length === 3)) {
        throw new ReceiptReadRefused("operation-not-in-invocation");
      }
      claims = [];
      for (const operationId of new Set(operationIds)) {
        const claim = await receipts.getClaim(operationId);
        if (claim) claims.push({ operationId, ...claim });
      }
    }
    const operations = [];
    for (const claim of claims) {
      const outcome = await receipts.getOutcome(claim.operationId);
      operations.push(outcome
        ? {
            operationId: claim.operationId,
            binding: claim.binding,
            claimedAt: claim.claimedAt,
            recorded: true,
            status: outcome.status,
            steps: outcome.steps ?? [],
            ...defined({ reason: outcome.reason, failedStep: outcome.failedStep, category: outcome.category }),
          }
        : {
            operationId: claim.operationId,
            binding: claim.binding,
            claimedAt: claim.claimedAt,
            recorded: false,
            status: "uncertain",
            steps: await receipts.getSteps(claim.operationId),
          });
    }
    operations.sort((a, b) => (a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0));
    return { invocationId, operations };
  };
