export const buildGetAsset = ({ getBaseUrlForLanguage, bent }) => {
  return async (lang, path) => {
    const baseUrl = getBaseUrlForLanguage(lang);
    const getLanguageAsset = bent(baseUrl, "string");
    const asset = await getLanguageAsset(path);
    return asset;
  };
};
