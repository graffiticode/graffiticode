// L0013's thumbnail publish, `gcs.put-thumbnail` (docs/c5-l0013-commands-plan.md
// decisions 5, 8 and 9): Broker, as its own runtime identity, publishes one
// item's captured PNG to the thumbnail bucket. No connection is involved; the
// execution token selects the item (`scp`), and the payload names the same
// item.
//
// The published object `{item}.png` is its own pointer: its custom metadata
// carries the capture's `captureSequence` (with `commandId` and `sha256`), and
// it is replaced only by one generation-precondition write whose sequence is
// newer. So the bytes and the sequence change together or not at all.
//
//   publish attempt k (each authorized by Policy, decision 5):
//     1. read the object's generation and captureSequence ("absent": 0)
//     2. a sequence at or above this capture's: the effect ("the item's
//        published captureSequence is at least this one's") already holds;
//        nothing is written, observed `newer-present`
//     3. otherwise prepare the upload (its credential and body), then ask
//        Policy, then send it with ifGenerationMatch (0 when absent). Every
//        asynchronous preparation comes before the authorization: between
//        the decision and the request nothing is awaited but the decision's
//        own audit and the deadline check (broker.js authorizeStep):
//        written      observed `published`
//        412          observed `precondition-failed`, nothing written; the
//                     next attempt is authorized fresh
//   after `attempts` failed preconditions: `failed`, `precondition-contention`
//
// The bytes come from staging, `{commandId}/{stage}/{occurrenceId}.png` in the
// staging bucket, keyed exactly as the operation id is (decision 9). Broker
// reads and checks them before its receipt claim; once a claim exists it never
// reads staging again (broker.js).
//
// The result `{ item, captureSequence, sha256, url }` is a pure function of
// the operation's own arguments and the bucket recorded in its evidence, so
// reconciliation rebuilds exactly what the execution returned. Whether the
// execution wrote or found a newer capture is recorded on the receipt's step
// and attempts, never in the result.

import { createHash } from "node:crypto";
import { PayloadRejected, ProviderRejected } from "./operations.js";

// A precondition failed: the object changed since it was read, and nothing
// was written.
export class PreconditionFailed extends Error {}

// Nothing was written, for a reason other than the provider refusing the
// write itself (a read that failed before any write, or contention that never
// let a write through). Definite, like ProviderRejected, with its own reason.
export class NotWritten extends ProviderRejected {
  declare reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

// The staged bytes are missing, or don't hash to the bound digest.
export class StagingUnavailable extends Error {}

export const THUMBNAIL_EVIDENCE_FORMAT = "gcs-thumbnail-1";
export const PUBLIC_STORAGE_URL = "https://storage.googleapis.com";
// The legacy bucket l0013r uploads to directly. Broker never writes it
// (decision 8): no fenced writer may share a bucket with an unfenced one.
export const LEGACY_THUMBNAIL_BUCKET = "graffiticode.appspot.com";

const ITEM_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const OBSERVED = ["published", "newer-present", "precondition-failed"] as const;
export type Observed = typeof OBSERVED[number];

const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);
export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// THUMBNAIL_BUCKET and COMMAND_STAGING_BUCKET. Absent: the operation isn't
// built, so a snap token is refused. The legacy bucket is refused outright.
export const parseThumbnailBuckets = (env: Record<string, string | undefined>) => {
  const thumbnails = env.THUMBNAIL_BUCKET?.trim() || "";
  const staging = env.COMMAND_STAGING_BUCKET?.trim() || "";
  if (!thumbnails && !staging) return null;
  if (!thumbnails || !staging) throw new Error("THUMBNAIL_BUCKET and COMMAND_STAGING_BUCKET are set together");
  for (const [name, bucket] of [["THUMBNAIL_BUCKET", thumbnails], ["COMMAND_STAGING_BUCKET", staging]]) {
    if (!BUCKET_RE.test(bucket)) throw new Error(`${name} is not a bucket name`);
    if (bucket === LEGACY_THUMBNAIL_BUCKET) throw new Error(`${name} may not be ${LEGACY_THUMBNAIL_BUCKET}: Broker never writes the legacy thumbnail bucket`);
  }
  if (thumbnails === staging) throw new Error("THUMBNAIL_BUCKET and COMMAND_STAGING_BUCKET must differ");
  return { thumbnails, staging };
};

// The payload, exactly the arguments Policy bound (decision 9).
const validateThumbnail = payload => {
  if (!isPlainObject(payload)) throw new PayloadRejected("thumbnail must be an object");
  const extra = Object.keys(payload).filter(k => !["item", "sha256", "captureSequence"].includes(k));
  if (extra.length) throw new PayloadRejected(`thumbnail has unsupported fields: ${extra.join(", ")}`);
  if (typeof payload.item !== "string" || !ITEM_RE.test(payload.item)) throw new PayloadRejected("thumbnail.item must be an item id");
  if (typeof payload.sha256 !== "string" || !SHA256_RE.test(payload.sha256)) throw new PayloadRejected("thumbnail.sha256 must be a sha256 hex digest");
  if (!Number.isSafeInteger(payload.captureSequence) || payload.captureSequence < 1) throw new PayloadRejected("thumbnail.captureSequence must be a positive integer");
};

