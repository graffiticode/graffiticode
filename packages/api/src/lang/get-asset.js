export const buildGetAsset = ({ getBaseUrlForLanguage, bent }) => {
  return async (lang, path, { uid } = {}) => {
    const baseUrl = await getBaseUrlForLanguage(lang, { uid });
    const getLanguageAsset = bent(baseUrl, "string");
    const asset = await getLanguageAsset(path);
    return asset;
  };
};
