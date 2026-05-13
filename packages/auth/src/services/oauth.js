import {
  InvalidArgumentError,
  NotFoundError,
  UnauthenticatedError,
} from "@graffiticode/common/errors";
import { isNonEmptyString } from "@graffiticode/common/utils";

const buildCreateLink = ({ oauthLinkStorer, linkedEmailsService }) => async ({ uid, provider, providerId, email }) => {
  if (!isNonEmptyString(uid)) {
    throw new InvalidArgumentError("must provide uid");
  }
  if (!isNonEmptyString(provider)) {
    throw new InvalidArgumentError("must provide provider");
  }
  if (!isNonEmptyString(providerId)) {
    throw new InvalidArgumentError("must provide providerId");
  }

  // Check if this provider ID is already linked to another account
  const exists = await oauthLinkStorer.existsByProviderId({ provider, providerId });
  if (exists) {
    throw new InvalidArgumentError("This OAuth account is already linked to another user");
  }

  const oauthLink = await oauthLinkStorer.create({ uid, provider, providerId, email });

  // Mirror the email into the unified linked_emails registry so email sign-in
  // can route into this account. Same-uid duplicates are silently absorbed by
  // the service; cross-uid conflicts will surface as ConflictError and roll
  // back the OAuth link below.
  if (linkedEmailsService && isNonEmptyString(email)) {
    try {
      await linkedEmailsService.addVerified({ uid, email });
    } catch (err) {
      // Roll back the oauth-link if the email collides with another user's
      // identity — otherwise we'd leave an OAuth link that points at a
      // contested email.
      try {
        await oauthLinkStorer.removeByUidAndProvider({ uid, provider });
      } catch {
        // best effort
      }
      throw err;
    }
  }

  return oauthLink;
};

const buildRemoveLink = ({ oauthLinkStorer }) => async ({ uid, provider }) => {
  if (!isNonEmptyString(uid)) {
    throw new InvalidArgumentError("must provide uid");
  }
  if (!isNonEmptyString(provider)) {
    throw new InvalidArgumentError("must provide provider");
  }

  await oauthLinkStorer.removeByUidAndProvider({ uid, provider });
};

const buildListLinks = ({ oauthLinkStorer }) => async ({ uid }) => {
  if (!isNonEmptyString(uid)) {
    throw new InvalidArgumentError("must provide uid");
  }

  const oauthLinks = await oauthLinkStorer.listByUid({ uid });
  return oauthLinks;
};

const buildAuthenticate = ({ oauthLinkStorer }) => async ({ provider, providerId }) => {
  if (!isNonEmptyString(provider)) {
    throw new InvalidArgumentError("must provide provider");
  }
  if (!isNonEmptyString(providerId)) {
    throw new InvalidArgumentError("must provide providerId");
  }

  try {
    const { uid } = await oauthLinkStorer.findByProviderId({ provider, providerId });
    const additionalClaims = { oauth: true, oauthProvider: provider };
    return { uid, additionalClaims };
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new UnauthenticatedError("No linked account. Please sign in with Ethereum and link this provider first.");
    }
    throw err;
  }
};

export const buildOAuthService = (deps) => {
  return {
    createLink: buildCreateLink(deps),
    removeLink: buildRemoveLink(deps),
    listLinks: buildListLinks(deps),
    authenticate: buildAuthenticate(deps),
  };
};
