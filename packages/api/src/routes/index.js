import { getConfig } from "./../config/index.js";
import { buildConfigHandler } from "./config.js";

export const configHandler = buildConfigHandler({ getConfig });
export { buildLangRouter } from "./lang.js";
export { buildFormRouter } from "./form.js";

export { default as auth } from "./auth.js";
export { default as compile } from "./compile.js";
export { default as data } from "./data.js";
export { default as langOverrides } from "./lang-override.js";
export { default as root } from "./root.js";
export { default as tasks } from "./tasks.js";
export { default as publications } from "./publications.js";
export { default as preview, previewSignBodyParser } from "./preview.js";
