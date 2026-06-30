import { admin } from "./firebase.js";

// Per-user language-server binding overrides, used for testing a specific
// language-server revision without affecting other users. Each doc is keyed by
// uid and holds a map of (uppercase, zero-padded) lang id -> full base URL:
//
//   lang-overrides/{uid} = {
//     bindings: { "L0175": "https://test42---l0175-...run.app" }
//   }
//
// Docs are seeded manually (Firestore console / script); there is no write API.

const buildLangOverrideGet = ({ db }) => async ({ uid }) => {
  if (!uid) {
    return undefined;
  }
  const overrideRef = db.doc(`lang-overrides/${uid}`);
  const overrideDoc = await overrideRef.get();
  if (!overrideDoc.exists) {
    return undefined;
  }
  return overrideDoc.data();
};

const buildLangOverrideGetBaseUrl = ({ get }) => async ({ uid, lang }) => {
  if (!uid || !lang) {
    return undefined;
  }
  const override = await get({ uid });
  const bindings = override && override.bindings;
  if (!bindings) {
    return undefined;
  }
  return bindings[lang.toUpperCase()];
};

export const buildLangOverrideStorer = () => {
  const db = admin.firestore();
  const get = buildLangOverrideGet({ db });
  const getBaseUrl = buildLangOverrideGetBaseUrl({ get });
  return { get, getBaseUrl };
};
