import { InvalidArgumentError } from "./errors/http.js";
import { normalizeLang } from "./admission.js";

// A compile generation scopes the shared compile store to one language's
// current compiler, so outputs an earlier compiler left behind are never read
// by a renderer that asks for the new ones (plan: L0158 via L0176, design
// point 5). Only L0158 has one. Its active value is set by release in
// COMPILE_GENERATION_L0158; unset, everything here is inert: /form sends L0158
// tasks to L0158 and a `generation` parameter is refused.
//
// The value is read from the environment per request rather than once at
// startup. On Cloud Run the two are the same (an env change is a new revision),
// and reading it per request lets a request capture it once, at its start, and
// keep it for its read and its write whatever changes meanwhile.
export const GENERATION_LANG = "0158";
export const GENERATION_ENV = `COMPILE_GENERATION_L${GENERATION_LANG}`;

// The value becomes part of a Firestore document id, so it may not carry a path
// separator or anything else unusual. A malformed value is treated as unset.
const GENERATION_RE = /^[A-Za-z0-9._-]{1,128}$/;

export const getActiveGeneration = (env = process.env) => {
  const value = env[GENERATION_ENV];
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !GENERATION_RE.test(value)) {
    console.log(`ERROR ${GENERATION_ENV} is malformed; treating it as unset`);
    return null;
  }
  return value;
};

// Every task in the id belongs to the generation's language.
export const allInGenerationLang = tasks =>
  Array.isArray(tasks) && tasks.length > 0 &&
  tasks.every(task => normalizeLang(task?.lang) === GENERATION_LANG);

// The `generation` query parameter: undefined when absent, otherwise exactly one
// string (a repeated parameter is refused).
export const parseGenerationParam = value => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new InvalidArgumentError("generation must be given once");
  }
  return value;
};

// A requested generation is accepted only when it is the active one and every
// task in the id is L0158, so a caller can never open another cache namespace.
export const checkGeneration = ({ generation, active, tasks }) => {
  if (generation === undefined || generation === null) return;
  if (!active) {
    throw new InvalidArgumentError("generation is not accepted: no compile generation is active");
  }
  if (generation !== active) {
    throw new InvalidArgumentError("generation is not the active compile generation");
  }
  if (!allInGenerationLang(tasks)) {
    throw new InvalidArgumentError(`generation applies only to L${GENERATION_LANG} tasks`);
  }
};

// The compile store's key for an id under a generation.
export const generationKey = (id, generation) => (generation ? `${id}@${generation}` : id);
