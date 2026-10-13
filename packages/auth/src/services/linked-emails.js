import { ConflictError, InvalidArgumentError } from "@graffiticode/common/errors";
import { isNonEmptyString } from "@graffiticode/common/utils";

const buildAddVerified = ({ linkedEmailStorer }) => async ({ uid, email, verifiedAt }) => {
  if (!isNonEmptyString(uid)) {
    throw new InvalidArgumentError("must provide uid");
  }
  if (!isNonEmptyString(email)) {
    throw new InvalidArgumentError("must provide email");
  }
  // The storage layer raises ConflictError with { conflictUid } if the email
  // is already linked to anyone (including the same uid). Let same-uid
  // duplicates pass through as a no-op success — that's idempotent re-adds.
  try {
    return await linkedEmailStorer.create({ uid, email, verifiedAt });
  } catch (err) {
    if (err instanceof ConflictError && err.details?.conflictUid === uid) {
      const existing = await linkedEmailStorer.findByEmail({ email });
      return existing;
    }
    throw err;
  }
};

const buildList = ({ linkedEmailStorer }) => async ({ uid }) => {
  if (!isNonEmptyString(uid)) {
    throw new InvalidArgumentError("must provide uid");
  }
  return linkedEmailStorer.listByUid({ uid });
};

const buildRemove = ({ linkedEmailStorer }) => async ({ uid, id }) => {
  if (!isNonEmptyString(uid)) {
    throw new InvalidArgumentError("must provide uid");
  }
  if (!isNonEmptyString(id)) {
    throw new InvalidArgumentError("must provide id");
  }
  await linkedEmailStorer.removeById({ id, uid });
};

const buildLookup = ({ linkedEmailStorer }) => async ({ email }) => {
  if (!isNonEmptyString(email)) {
    throw new InvalidArgumentError("must provide email");
  }
  return linkedEmailStorer.findByEmail({ email });
};

export const EMAIL_SEARCH_MIN_LENGTH = 2;
export const EMAIL_SEARCH_MAX_RESULTS = 25;

// Uids whose linked email contains the fragment (case-insensitive). Never
// returns the emails themselves.
const buildSearch = ({ linkedEmailStorer }) => async ({ fragment }) => {
  const needle = typeof fragment === "string" ? fragment.trim().toLowerCase() : "";
  if (needle.length < EMAIL_SEARCH_MIN_LENGTH) {
    throw new InvalidArgumentError(`fragment must be at least ${EMAIL_SEARCH_MIN_LENGTH} characters`);
  }
  const uids = await linkedEmailStorer.searchUidsByEmailFragment({
    fragment: needle,
    limit: EMAIL_SEARCH_MAX_RESULTS,
  });
  return [...new Set(uids)].slice(0, EMAIL_SEARCH_MAX_RESULTS);
};

export const buildLinkedEmailsService = (deps) => ({
  addVerified: buildAddVerified(deps),
  list: buildList(deps),
  remove: buildRemove(deps),
  lookup: buildLookup(deps),
  search: buildSearch(deps),
});
