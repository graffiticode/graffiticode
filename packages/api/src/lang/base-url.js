export const buildGetBaseUrlForLanguage = ({
  isNonEmptyString,
  env,
  getConfig,
  getCompilerHost,
  getCompilerPort,
  getOverrideBaseUrl
}) => async (lang, { uid } = {}) => {
  if (Number.isInteger(Number.parseInt(lang, 10))) {
    lang = `L${lang}`;
  }
  if (!isNonEmptyString(lang)) {
    throw new Error("lang must be a non empty string");
  }
  // A per-user override wins over env and config so a tester can be pinned to a
  // specific language-server revision without affecting anyone else.
  if (uid && typeof getOverrideBaseUrl === "function") {
    const overrideBaseUrl = await getOverrideBaseUrl({ uid, lang });
    if (isNonEmptyString(overrideBaseUrl)) {
      return overrideBaseUrl;
    }
  }
  const envBaseUrl = env[`BASE_URL_${lang.toUpperCase()}`];
  if (isNonEmptyString(envBaseUrl)) {
    return envBaseUrl;
  }
  const config = getConfig() || {};
  const host = getCompilerHost(lang, config);
  const port = getCompilerPort(lang, config);
  let protocol = "https";
  if (host === "localhost") {
    protocol = "http";
  } else if (isNonEmptyString(config.protocol)) {
    protocol = config.protocol;
  }
  return `${protocol}://${host}:${port}`;
};
