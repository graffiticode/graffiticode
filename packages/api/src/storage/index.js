import { buildTaskStorer } from "./tasks.js";
import { buildCompileStorer } from "./compile.js";
import { buildLangOverrideStorer } from "./lang-override.js";
import { buildArtifactStorer } from "./artifacts.js";
import { buildStageResultStorer } from "./stage-results.js";

export const createStorers = () => {
  const compileStorer = buildCompileStorer();
  const taskStorer = buildTaskStorer();
  const langOverrideStorer = buildLangOverrideStorer();
  const artifactStorer = buildArtifactStorer();
  const stageResultStorer = buildStageResultStorer();
  return { compileStorer, taskStorer, langOverrideStorer, artifactStorer, stageResultStorer };
};
