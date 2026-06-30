import bent from "bent";
import { getConfig } from "../config/index.js";
import { isNonEmptyString, getCompilerHost, getCompilerPort } from "../util.js";
import { buildLangOverrideStorer } from "../storage/lang-override.js";
import { buildGetBaseUrlForLanguage } from "./base-url.js";
import { buildCompile } from "./compile.js";
import { buildGetAsset } from "./get-asset.js";
import { buildPingLang } from "./ping-lang.js";

const langOverrideStorer = buildLangOverrideStorer();

export const getBaseUrlForLanguage = buildGetBaseUrlForLanguage({
  isNonEmptyString,
  env: process.env,
  getConfig,
  getCompilerHost,
  getCompilerPort,
  getOverrideBaseUrl: langOverrideStorer.getBaseUrl
});
export const compile = buildCompile({ getBaseUrlForLanguage, bent });
export const getLangAsset = buildGetAsset({ getBaseUrlForLanguage, bent });
export const pingLang = buildPingLang({
  getBaseUrlForLanguage,
  bent,
  log: console.log
});
