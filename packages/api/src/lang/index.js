import bent from "bent";
import { getConfig } from "../config/index.js";
import { isNonEmptyString, getCompilerHost, getCompilerPort } from "../util.js";
import { buildGetBaseUrlForLanguage } from "./base-url.js";
import { buildCompile } from "./compile.js";
import { buildGetAsset } from "./get-asset.js";
import { buildPingLang } from "./ping-lang.js";
import { buildValidateOutput } from "./validate-output.js";

// One set per app, resolving overrides through the app's own storer, so the
// gateway's cache-bypass decision and the resolver read the same memo.
export const buildLang = ({ langOverrideStorer }) => {
  const getBaseUrlForLanguage = buildGetBaseUrlForLanguage({
    isNonEmptyString,
    env: process.env,
    getConfig,
    getCompilerHost,
    getCompilerPort,
    getOverrideBaseUrl: langOverrideStorer.getBaseUrl
  });
  const compile = buildCompile({ getBaseUrlForLanguage, bent });
  const getLangAsset = buildGetAsset({ getBaseUrlForLanguage, bent });
  const pingLang = buildPingLang({
    getBaseUrlForLanguage,
    bent,
    log: console.log
  });
  const validateOutput = buildValidateOutput({ getBaseUrlForLanguage, getAsset: getLangAsset });
  return { getBaseUrlForLanguage, compile, getLangAsset, pingLang, validateOutput };
};
