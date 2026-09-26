import { buildTaskStorer } from "./tasks.js";
import { buildCompileStorer } from "./compile.js";
import { buildLangOverrideStorer } from "./lang-override.js";
import { buildArtifactStorer } from "./artifacts.js";

export const createStorers = () => {
  const compileStorer = buildCompileStorer();
  const taskStorer = buildTaskStorer();
  const langOverrideStorer = buildLangOverrideStorer();
  const artifactStorer = buildArtifactStorer();
  return { compileStorer, taskStorer, langOverrideStorer, artifactStorer };
};
