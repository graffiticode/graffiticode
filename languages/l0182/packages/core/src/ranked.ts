// SPDX-License-Identifier: MIT
/**
 * The ranked-choice style: a set of options, some of which a response chooses and puts in
 * priority order, plus at most one write-in that was not in the set.
 *
 * Everything here is the survey's data checked and assembled, or a response checked against
 * it. `survey.ts` decides which style a survey is and calls in; `rating.ts` is the other style.
 */
import { indexOf, resolveRef, showValue } from "./resolve.js";

/**
 * An option as the survey's data holds it: a bare line of text, or a record carrying the
 * originating service's own id.
 *
 * Both forms exist for one reason. A survey's options come from wherever the survey came from,
 * and when that carried ids they have to survive into `choices`, because a ranking of positional
 * ids means nothing back at the service they came from. A bare string is the shorthand for a set
 * that had no ids of its own.
 */
export interface Option {
  id: string;
  text: string;
}

/** A ranked-choice survey file: its options, alongside its own words and bounds. */
interface RankedData {
  title?: string;
  instructions?: string;
  minChoices?: number;
  maxChoices?: number;
  options: any[];
}

export interface RankedResponse {
  /** Option ids, in priority order. The order IS the ranking. */
  choices: string[];
  /** One option that was not in the set. Absent when none was contributed. */
  writeIn?: string;
}

/**
 * A ranked-choice response as written, before it is checked against the set it answers.
 *
 * `choices` may name each option by its text, its id or its position, and all three are resolved
 * to ids by `resolveRankedResponse` — the compiled record only ever carries ids, so the input
 * sugar costs nothing downstream and both clients still emit the identical shape.
 */
export interface AuthoredRanked {
  choices: Array<string | number>;
  writeIn?: string;
}

/**
 * The wording a survey falls back to when its data says nothing.
 *
 * Deliberately says what the page IS and what to do, and deliberately says nothing about how
 * many may be chosen — the bounds line beneath it is derived from minChoices/maxChoices, and a
 * fallback that guessed at the count would contradict it.
 */
export const DEFAULT_INSTRUCTIONS =
  "Below is a list of options. Please choose the ones that matter most to you.";

/** The ranked-choice half of a compiled survey. `survey.ts` adds id, session and instance. */
export interface RankedFields {
  style: "ranked-choice";
  title?: string;
  instructions: string;
  options: Option[];
  minChoices: number;
  maxChoices: number;
}

/**
 * Check what a ranked-choice file holds.
 *
 * These messages are for whoever maintains the survey data, not for the program: a program
 * cannot cause or fix any of them. They still name the file, because that is the only thing
 * that locates the fault.
 */
function assertLoaded(instance: string, list: any): any[] {
  if (!Array.isArray(list) || !list.length) {
    throw new Error(
      `survey: ${instance} holds no options. A ranked-choice survey's data has an \`options\` ` +
        "list alongside its title and instructions.",
    );
  }
  list.forEach((entry, i) => {
    const where = `survey: ${instance}, option ${i + 1}`;
    if (typeof entry === "string") {
      if (!entry.trim()) throw new Error(`${where} is empty. Every option is a line of text.`);
      return;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `${where} is ${showValue(entry)}. Every option is a line of text, or a record naming its ` +
          'id — e.g. {"id": "a3", "text": "affordable housing"}.',
      );
    }
    if (typeof entry.text !== "string" || !entry.text.trim()) {
      throw new Error(`${where} has no \`text\`, the line to show.`);
    }
    if (entry.id !== undefined && (typeof entry.id !== "string" || !entry.id.trim())) {
      throw new Error(`${where} has an \`id\` that is ${showValue(entry.id)}; ids are strings.`);
    }
  });
  return list;
}

/**
 * Give every option an id.
 *
 * An entry that named its own id keeps it — that id came from the service the set came from,
 * and a ranking of positional ids would mean nothing back there. An entry that did not is
 * numbered by position, `o0` upward, which is derived rather than authored so that nothing can
 * be chosen under a name the set does not offer.
 */
function normaliseOptions(raw: any[]): Option[] {
  return raw.map((entry, i) =>
    typeof entry === "string"
      ? { id: `o${i}`, text: entry.trim() }
      : { id: typeof entry.id === "string" ? entry.id : `o${i}`, text: String(entry.text).trim() },
  );
}

/** Reject a set that cannot support a meaningful choice, or that cannot be chosen from unambiguously. */
function assertOptions(instance: string, options: Option[]): void {
  if (options.length < 2) {
    throw new Error(
      `survey: ${instance} has ${options.length === 1 ? "only one option" : "no options"}, so there is ` +
        "nothing to choose between. A survey needs at least two.",
    );
  }
  const byText = new Map<string, number>();
  const byId = new Map<string, number>();
  options.forEach((option, i) => {
    const seenText = byText.get(option.text);
    if (seenText !== undefined) {
      throw new Error(
        `survey: ${instance} has options ${seenText + 1} and ${i + 1} both ${JSON.stringify(option.text)}. ` +
          "Each option must be distinct — a duplicate splits the choice between two entries that mean the same thing.",
      );
    }
    byText.set(option.text, i);
    const seenId = byId.get(option.id);
    if (seenId !== undefined) {
      throw new Error(
        `survey: ${instance} has options ${seenId + 1} and ${i + 1} sharing the id ${JSON.stringify(option.id)}, so a ` +
          "choice naming it is ambiguous. Give each option its own id, or drop the ids and let them be numbered by position.",
      );
    }
    byId.set(option.id, i);
  });
}

