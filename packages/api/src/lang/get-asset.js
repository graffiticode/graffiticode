export const buildGetAsset = ({ getBaseUrlForLanguage, bent }) => {
  return async (lang, path, { uid } = {}) => {
    const baseUrl = await getBaseUrlForLanguage(lang, { uid });
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