export const objectName = (item: string) => `${item}.png`;
// Keyed exactly as the operation id is: the command, then the operation id's
// stage and occurrence.
export const stagedObjectName = ({ commandId, operationId }: { commandId: string, operationId: string }) => {
  const parts = operationId.split("/");
  if (parts.length !== 3 || !commandId) throw new Error("a staged object needs a command and an operation id");
  return `${commandId}/${parts[1]}/${parts[2]}.png`;
};
export const thumbnailUrl = ({ bucket, item, sha256 }) => `${PUBLIC_STORAGE_URL}/${bucket}/${objectName(item)}?v=${sha256.slice(0, 16)}`;

// Recorded on the claim, before any provider request.
export const thumbnailEvidence = ({ item, sha256, captureSequence }, { bucket, commandId, operationId }) => ({
  format: THUMBNAIL_EVIDENCE_FORMAT,
  bucket,
  object: objectName(item),
  item,
  captureSequence,
  sha256,
  commandId,
  staged: stagedObjectName({ commandId, operationId }),
});

const readableEvidence = evidence =>
  isPlainObject(evidence) &&
  evidence.format === THUMBNAIL_EVIDENCE_FORMAT &&
  typeof evidence.bucket === "string" && BUCKET_RE.test(evidence.bucket) &&
  typeof evidence.item === "string" && ITEM_RE.test(evidence.item) &&
  evidence.object === objectName(evidence.item) &&
  typeof evidence.sha256 === "string" && SHA256_RE.test(evidence.sha256) &&
  Number.isSafeInteger(evidence.captureSequence) && evidence.captureSequence >= 1;

// The result, from the claim's evidence alone (B6 decision 2): exactly what
// `run` returns.
export const thumbnailResultFromEvidence = evidence => {
  if (!readableEvidence(evidence)) return null;
  const { bucket, item, sha256, captureSequence } = evidence;
  return { item, captureSequence, sha256, url: thumbnailUrl({ bucket, item, sha256 }) };
};

// A published object's sequence. An object with none (the one-time migration
// copy, decision 8) reads as 0, so any capture replaces it.
export const publishedSequence = head => {
  const raw = head?.metadata?.captureSequence;
  if (typeof raw !== "string" || !/^[0-9]{1,15}$/.test(raw)) return 0;
  return Number(raw);
};

