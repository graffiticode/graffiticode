// SPDX-License-Identifier: MIT
/**
 * Cutting a sentence into text and blanks, and binding each blank to its response.
 *
 * Pure: no AST, no CPS, no compiler types — the same shape as `hottext.ts`, and for the same
 * reason: the logic is worth testing on its own.
 *
 * The marker is `{{<id>}}` and the id is the response's identifier, so the answer binds to the
 * blank BY NAME. That is the one property worth taking from QTI here, where an inline
 * `<qti-text-entry-interaction response-identifier="RESPONSE"/>` binds to a sibling
 * `<qti-response-declaration identifier="RESPONSE">`. Learnosity's `{{response}}` carries no
 * identity and its answers are a parallel array matched by order of appearance, so reordering a
 * clause silently misaligns every answer after it. The delimiters here are theirs; the binding
 * is not.
 *
 * How an answer is compared lives in `matching.ts`, shared with the scorer so a collision this
 * module refuses cannot become a match at score time.
 */
import { assertAssessWords } from "./attributes.js";
import { NUMBER_FORMATS, normalize, parseNumber, permittedFormats, terminates } from "./matching.js";

/**
 * A literal run of the sentence.
 *
 * Every marker model has these; what sits BETWEEN them is what differs, which is why
 * `cutMarkers` is generic over the hole and not over the text around it.
 */
export interface TextSegment {
  text: string;
}

/** One run of the sentence: literal text, or a blank the candidate types into. */
export interface Segment {
  /** Present on a literal run. */
  text?: string;
  /** Present on a blank: the response's identifier. */
  id?: string;
  blank?: true;
  /**
   * A blank that takes a number, so the renderer can ask for a numeric keypad.
   *
   * Presentational rather than key material — the sentence already tells the candidate a number
   * is wanted — which is why it rides here and survives a graded delivery that withholds
   * `validation`.
   */
  numeric?: true;
}

/** One answer a blank recognizes, already merged. */
export interface Response {
  response?: string;
  assess?: { correct?: boolean; points?: number; rationale?: string };
}

/** One blank, already merged. */
export interface Blank {
  id?: string;
  responses?: Response[];
  caseSensitive?: boolean;
  baseType?: "string" | "float" | "integer";
  tolerance?: number;
  inputFormats?: string[];
}

/** What one recognized answer is worth. The shape of a choice mapping value, plus its text. */
export interface Recognized {
  response: string;
  correct?: true;
  points: number;
  rationale?: string;
}

/**
 * What a blank is worth and what it recognizes.
 *
 * Comparing a typed answer against these happens in the scorer, not here — the compiler builds
 * this and never reads it back.
 */
export interface Entry {
  /** What this blank's answers are made of. Emitted on every entry, so none defaults by absence. */
  baseType: "string" | "float" | "integer";
  points: number;
  /** `string` only. */
  caseSensitive?: boolean;
  /** Numeric only, and only when authored. Absent means an exact decimal comparison. */
  tolerance?: number;
  /**
   * Numeric only, and only when it constrains something.
   *
   * Absent means every form is accepted, which is what `numeric` expands to — so the common
   * key stays small and the field appears exactly when a question is asking for a form.
   */
  inputFormats?: string[];
  responses: Recognized[];
}

const MARKER = /\{\{([^{}]*)\}\}/g;

export interface Cut {
  segments: Segment[];
  mapping: Record<string, Entry>;
}

/**
 * Cut the text at its markers and bind each blank to what it recognizes.
 *
 * Every mismatch is a compile error naming the fix. Named binding is what makes these checks
 * possible at all — a positional model cannot say which answer is orphaned, and L0176 does not
 * even check that the marker count matches the answer count.
 */
