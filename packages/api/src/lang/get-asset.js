export const buildGetAsset = ({ getBaseUrlForLanguage, bent }) => {
  // `baseUrl`, when given, is the revision already chosen for this request
  // and is used as is.
  // @ts-expect-error TS-MIGRATE: checkJs infers a destructured parameter's type from its default; optional fields read as missing
  return async (lang, path, { uid, baseUrl: given } = {}) => {
    const baseUrl = given ?? await getBaseUrlForLanguage(lang, { uid });
    const getLanguageAsset = bent(baseUrl, "string");
    try {
      return await getLanguageAsset(path);
    } catch (err) {
      // A missing asset (language server 404) is "not found", not a gateway
      // error: signal it with null so the route can return 404 instead of 500.
      // Other failures still propagate.
      if (err && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  };
};
