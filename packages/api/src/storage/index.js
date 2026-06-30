import { buildTaskStorer } from "./tasks.js";
import { buildCompileStorer } from "./compile.js";
import { buildLangOverrideStorer } from "./lang-override.js";

export const createStorers = () => {
  const compileStorer = buildCompileStorer();
  const taskStorer = buildTaskStorer();
  const langOverrideStorer = buildLangOverrideStorer();
  return { compileStorer, taskStorer, langOverrideStorer };
};
