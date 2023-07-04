import { buildTaskStorer } from "./tasks.js";
import { buildCompileStorer } from "./compile.js";

export const createStorers = () => {
  const compileStorer = buildCompileStorer();
  const taskStorer = buildTaskStorer();
  return { compileStorer, taskStorer };
};
