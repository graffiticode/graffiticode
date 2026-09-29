// SPDX-License-Identifier: MIT
/**
 * Where a survey's data comes from.
 *
 * A program says which survey is being taken — `survey [id "civic-priorities" …]` — and nothing
 * about what is in it. The set of options, the title, the instructions and the bounds all live
 * out here, so that whoever takes the survey has not seen it before the first turn compiles.
 * That is the whole point of the split: a survey the taker could edit is not a survey.
 *
 * A survey is ONE JSON file per version, and everything the survey is lives in it: its options, its
 * title, its instructions and its bounds. CSV was readable here once and is not any more — it
 * carries a list and nothing else, so a survey stored that way had to fall back to generic
 * wording, which is the opposite of what a survey is for.
 *
 * A survey id names a SET of files, one per version of the survey: `civic-priorities-1.json`,
 * `civic-priorities-2.json`, and so on. Taking the survey draws one of them at random WITHOUT
 * replacement — a drawn file is marked taken until every file for that id has been taken, at
 * which point the marks clear and the cycle starts again — so that a survey with several
 * versions spreads its takers across them rather than piling onto whichever one sorts first.
 *
 * Two things make the draw survive the way the platform runs compiles:
 *
 * - **A session keeps its file.** Answering a survey rewrites the program (the response is
 *   written into it), so the program compiles a second time, and a second draw would check the
 *   response against options its taker never saw. `session-id` is carried through to here, and a
 *   session that has drawn before gets the same file back.
 * - **A file can be named outright.** `id "civic-priorities-7"` loads exactly that file, with no
 *   draw and no mark. That is the escape hatch when the memory below has been lost.
 *
 * The memory IS lossy: it is process-local, so a restart or a second server instance forgets it,
 * and a session that comes back afterwards is drawn for again. Refusing that case instead was
 * considered and is WRONG — a first turn may legitimately arrive with its answer already in it
 * ("answer the civic-priorities survey with …" through `create_item`), and a forgotten session and
 * a brand-new one are indistinguishable from here. Naming the version as the id is what makes an
 * answer immune. Making the memory durable means a store this language server does not have.
 */
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";

/**
 * The directory holding every survey, hard-coded relative to this module.
 *
 * `../data/` resolves the same from `dist/source.js` and from `src/source.ts` under vitest,
 * because `dist/` and `src/` are both children of the package. The Docker image copies the whole
 * repo and links core as a workspace, so it resolves there too.
 */
const DATA_DIR = fileURLToPath(new URL("../data/", import.meta.url));

/** A survey file, parsed. `instance` is its name without the extension. */
export interface LoadedSurvey {
  instance: string;
  data: any;
}

export interface LoadOptions {
  /** One taking of a survey. Written as `session-id get-val-public "itemId"`. */
  sessionId?: string;
}

export type SurveySource = (id: string, options: LoadOptions) => Promise<LoadedSurvey>;

/**
 * An id may name a survey (`civic-priorities`) or one of its files (`civic-priorities-7`). Anything
 * outside this shape is refused before the disk is touched, so nothing resembling a path — a
 * slash, a dot, a `..` — ever reaches `readFileSync`.
 */
const ID = /^[a-z0-9][a-z0-9-]*$/;
const INSTANCE = /^(.*)-(\d+)$/;

/** Which files belong to a survey, in file order. */
function instancesOf(id: string): string[] {
  const re = new RegExp(`^${id}-(\\d+)\\.json$`);
  return readdirSync(DATA_DIR)
    .map((f) => re.exec(f))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => m[0].replace(/\.json$/, ""));
}

/** Every survey there is, for the "no such survey" message. */
function surveyIds(): string[] {
  const ids = new Set<string>();
  for (const f of readdirSync(DATA_DIR)) {
    const m = /^(.+)-\d+\.json$/.exec(f);
    if (m) ids.add(m[1]);
  }
  return [...ids].sort();
}

function readInstance(instance: string): any {
  let text: string;
  try {
    text = readFileSync(`${DATA_DIR}${instance}.json`, "utf-8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (e: any) {
    throw new Error(
      `survey: ${instance}.json is not readable JSON — ${e?.message}. The survey's data is ` +
        "broken; this is not something the program can fix.",
      { cause: e },
    );
  }
}

/**
 * Which file each id has handed out, and which sessions hold which file.
 *
 * Module-level, so it lives as long as the process. `resetDraws` is the reset, and the tests
 * are its main caller.
 */
const taken = new Map<string, Set<string>>();
const drawn = new Map<string, { id: string; instance: string }>();

/** Clear every taken mark and every remembered session. */
export function resetDraws(): void {
  taken.clear();
  drawn.clear();
}

/** Draw an untaken file, refilling when every one of them has been taken. */
function draw(id: string, instances: string[]): string {
  let marks = taken.get(id);
  if (!marks) taken.set(id, (marks = new Set()));
  let untaken = instances.filter((i) => !marks!.has(i));
  if (!untaken.length) {
    marks.clear();
    untaken = instances;
  }
  const chosen = untaken[Math.floor(Math.random() * untaken.length)];
  marks.add(chosen);
  return chosen;
}

/**
 * The file source: read a survey out of `data/`.
 *
 * Every message names the fix, because the reader is a code generator that will act on it.
 */
const fileSource: SurveySource = async (id, { sessionId } = {}) => {
  if (!ID.test(id)) {
    throw new Error(
      `survey: ${JSON.stringify(id)} is not a survey id. An id is lower-case letters, digits and ` +
        'dashes, e.g. id "civic-priorities".',
    );
  }

  // An id that names a file loads it outright. It is how an answer pins the version it answers,
  // so it must not draw and must not consume a mark.
  const named = INSTANCE.test(id) ? readInstance(id) : undefined;
  if (named !== undefined) return { instance: id, data: named };

  const instances = instancesOf(id);
  if (!instances.length) {
    const available = surveyIds();
    throw new Error(
      `survey: there is no survey with id ${JSON.stringify(id)}. ` +
        (available.length
          ? `The surveys available are: ${available.join(", ")}.`
          : "No surveys are installed on this language server."),
    );
  }

  const held = sessionId ? drawn.get(sessionId) : undefined;
  if (held && held.id === id) {
    return { instance: held.instance, data: readInstance(held.instance) };
  }

  const instance = draw(id, instances);
  if (sessionId) drawn.set(sessionId, { id, instance });
  return { instance, data: readInstance(instance) };
};

/**
 * The seam every other source plugs into, mirroring `setSchemaFetcher` in the base language.
 *
 * The lookup is a file read today. It is behind a function so that the survey data can come
 * from somewhere else — a service, a store — without the language changing at all: a program
 * names a survey, and this is what turns that name into one.
 */
let source: SurveySource = fileSource;
export function setSource(fn?: SurveySource): void {
  source = fn || fileSource;
}

export function loadSurvey(id: string, options: LoadOptions = {}): Promise<LoadedSurvey> {
  return source(id, options);
}
