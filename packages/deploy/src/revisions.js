// Approved compiler revisions (capability plan W4, section A). A revision of a
// pinnable service (deploy.json `pinnable: { lang }`) may be pinned by an
// admitted plan only while its record in the `revisions` Firestore database
// says `approved`. Only the deploy identity writes that database; Policy's
// runtime account reads it (IAM, scoped to the database). The CLI writes and
// reads it over Firestore's REST API with the operator's gcloud token.
// Retirement (approved -> retiring -> retired) belongs to scripts/revisions.js,
// which fences admissions in flight first (@graffiticode/policy/revisions).
//
// languages/{lang}/revisions/{revision}:
//   lang, service, revision, tag, tagUrl, imageDigest, commit, releaseId,
//   contractVersions [int], status "approved" | "retiring" | "retired",
//   approvedAt, and later retiringSince/retiringBy, retiredAt, cancelledAt.

import { requireValue } from "./config.js";

export const REVISIONS_DATABASE = "revisions";
export const STATUSES = ["approved", "retiring", "retired"];

const documents = config => `projects/${config.project}/databases/${config.pinnable?.database ?? REVISIONS_DATABASE}/documents`;
export const revisionPath = (config, revision) => `${documents(config)}/languages/${config.pinnable.lang}/revisions/${revision}`;

// Firestore's REST value encoding, for the fields a record holds.
const encode = value => {
  if (value === null) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  throw new Error(`cannot store ${typeof value} in a revision record`);
};
const decode = value => {
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(decode);
  throw new Error("unexpected value in a revision record");
};
export const encodeFields = record => Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encode(v)]));
export const decodeFields = fields => Object.fromEntries(Object.entries(fields ?? {}).map(([k, v]) => [k, decode(v)]));

// The record a release approves, from its receipt and the service as deployed.
export function approvalRecord(config, receipt, service) {
  const tagged = (service.status?.traffic ?? []).find(entry => entry.tag === receipt.id);
  requireValue(tagged?.url && tagged.revisionName === receipt.revision, "The release's tag does not reach its revision");
  const imageDigest = receipt.image?.split("@")[1];
  requireValue(/^sha256:[a-f0-9]{64}$/.test(imageDigest ?? ""), "The release has no image digest");
  return {
    lang: config.pinnable.lang,
    service: config.service,
    revision: receipt.revision,
    tag: receipt.id,
    tagUrl: tagged.url,
    imageDigest,
    commit: receipt.commit,
    releaseId: receipt.id,
    contractVersions: config.pinnable.contractVersions ?? [1],
    status: "approved",
    approvedAt: new Date(),
  };
}

// Firestore's REST API as the operator: `accessToken()` is their gcloud token.
export const createFirestoreRest = ({ project, accessToken, fetch: request = fetch }) => async (method, resource, body) => {
  const res = await request(`https://firestore.googleapis.com/v1/${resource}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, "x-goog-user-project": project, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

// `firestore(method, path, body)` -> { status, json }: an authenticated call
// to https://firestore.googleapis.com/v1/<path>.
export function createRevisionClient(config, firestore) {
  return {
    // Creates the record; never overwrites one (a revision is approved once).
    async approve(record) {
      const res = await firestore("PATCH", `${revisionPath(config, record.revision)}?currentDocument.exists=false`, { fields: encodeFields(record) });
      requireValue(res.status >= 200 && res.status < 300, `Approving ${record.revision} failed: ${res.status} ${JSON.stringify(res.json)?.slice(0, 200)}`);
      return record;
    },
    // Every record for the service's language, by revision name.
    async list() {
      const records = new Map();
      let pageToken;
      do {
        const query = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "";
        const res = await firestore("GET", `${documents(config)}/languages/${config.pinnable.lang}/revisions${query}`);
        requireValue(res.status >= 200 && res.status < 300, `Reading revisions failed: ${res.status}`);
        for (const doc of res.json?.documents ?? []) {
          const record = decodeFields(doc.fields);
          records.set(record.revision, record);
        }
        pageToken = res.json?.nextPageToken;
      } while (pageToken);
      return records;
    },
  };
}

// Tags a pinnable service keeps on revisions that serve no traffic: those of
// approved revisions, and of revisions being retired, until the retirement
// itself removes the tag. A `retired` revision without `tagRemovedAt` is still
// in its wait for proofs issued before retirement to expire (or was
// interrupted there): routine cleanup must not cut that wait short.
const keepsTag = record => ["approved", "retiring"].includes(record?.status) || (record?.status === "retired" && !record.tagRemovedAt);
export const retainedTags = (service, records) => (service.status?.traffic ?? [])
  .filter(entry => entry.tag && keepsTag(records.get(entry.revisionName)))
  .map(entry => entry.tag);

// Reachable revisions of a pinnable service (serving, or tagged) that must not
// be: unknown to the store, mid-retirement, retired but still tagged, or
// without the contract version required now.
export function reachableProblems(service, records, { minContractVersion = 1 } = {}) {
  const reachable = new Set((service.status?.traffic ?? []).map(entry => entry.revisionName).filter(Boolean));
  const problems = { unapproved: [], retiring: [], retired: [], unsupportedContract: [] };
  for (const revision of [...reachable].sort()) {
    const record = records.get(revision);
    if (!record) problems.unapproved.push(revision);
    else if (record.status === "retiring") problems.retiring.push(revision);
    else if (record.status === "retired") problems.retired.push(revision);
    else if (!(record.contractVersions ?? []).includes(minContractVersion)) problems.unsupportedContract.push(revision);
  }
  return { reachable: [...reachable].sort(), ...problems };
}
