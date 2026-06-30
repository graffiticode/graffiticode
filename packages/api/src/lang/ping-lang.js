export const buildPingLang = ({ getBaseUrlForLanguage, bent, log }) => {
  // Keyed by the resolved base URL (not lang) so a per-user override pinned to a
  // specific revision does not share a cached result with the default binding.
  const cache = new Map();

  const pingBaseUrl = async (baseUrl) => {
    try {
      const headLang = bent(baseUrl, "HEAD");
      await headLang("/");
      return true;
    } catch (err) {
      log(`Failed to ping language ${baseUrl}: ${err.message}`);
      return false;
    }
  };

  return async (lang, { uid } = {}) => {
    const baseUrl = await getBaseUrlForLanguage(lang, { uid });
    if (!cache.has(baseUrl)) {
      cache.set(baseUrl, pingBaseUrl(baseUrl));
    }
    const pong = await cache.get(baseUrl);
    if (!pong) {
      cache.delete(baseUrl);
    }
    return pong;
  };
};