export function cut(
  text: string,
  blanks: Blank[],
  caseSensitive: boolean,
  where: string,
): Cut {
  const declared = new Map<string, Entry>();
  blanks.forEach((b, i) => {
    const at = `${where}: blank ${i + 1}`;
    const id = typeof b.id === "string" ? b.id.trim() : "";
    if (!id) {
      throw new Error(
        `${at}: needs an \`id\`, which is what the marker in the text refers to — ` +
          'e.g. [ id "capital" responses [ [ response "Paris" assess [ correct ] ] ] {} ] ' +
          "with {{capital}} in the text.",
      );
    }
    if (declared.has(id)) {
      throw new Error(`${at}: the id "${id}" is already used. Each blank needs its own.`);
    }
    if (!Array.isArray(b.responses) || !b.responses.length) {
      throw new Error(
        `${at}: needs at least one response, e.g. responses [ [ response "Paris" assess [ correct ] ] ] {}.`,
      );
    }

    const baseType = b.baseType !== undefined ? b.baseType : "string";
    const numeric = baseType !== "string";
    if (numeric && b.caseSensitive !== undefined) {
      throw new Error(
        `${at}: \`case-sensitive\` means nothing on a ${baseType} blank — numbers have no case. ` +
          "Remove it, or drop `base-type` to compare the answers as text.",
      );
    }
    if (!numeric && b.tolerance !== undefined) {
      throw new Error(
        `${at}: \`tolerance\` means nothing on a text blank — it is how close a NUMBER may be. ` +
          'Add `base-type "float"` to compare numerically, or remove the tolerance.',
      );
    }
    if (b.tolerance !== undefined && b.tolerance < 0) {
      throw new Error(`${at}: tolerance ${b.tolerance} is negative. It is a distance, so it cannot be.`);
    }
    if (!numeric && b.inputFormats !== undefined) {
      throw new Error(
        `${at}: \`input-formats\` means nothing on a text blank — it says how a NUMBER may be ` +
          'written. Add `base-type "float"`, or remove it.',
      );
    }
    if (b.inputFormats && b.inputFormats.includes("numeric") && b.inputFormats.length > 1) {
      throw new Error(
        `${at}: \`numeric\` already means every form, so listing it beside ` +
          `${b.inputFormats.filter((x) => x !== "numeric").map((x) => `\`${x}\``).join(" and ")} ` +
          "says two different things. List the forms you want, or just `numeric`.",
      );
    }
    // `numeric` expands here, so the scorer is handed the forms themselves and has no umbrella
    // to remember. Omitted when it permits everything, which is the common case.
    const allowed = permittedFormats(b.inputFormats);
    const constrains = allowed.length < NUMBER_FORMATS.length;

    const cs = numeric ? false : b.caseSensitive !== undefined ? b.caseSensitive === true : caseSensitive;
    const recognized: Recognized[] = [];
    const claimed = new Map<string, number>();
    const numbers: { at: number; value: ReturnType<typeof parseNumber>; text: string }[] = [];
    b.responses.forEach((r, j) => {
      const rat = `${at}: response ${j + 1}`;
      const value = typeof r.response === "string" ? r.response.trim() : "";
      if (!value) {
        throw new Error(
          `${rat}: needs the answer it recognizes, e.g. [ response "Paris" assess [ correct ] ].`,
        );
      }
      if (numeric) {
        const parsed = parseNumber(value);
        if (!parsed) {
          throw new Error(
            `${rat}: "${value}" is not a number this can compare. Whole numbers, decimals and ` +
              "simple fractions are understood — 8, -3, 0.5, .5, 1/2, 1,000. Expressions, units " +
              "and symbols are not.",
          );
        }
        if (baseType === "integer" && !parsed.value.isInteger()) {
          throw new Error(
            `${rat}: "${value}" is not a whole number, but the blank says \`base-type "integer"\`. ` +
              'Use `base-type "float"`, or give a whole number.',
          );
        }
        // A repeating value is unreachable by typing: 1/3 is twenty threes here, and 0.333,
        // 0.3333 and every decimal a candidate would actually write compare unequal. Left
        // alone this grades silently — right answer, no mark, no explanation — which is the
        // exact failure numeric blanks exist to remove. So it is refused unless the author
        // has said which way out they want: ask for a fraction, or say how close is close
        // enough. Only a fraction can reach such a value at all.
        if (!terminates(value) && b.tolerance === undefined && allowed.some((f) => f !== "fraction")) {
          throw new Error(
            `${rat}: "${value}" has no exact decimal form, so no decimal a candidate types can ` +
              "ever match it — 0.333 and 0.3333 would both be wrong, with nothing said about " +
              'why. Either ask for a fraction with `input-formats [ "fraction" ]`, which says ' +
              "so when one is not given, or add a `tolerance` saying how close a decimal must be.",
          );
        }
        // Two answers collide when one typed value could match both — for numbers, when their
        // tolerance intervals overlap, which is a gap of at most twice the tolerance.
        const reach = b.tolerance !== undefined ? b.tolerance * 2 : 0;
        const clash = numbers.find((prev) => prev.value!.value.sub(parsed.value).abs().lte(reach));
        if (clash) {
          throw new Error(
            `${rat}: "${value}" is the same answer as response ${clash.at} ("${clash.text}")` +
              (b.tolerance !== undefined ? ` within a tolerance of ${b.tolerance}` : "") +
              ". Two responses cannot claim the same typed input — merge them, or tighten the " +
              "tolerance so they are told apart.",
          );
        }
        numbers.push({ at: j + 1, value: parsed, text: value });
      } else {
        const norm = normalize(value, cs);
        const prior = claimed.get(norm);
        if (prior !== undefined) {
          throw new Error(
            `${rat}: "${value}" is the same answer as response ${prior}` +
              (cs ? "" : " once capitals are ignored") +
              ". Two responses cannot claim the same typed input — merge them, or set " +
              "`case-sensitive true` if the difference is meant to matter.",
          );
        }
        claimed.set(norm, j + 1);
      }

      const assess = r.assess;
      if (assess === undefined) {
        // A recognized answer worth nothing and unexplained is just a wrong answer, which the
        // blank already handles by not recognizing it.
        throw new Error(
          `${rat}: needs an \`assess\` saying what "${value}" is worth — ` +
            "`assess [correct]` for a right answer, `assess [points 1]` for partial credit, " +
            '`assess [rationale "…"]` to explain a wrong one.',
        );
      }
      assertAssessWords(assess, ["correct", "points", "rationale"], rat);
      const isCorrect = assess.correct === true;
      const hasPoints = typeof assess.points === "number";
      const hasRationale = typeof assess.rationale === "string";
      if (!isCorrect && !hasPoints && !hasRationale) {
        throw new Error(
          `${rat}: assess must say what it asserts — \`correct\`, \`points\`, or \`rationale\`.`,
        );
      }
      recognized.push({
        response: value,
        ...(isCorrect ? { correct: true as const } : {}),
        points: hasPoints ? (assess.points as number) : isCorrect ? 1 : 0,
        ...(hasRationale ? { rationale: assess.rationale as string } : {}),
      });
    });

    const correct = recognized.filter((r) => r.correct);
    if (!correct.length) {
      throw new Error(
        `${at}: no response is marked \`correct\`, so the blank cannot be scored. ` +
          "Add `assess [correct]` to the right answer.",
      );
    }
    // Only one answer can be typed, so the blank is worth its best correct one — not their sum.
    // `choice` sums because several options can be selected; the difference is cardinality.
    declared.set(id, {
      baseType,
      points: Math.max(...correct.map((r) => r.points)),
      ...(numeric
        ? {
            ...(b.tolerance !== undefined ? { tolerance: b.tolerance } : {}),
            ...(constrains ? { inputFormats: [...allowed] } : {}),
          }
        : { caseSensitive: cs }),
      responses: recognized,
    });
  });

  return {
    segments: cutMarkers(text, declared, TEXT_ENTRY_WORDS, where, (id, entry) => ({
      id,
      blank: true,
      ...(entry.baseType !== "string" ? { numeric: true as const } : {}),
    })),
    mapping: Object.fromEntries(declared),
  };
}

