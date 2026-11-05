export const buildGetBaseUrlForLanguage = ({
  isNonEmptyString,
  env,
  getConfig,
  getCompilerHost,
  getCompilerPort,
  getOverrideBaseUrl
// @ts-expect-error TS-MIGRATE: checkJs infers a destructured parameter's type from its default; optional fields read as missing
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

// Where a browser is sent for a language's form (routes/form.js): its public
// URL. The api reaches a language service by BASE_URL_<LANG>, which for a
// switched language is its Cloud Run host, so the api's own calls skip the
// proxied domain (resets and stray 401s under load, the B5 drive, 2026-11-05).
// Browsers, the View and embeds keep the domain: PUBLIC_URL_<LANG>, when set.
// A tester's override wins here too; otherwise it is the base URL, as before.
export const buildGetPublicBaseUrlForLanguage = ({ isNonEmptyString, env, getOverrideBaseUrl, getBaseUrlForLanguage }) =>
  async (lang, { uid } = /** @type {{ uid?: string }} */ ({})) => {
    if (Number.isInteger(Number.parseInt(lang, 10))) {
      lang = `L${lang}`;
    }
    if (uid && typeof getOverrideBaseUrl === "function") {
      const overrideBaseUrl = await getOverrideBaseUrl({ uid, lang });
      if (isNonEmptyString(overrideBaseUrl)) {
        return overrideBaseUrl;
      }
    }
    const publicUrl = env[`PUBLIC_URL_${String(lang).toUpperCase()}`];
    if (isNonEmptyString(publicUrl)) {
      return publicUrl;
    }
    return getBaseUrlForLanguage(lang, { uid });
  };
