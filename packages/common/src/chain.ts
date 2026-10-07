// Task-chain ids (the gateway's `id0+id1+...`, see packages/api's task
// storage). A chain id is base64url JSON of `{ taskIds }`, and parts may be
// joined with `+` (or a space, which `+` becomes in a query string), so one
// chain has many encodings. The canonical chain is the decoded, ordered list
// of task ids: chain admission (capability plan W4) compares that, never the
// encoded string.

export class ChainIdError extends Error {}

const decodePart = (part: string): string[] => {
  let taskIds: unknown;
  try {
    taskIds = JSON.parse(Buffer.from(part, "base64url").toString("utf8"))?.taskIds;
  } catch (err) {
    throw new ChainIdError(`failed to decode chain id part ${part}: ${(err as Error).message}`);
  }
  if (!Array.isArray(taskIds) || taskIds.length < 1 || !taskIds.every(t => typeof t === "string" && t.length > 0)) {
    throw new ChainIdError(`chain id part ${part} contains no task ids`);
  }
  return taskIds;
};

export const decodeChainId = (id: string): string[] => {
  if (typeof id !== "string" || id.length === 0) throw new ChainIdError("chain id must be a non-empty string");
  return id.split(/[ +]/g).flatMap(decodePart);
};

export const encodeChainId = (taskIds: string[]): string =>
  Buffer.from(JSON.stringify({ taskIds }), "utf8").toString("base64url");
