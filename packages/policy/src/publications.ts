// Publications: a publisher's decision to let other people, including
// anonymous viewers, see one private artifact. A publication is authority, so
// policy holds it and re-checks it live on every view and every mint. A view
// runs under the publication, never the viewer, and may use only the
// functions the registry marks viewSafe.
//
// A store implements:
//   create(record) -> record       record: { publicationId, publisherUid, ownerUid,
//                                    connectionId, lang, taskId, artifactInvocationId, createdAt }
//   get(publicationId) -> record | null
//   delete(publicationId)

import { randomUUID } from "node:crypto";

export const newPublicationId = () => `pub-${randomUUID()}`;

export const createMemoryPublicationStore = () => {
  const byId = new Map();
  return {
    async create(record) {
      byId.set(record.publicationId, { ...record });
      return { ...record };
    },
    async get(publicationId) {
      const record = byId.get(publicationId);
      return record ? { ...record } : null;
    },
    async delete(publicationId) {
      byId.delete(publicationId);
    },
  };
};
