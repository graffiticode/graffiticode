const noop = _ => { };

export const buildPingLang = ({ getBaseUrlForLanguage, bent, log }) => {
  const cache = new Map();

  const pingLangInternal = async (lang) => {
    const baseUrl = getBaseUrlForLanguage(lang);
    try {
      const headLang = bent(baseUrl, "HEAD");
      await headLang("/");
      return true;
    } catch (err) {
      log(`Failed to ping language ${baseUrl}: ${err.message}`);
      return false;
    }
  };

  return async (lang, resume) => {
    if (typeof resume !== "function") {
      resume = noop;
    }

    if (!cache.has(lang)) {
      cache.set(lang, pingLangInternal(lang));
    }
    const pong = await cache.get(lang);
    if (!pong) {
      cache.delete(lang);
    }

    resume(pong);
    return pong;
  };
};
