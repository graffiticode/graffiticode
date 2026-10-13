// SPDX-License-Identifier: MIT
/**
 * An L0175 composed item, read as the thing L0180 has to reproduce.
 *
 * L0175 emits a different payload per item type — `choice.options` for the one-part models,
 * `partA`/`partB` for EBSR, a flat `selectable` list for hot text, a `rubric` for short text —
 * and the delivered question is spread across them. This narrows all five to one shape: what
 * the candidate is asked, what they may pick, and which picks are right.
 *
 * Nothing here imports L0175. It reads the compiled JSON, so the harness runs against an item
 * that came off the wire as easily as one compiled from the sibling repo, and a change to
 * L0175's internals cannot break the comparison without changing its output first.
 */

/** What a candidate may pick in one part, and whether picking it is right. */
export interface SourceOption {
  text: string;
  correct: boolean;
}

/**
 * One thing the candidate answers.
 *
 * `exactSet` is the difference between "pick the right one" and "pick exactly these": under it
 * a subset and a superset both earn nothing. Derived from how many options are correct rather
 * than from L0175's `selectCount`, which disagrees with its own key — the hot-text example in
 * `c1-t1-tm3` says `selectCount: 1` over two correct sentences and a stem asking for two.
 */
export interface SourcePart {
  label: string;
  options: SourceOption[];
  exactSet: boolean;
}

export interface SourceItem {
  id: string;
  /** L0175's item type: multiple-choice, multi-select, ebsr, hot-text, short-text. */
  type: string;
  /** L0175's own SCORING line, carried so a report can quote the rule it is holding us to. */
  scoring: string;
  /** What a fully correct response earns. One for every scored type; the top band for a rubric. */
  points: number;
  /** True for short-text, whose points are pending until a person marks it — never zero. */
  handScored: boolean;
  parts: SourcePart[];
  stems: string[];
  /**
   * The passage, line by line.
   *
   * Every L0175 item is about one, and a delivered item that dropped it can still score every
   * response correctly while asking a question nobody can answer — Part B's options are the
   * passage's own sentences. Scoring fidelity and content fidelity are different claims, and
   * this is what lets the harness make the second one.
   */
  passage: string[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const optionsOf = (list: any): SourceOption[] =>
  (Array.isArray(list) ? list : []).map((o: any) => ({
    text: str(o?.text),
    correct: o?.correct === true,
  }));

/** A part is exact-set when more than one option is correct — several picks, all of them wanted. */
const part = (label: string, options: SourceOption[]): SourcePart => ({
  label,
  options,
  exactSet: options.filter((o) => o.correct).length > 1,
});

export function readSourceItem(compiled: any): SourceItem {
  const type = str(compiled?.type);
  const scoring = str(compiled?.review?.scoring);
  const stem = compiled?.stem ?? {};
  const stems = [stem.partA, stem.partB].filter((s: any) => typeof s === "string" && s);

  const passage: string[] = (compiled?.passage?.lines ?? []).map((l: any) => str(l?.text)).filter(Boolean);
  const base = { id: str(compiled?.id), type, scoring, stems, passage };

  switch (type) {
    case "multiple-choice":
    case "multi-select":
      return {
        ...base,
        points: 1,
        handScored: false,
        parts: [part("A", optionsOf(compiled?.choice?.options))],
      };

    case "ebsr":
      return {
        ...base,
        points: 1,
        handScored: false,
        parts: [
          part("A", optionsOf(compiled?.partA?.options)),
          part("B", optionsOf(compiled?.partB?.options)),
        ],
      };

    // Hot text is a two-part model on paper, but only Part B is answered: Part A is the
    // conclusion, stated in the stem. One delivered part, and the passage is the option list.
    case "hot-text":
      return {
        ...base,
        points: 1,
        handScored: false,
        parts: [part("B", optionsOf(compiled?.selectable))],
      };

    // Nothing is picked and nothing is auto-scored. The key is the rubric, and its top band is
    // what a full response earns — 2 in every L0175 profile, but read rather than assumed.
    case "short-text": {
      const bands = Array.isArray(compiled?.rubric) ? compiled.rubric : [];
      const top = bands.reduce((m: number, b: any) => Math.max(m, Number(b?.score) || 0), 0);
      return {
        ...base,
        points: top || 2,
        handScored: true,
        parts: [],
        stems: stems.length ? stems : [str(compiled?.prompt)].filter(Boolean),
      };
    }

    default:
      throw new Error(`unknown L0175 item type: ${type || "(none)"}`);
  }
}

/** The correct picks in one part, as text — the only identity that survives the language boundary. */
export const keyOf = (p: SourcePart): string[] =>
  p.options.filter((o) => o.correct).map((o) => o.text);