/* ------------------------------------------------------ Markers, shared with inline-choice */

/**
 * What to call a hole in the sentence, so an error names the reader's own word.
 *
 * A typed blank and a dropdown are the same construct — a named hole positioned by a marker —
 * and the cross-checks over them are identical. What differs is vocabulary: one is filled in,
 * the other is chosen from. Passing the nouns in keeps one implementation of the checks
 * without an error message that talks about blanks to somebody writing dropdowns.
 */
export interface MarkerWords {
  /** The hole, singular: "blank", "dropdown". */
  one: string;
  /** The member list that declares them: "blanks", "dropdowns". */
  list: string;
  /** A marker to show in an error, e.g. "{{capital}}". */
  marker: string;
  /** A whole sentence to show in an error. */
  sentence: string;
  /** What one hole is one of: "input", "menu". */
  unit: string;
  /** Completes "so nothing can …": "be typed into it", "be chosen for it". */
  fill: string;
}

const TEXT_ENTRY_WORDS: MarkerWords = {
  one: "blank",
  list: "blanks",
  marker: "{{capital}}",
  sentence: "The capital of France is {{capital}}.",
  unit: "input",
  fill: "be typed into it",
};

/**
 * Cut the text at its markers, and check that markers and holes account for each other.
 *
 * Every mismatch is a compile error naming the fix. Named binding is what makes these checks
 * possible at all — a positional model cannot say which answer is orphaned, and L0176 does not
 * even check that the marker count matches the answer count.
 */
