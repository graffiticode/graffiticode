// The command staging bucket (docs/c5-l0013-commands-plan.md decisions 8 and
// 9), as Policy writes it: a capture's rendered PNG at
// `{commandId}/{stage}/{occurrenceId}.png`, created once
// (`ifGenerationMatch=0`), and read back to adopt what a lost acknowledgment
// left there. Policy holds objectCreator and objectViewer on this bucket only:
// it can create and read, never replace or delete, so staged bytes are
// immutable to it. Broker reads them before it publishes.
//
//   create(name, bytes) -> { created: true } | { created: false } (it exists)
//   read(name) -> Uint8Array | null
// Any other failure throws: staging couldn't be reached now.

import { createHash } from "node:crypto";

// The largest capture staged (a thumbnail is far smaller).
export const MAX_STAGED_BYTES = 8 * 1024 * 1024;
export const STAGING_TIMEOUT_MS = 10_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;

export const isPng = (bytes: Uint8Array) => bytes.length > PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// The staged object's name: the operation id's own triple, by its command.
export const stagedName = ({ commandId, stage, occurrenceId }) => `${commandId}/${stage}/${occurrenceId}.png`;

export const buildStagingStore = ({ bucket, accessToken, fetch: doFetch = fetch, baseUrl = "https://storage.googleapis.com", timeoutMs = STAGING_TIMEOUT_MS }: { bucket: string, accessToken: () => Promise<string>, fetch?: typeof fetch, baseUrl?: string, timeoutMs?: number }) => {
  if (!BUCKET_RE.test(bucket ?? "")) throw new Error("the staging bucket needs a bucket name");
  const headers = async () => ({ Authorization: `Bearer ${await accessToken()}` });
  return {
    bucket,
    async create(name: string, bytes: Uint8Array) {
      const url = `${baseUrl}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(name)}&ifGenerationMatch=0&fields=generation`;
      const res = await doFetch(url, { method: "POST", headers: { ...(await headers()), "Content-Type": "image/png" }, body: Buffer.from(bytes), signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 412) return { created: false };
      if (!res.ok) throw new Error(`staging write failed (${res.status})`);
      return { created: true };
    },
    async read(name: string) {
      const url = `${baseUrl}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}?alt=media`;
      const res = await doFetch(url, { method: "GET", headers: await headers(), signal: AbortSignal.timeout(timeoutMs) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`staging read failed (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
};

// In memory, with the same create-once rule. `fail` makes every call throw;
// `loseCreateAck` writes and then throws, as a lost acknowledgment does.
export const createMemoryStagingStore = () => {
  const objects = new Map<string, Uint8Array>();
  const state = { objects, fail: false, loseCreateAck: false, creates: [] as string[] };
  return {
    state,
    bucket: "memory-staging",
    async create(name: string, bytes: Uint8Array) {
      state.creates.push(name);
      if (state.fail) throw new Error("staging unavailable");
      if (objects.has(name)) return { created: false };
      objects.set(name, new Uint8Array(bytes));
      if (state.loseCreateAck) throw new Error("acknowledgment lost");
      return { created: true };
    },
    async read(name: string) {
      if (state.fail) throw new Error("staging unavailable");
      return objects.get(name) ?? null;
    },
  };
};