/** How many options a response may name when the survey does not say. */
const DEFAULT_MIN_CHOICES = 1;
/** Capped again at one fewer than the set, so a default never permits choosing everything. */
const DEFAULT_MAX_CHOICES = 5;

/**
 * Resolve and check the bounds a response must satisfy.
 *
 * The default ceiling is five, or one fewer than the set when the set is smaller — so a default
 * never lets a response name every option there is. Choosing all of them is not choosing, and a
 * survey that ends up asking for it by accident has stopped measuring anything.
 *
 * The clamp applies to the DEFAULT only. A survey of three options that never mentioned
 * `maxChoices` must not fail to compile over a number its author never wrote. Writing
 * `maxChoices: 3` over three options is a different thing — an explicit claim about this survey,
 * and the author's to make; only a ceiling larger than the set is refused.
 */
function resolveBounds(
  instance: string,
  data: RankedData,
  options: Option[],
): { minChoices: number; maxChoices: number } {
  const minChoices = data.minChoices !== undefined ? data.minChoices : DEFAULT_MIN_CHOICES;
  const maxChoices =
    data.maxChoices !== undefined
      ? data.maxChoices
      : Math.min(DEFAULT_MAX_CHOICES, options.length - 1);

  if (!Number.isInteger(minChoices) || minChoices < 0) {
    throw new Error(
      `survey: ${instance} has a \`minChoices\` of ${minChoices}; it must be a whole number of 0 or more.`,
    );
  }
  if (!Number.isInteger(maxChoices) || maxChoices < 1) {
    throw new Error(
      `survey: ${instance} has a \`maxChoices\` of ${maxChoices}; it must be a whole number of at least 1.`,
    );
  }
  if (minChoices > maxChoices) {
    throw new Error(
      `survey: ${instance} asks for at least ${minChoices} and at most ${maxChoices}, so no ` +
        "selection can satisfy both.",
    );
  }
  if (maxChoices > options.length) {
    throw new Error(
      `survey: ${instance} allows ${maxChoices} choices but holds ${options.length} options, so there ` +
        "are never enough options to pick that many.",
    );
  }
  return { minChoices, maxChoices };
}

/**
 * Assemble a ranked-choice survey from its data. A bare list is the shorthand for a set with
 * nothing else to say, and gets the defaults for everything but the options.
 */
export function assembleRanked(instance: string, raw: any): RankedFields {
  const data: RankedData = Array.isArray(raw) ? { options: raw } : raw;
  const options = normaliseOptions(assertLoaded(instance, data.options));
  assertOptions(instance, options);
  const { minChoices, maxChoices } = resolveBounds(instance, data, options);

  // Every compiled survey carries instructions, because a participant arrives cold and a bare
  // list of options does not tell them what they are looking at. Falling back rather than
  // refusing is deliberate: a survey that compiles with generic wording is still usable, whereas
  // a hard error would fail a program over prose — and the generic line is visibly generic, which
  // is what prompts someone to fix the survey's data. This is the floor, not the goal.
  return {
    style: "ranked-choice",
    ...(data.title !== undefined ? { title: data.title } : {}),
    instructions: data.instructions !== undefined ? data.instructions : DEFAULT_INSTRUCTIONS,
    options,
    minChoices,
    maxChoices,
  };
}

/**
 * Check a ranked-choice response against the set it answers, and resolve it to ids.
 *
 * Every entry must name an option that is actually in the set: a choice is a claim about what
 * was chosen, and one naming an option nobody was offered is not a wrong answer but a
 * meaningless one.
 */
export function resolveRankedResponse(
  authored: AuthoredRanked,
  survey: RankedFields,
): RankedResponse {
  const { writeIn } = authored;
  const index = indexOf(survey.options);
  const choices: string[] = [];
  const seen = new Set<string>();

  authored.choices.forEach((ref, i) => {
    const { id } = resolveRef(ref, `response: \`choices\` entry ${i + 1}`, index, "option");
    if (seen.has(id)) {
      // Reported by id rather than as written, because `choices ["o0" 0]` — or an id beside the
      // same option's text — names one option twice in two notations, and saying which option it
      // is is the whole point of the message.
      throw new Error(
        `response: \`choices\` names ${JSON.stringify(id)} twice. An option holds one place in the ` +
          "order, so each id may appear once.",
      );
    }
    seen.add(id);
    choices.push(id);
  });

  if (choices.length < survey.minChoices) {
    throw new Error(
      `response: \`choices\` has ${choices.length} ${choices.length === 1 ? "option" : "options"}, ` +
        `but this survey's \`minChoices\` is ${survey.minChoices}. Choose more options.`,
    );
  }
  if (choices.length > survey.maxChoices) {
    throw new Error(
      `response: \`choices\` has ${choices.length} options, but this survey's \`maxChoices\` is ` +
        `${survey.maxChoices}. Choose fewer options — keep the most important ones.`,
    );
  }

  if (writeIn !== undefined) {
    const clash = survey.options.find((x) => x.text.toLowerCase() === writeIn.toLowerCase());
    if (clash) {
      throw new Error(
        `response: \`write-in\` repeats ${JSON.stringify(clash.text)}, which is already in the set as ` +
          `${JSON.stringify(clash.id)}. \`write-in\` is for one that is NOT there — choose the existing one instead.`,
      );
    }
  }

  return { choices, ...(writeIn !== undefined ? { writeIn } : {}) };
}
