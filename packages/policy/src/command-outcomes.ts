// A command's status from its operations' recorded outcomes (B5,
// docs/b5-commands-plan.md §6 step 5; design §5 "Lifecycle"). Pure.
//
//   uncertain  any operation is uncertain: never dropped while a write's fate is unknown
//   failed     nothing was written anywhere
//   completed  every admitted operation completed, every stage that ran is
//              closed, and no intent-bearing stage is not-reached or unfinished
//   partial    otherwise: something was written, and something didn't complete
//
// `not-reached` describes stages; it never decides the status by itself.

export const OPERATION_OUTCOMES = Object.freeze(["completed", "failed", "partial", "uncertain"] as const);

// Broker's receipt status, as a command operation's outcome.
export const outcomeFromReceipt = status => ({ succeeded: "completed", failed: "failed", partial: "partial", uncertain: "uncertain" }[status] ?? "uncertain");

// `operations`: [{ outcome }] for every bound occurrence (an occurrence with no
// outcome yet counts as unfinished). `stages`: [{ state: "ran" | "not-reached" |
// "pending", expansion: "open" | "closed", hasIntents }].
export const aggregateStatus = ({ operations, stages }) => {
  const outcomes = operations.map(o => o.outcome ?? null);
  if (outcomes.includes("uncertain")) return "uncertain";
  const wrote = outcomes.some(o => o === "completed" || o === "partial");
  if (!wrote) return "failed";
  const allCompleted = outcomes.every(o => o === "completed");
  const stagesDone = stages.every(s => !s.hasIntents || (s.state === "ran" && s.expansion === "closed"));
  return allCompleted && stagesDone ? "completed" : "partial";
};