export function cutMarkers<T, S>(
  text: string,
  declared: Map<string, T>,
  words: MarkerWords,
  where: string,
  segmentFor: (id: string, entry: T) => S,
): (TextSegment | S)[] {
  const segments: (TextSegment | S)[] = [];
  const seen = new Map<string, number>();
  let last = 0;
  let n = 0;
  MARKER.lastIndex = 0;
  for (let m = MARKER.exec(text); m !== null; m = MARKER.exec(text)) {
    n += 1;
    const id = m[1].trim();
    if (!id) {
      throw new Error(
        `${where}: a marker at position ${m.index} names no ${words.one}. Write {{<id>}}, ` +
          `e.g. ${words.marker}, matching an id in \`${words.list}\`.`,
      );
    }
    if (!declared.has(id)) {
      throw new Error(
        `${where}: the text has {{${id}}} but no ${words.one} declares that id. ` +
          `\`${words.list}\` declares: ${[...declared.keys()].join(", ") || "nothing"}.`,
      );
    }
    if (seen.has(id)) {
      throw new Error(
        `${where}: {{${id}}} appears twice. One ${words.one} is one ${words.unit} — give the ` +
          `second its own id and its own entry in \`${words.list}\`.`,
      );
    }
    seen.set(id, n);
    if (m.index > last) segments.push({ text: text.slice(last, m.index) });
    segments.push(segmentFor(id, declared.get(id)!));
    last = m.index + m[0].length;
  }

  if (!seen.size) {
    // L0176 guards this one too, and it is worth having: the item renders as a plain sentence
    // with nothing to fill in, and nothing downstream complains.
    throw new Error(
      `${where}: \`text\` has no {{…}} marker, so the item renders with nothing to fill in. ` +
        `Put {{<id>}} where the answer goes, e.g. "${words.sentence}"`,
    );
  }
  if (last < text.length) segments.push({ text: text.slice(last) });

  const orphan = [...declared.keys()].find((id) => !seen.has(id));
  if (orphan !== undefined) {
    throw new Error(
      `${where}: ${words.one} "${orphan}" has no {{${orphan}}} in the text, so nothing can ` +
        `${words.fill}. Add the marker, or remove the ${words.one}.`,
    );
  }

  return segments;
}