// The Cloud Storage JSON API, as Broker's runtime identity (ADC). Only what
// this operation needs: an object's metadata, its bytes, and a conditional
// upload.
//   getMetadata -> { generation, metadata } | null (absent)
//   read        -> Uint8Array | null (absent)
//   prepareUpload -> { send(timeoutMs) -> { generation } }: everything
//                  asynchronous (the access token, the body) happens in
//                  prepareUpload; send dispatches at once. send throws
//                  PreconditionFailed on 412, ProviderRejected on any other
//                  definite refusal, and any other error when the write may
//                  have happened
export const buildGcsStorage = ({ accessToken, fetch: doFetch = fetch, baseUrl = PUBLIC_STORAGE_URL }: { accessToken: () => Promise<string>, fetch?: typeof fetch, baseUrl?: string }) => {
  const object = (bucket, name) => `${baseUrl}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}`;
  const send = async (url, init, timeoutMs) => {
    const headers = { ...(init.headers ?? {}), Authorization: `Bearer ${await accessToken()}` };
    return doFetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  };
  return {
    async getMetadata(bucket, name, { timeoutMs }) {
      const res = await send(`${object(bucket, name)}?fields=generation,metadata`, { method: "GET" }, timeoutMs);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`storage metadata read failed (${res.status})`);
      const body = (await res.json()) as any;
      return { generation: String(body.generation), metadata: isPlainObject(body.metadata) ? body.metadata : {} };
    },
    async read(bucket, name, { timeoutMs }) {
      const res = await send(`${object(bucket, name)}?alt=media`, { method: "GET" }, timeoutMs);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`storage read failed (${res.status})`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async prepareUpload(bucket, name, bytes, { ifGenerationMatch, metadata, contentType, cacheControl }) {
      const boundary = `gc-${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}`;
      const head = JSON.stringify({ name, contentType, cacheControl, metadata });
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${head}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`),
        Buffer.from(bytes),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const url = `${baseUrl}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=multipart&ifGenerationMatch=${encodeURIComponent(String(ifGenerationMatch))}&fields=generation`;
      const headers = { "Content-Type": `multipart/related; boundary=${boundary}`, Authorization: `Bearer ${await accessToken()}` };
      return {
        // Dispatches synchronously: fetch is called before anything is awaited.
        send: async (timeoutMs: number) => {
          const res = await doFetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
          if (res.status === 412) throw new PreconditionFailed("the object changed since it was read");
          // A refusal of the request itself wrote nothing. A timeout, throttling
          // or a server error may have, so it propagates as uncertain.
          if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw new ProviderRejected(`storage upload refused (${res.status})`);
          if (!res.ok) throw new Error(`storage upload failed (${res.status})`);
          const out = (await res.json()) as any;
          return { generation: String(out.generation) };
        },
      };
    },
  };
};

export const buildThumbnailOperations = ({ storage, buckets, attempts }: { storage: any, buckets: { thumbnails: string, staging: string }, attempts: number }) => {
  if (!buckets || !BUCKET_RE.test(buckets.thumbnails) || !BUCKET_RE.test(buckets.staging)) throw new Error("buildThumbnailOperations needs its buckets");
  if (buckets.thumbnails === LEGACY_THUMBNAIL_BUCKET) throw new Error(`Broker never writes ${LEGACY_THUMBNAIL_BUCKET}`);
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error("buildThumbnailOperations needs the step's attempts");
  return {
    "gcs.put-thumbnail": {
      kind: "write",
      credential: "service",
      // broker.js 7e: a run that stopped before any dispatch, for a
      // temporary reason, wrote nothing and may run again.
      reopensBeforeDispatch: true,
      validate: validateThumbnail,
      // Read before the claim (broker.js): the staged bytes, only if they
      // hash to the bound digest. Null when missing or mismatched;
      // any other error propagates (staging couldn't be read now).
      loadStaged: async (payload, { commandId, operationId, timeoutMs }) => {
        const bytes = await storage.read(buckets.staging, stagedObjectName({ commandId, operationId }), { timeoutMs });
        if (!bytes || sha256Hex(bytes) !== payload.sha256) return null;
        return bytes;
      },
      evidence: (payload, { commandId, operationId }) => thumbnailEvidence(payload, { bucket: buckets.thumbnails, commandId, operationId }),
      resultFromEvidence: thumbnailResultFromEvidence,
      // Reconciliation: the effect holds if the published sequence is at
      // least this capture's. A lower one, or none, is unresolved: an upload
      // in flight could still land (W5).
      readsEvidence: readableEvidence,
      observe: async (evidence, { timeoutMs }) => {
        const head = await storage.getMetadata(evidence.bucket, evidence.object, { timeoutMs });
        const sequence = publishedSequence(head);
        return { applied: head !== null && sequence >= evidence.captureSequence, observation: { found: head !== null, captureSequence: sequence } };
      },
      run: async (payload, _credential, { evidence, staged, attemptCall, onAttempt, onStep, timeLeft }) => {
        if (!(staged instanceof Uint8Array) || sha256Hex(staged) !== payload.sha256) throw new Error("a publish needs its checked staged bytes");
        const result = thumbnailResultFromEvidence(evidence);
        if (!result) throw new Error("a publish needs its evidence");
        const { bucket, object, item, captureSequence, sha256, commandId } = evidence;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          // Preparation, before the attempt is authorized. Nothing here
          // writes, so a failure is definite.
          const readMs = timeLeft();
          let head;
          try {
            head = await storage.getMetadata(bucket, object, { timeoutMs: readMs });
          } catch (e) {
            throw new NotWritten("unavailable", `the published object couldn't be read: ${String(e?.message || e)}`);
          }
          const newer = head !== null && publishedSequence(head) >= captureSequence;
          let request = null;
          if (!newer) {
            try {
              request = await storage.prepareUpload(bucket, object, staged, {
                ifGenerationMatch: head === null ? "0" : head.generation,
                metadata: { captureSequence: String(captureSequence), commandId, sha256, item },
                contentType: "image/png",
                cacheControl: "no-cache",
              });
            } catch (e) {
              throw new NotWritten("unavailable", `the upload couldn't be prepared: ${String(e?.message || e)}`);
            }
          }
          // Authorized immediately before the effect, with the time left
          // computed after the decision.
          const { timeoutMs, decisionId } = await attemptCall("publish", attempt);
          if (newer) {
            await onAttempt({ step: "publish", attempt, decisionId, observed: "newer-present" });
            await onStep("publish", { observed: "newer-present" });
            return result;
          }
          try {
            await request.send(timeoutMs);
          } catch (e) {
            if (!(e instanceof PreconditionFailed)) throw e;
            await onAttempt({ step: "publish", attempt, decisionId, observed: "precondition-failed" });
            continue;
          }
          await onAttempt({ step: "publish", attempt, decisionId, observed: "published" });
          await onStep("publish", { observed: "published" });
          return result;
        }
        throw new NotWritten("precondition-contention", `${attempts} publish attempts each found the object changed`);
      },
    },
  };
};

export const OBSERVATIONS = OBSERVED;
