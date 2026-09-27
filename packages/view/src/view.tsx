// SPDX-License-Identifier: MIT
//
// View is the SHARED, inherited front-end harness. It manages form state, drives
// compile/getData, reads its inputs from the URL search params, and posts state to the host
// via window.parent.postMessage — so it works both embedded in an iframe and standalone. It
// is parameterized by the language-specific `Form`: child languages import this `View` and
// inject their own `Form` (the only language-specific UX). L0000 ships the base `Form` (JSON),
// so its own embed mounts `<View Form={Form} />`.
//
// Compile/getData responses use the envelope `{ data, errors }`: successful output in `data`,
// compile errors in `errors`. The View stores `data` as the form's data model (so recompiles
// operate on real data, not the envelope) and threads `errors` to the Form alongside it.
//
// ── State ──────────────────────────────────────────────────────────────────────────────────
//
// The data model lives in React state and every `apply` re-renders. It used to live in an
// EXTERNAL mutable store (`createState`) that React did not track, which meant a form seeded
// from the `?data=` search param never appeared at all: the seed mutated the store from an
// effect, nothing re-rendered, and the harness kept showing the empty `<div/>` it had already
// committed. Keep state here, and keep the reducer PURE — it is re-run under StrictMode.
//
// ── The action protocol ────────────────────────────────────────────────────────────────────
//
// `init`      replace the model (a fresh load)
// `compiled`  MERGE the compile result over the model. It must not replace: a compile response
//             carries only what the compiler produced, so replacing discards client-side state
//             (focus, in-progress entries) and re-initializes the whole form on every edit.
// `update`    a user edit; merges, and requests a recompile
// `response`  a learner's answer; merges, and requests a recompile
// `focus`     selection tracking; merges under `focus` and does NOT recompile
//
// `loaded`   the stored model arriving from getData. Merges exactly like `compiled`; it is a
//            separate type only so the harness can tell an EXTERNAL load from the echo of an
//            edit the Form itself just reported (see `formModel` below).
//
// `response` and `focus` were previously unhandled, so they fell to the `default:` branch and
// returned the model UNCHANGED — silently discarding every answer a learner typed into an
// L0166/L0179 spreadsheet and every response an L0175 item collected.
//
// ── formModel: which model the Form is rendered from ───────────────────────────────────────
//
// A CONTROLLED Form (the default, `formModel: "live"`) renders whatever the model currently
// says, so it must see every change — including its own edits coming back.
//
// An UNCONTROLLED Form owns its own editing state and only SEEDS from the model. L0166's
// spreadsheet Form — which L0179 injects — is one: its TableEditor builds a ProseMirror
// document from `interaction.cells` and, whenever that object's IDENTITY changes, rebuilds the
// whole document and puts the caret back in A1. Feeding such a Form its own reported edits
// re-seeds it on every keystroke commit: the grid visibly redraws and the selection jumps.
//
// L0166 never hits this because its state lives in an untracked closure that re-renders
// nothing — the editor is seeded once and left alone. `formModel: "loaded"` makes that
// deliberate rather than accidental: the Form renders from the model as last loaded from
// OUTSIDE it (`init`, `loaded`), while `update`/`response` and the compile results they
// trigger keep updating the live model for postMessage, recompiles, and reporting.
//
// A language whose Form needs different semantics for one of these passes `reduce`. It is
// consulted FIRST and returns `undefined` for anything it does not claim, so a language adds
// cases without restating the generic ones. This exists because L0179 injects L0166's
// spreadsheet Form, whose `update` must merge cell text into `data.interaction.cells` rather
// than onto the top level — a shape that has no business being hardcoded here.
//
// ── score: checking is the host's, not the Form's ──────────────────────────────────────────
//
// An assessment language passes `score`, and the View shows a Check button under the Form.
// Check is a toggle: pressing it shows the score and hands the Form `showValidationUI: true`,
// pressing it again hides both, and so does the learner's next change to the model (an
// `update` or `response` that changes nothing does not count) — feedback returns to whatever
// the program's instant-feedback says. Check stays disabled until `score` reports the
// response `complete`. That flag is the one Learnosity sets through cqt, so a Form draws
// feedback from it and nothing else, and never needs to know which host it is in. It is laid
// over what the Form sees only: it is not in the model, so it is never posted or compiled.
// Whether feedback also shows WITHOUT a check (instant feedback) is the program's to say, and
// the Form reads that from the model itself.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ComponentType, CSSProperties } from "react";
import useSWR from "swr";
import { compile, getData } from "./swr/fetchers";
import "./index.css";

export interface CompileError {
  message: string;
  from?: number;
  to?: number;
}

export interface StateAction {
  type: string;
  args?: any;
}

/**
 * A language's extra reducer cases. Return the next data model to claim an action, or
 * `undefined` to fall through to the generic handling below.
 */
export type LanguageReducer = (data: any, action: StateAction) => any | undefined;

export interface FormProps {
  state: {
    data: any;
    errors: CompileError[];
    apply: (action: StateAction) => void;
  };
}

export type FormComponent = ComponentType<FormProps>;

/**
 * Which model the Form renders from.
 *
 * `live`   — everything, including the Form's own edits coming back (a controlled Form).
 * `loaded` — only the model as last loaded from outside the Form (an uncontrolled Form that
 *            seeds itself from the model and owns its editing state thereafter).
 */
export type FormModel = "live" | "loaded";

/** A learner's score, as the Check button reports it. */
export interface Score {
  score: number;
  max: number;
  /**
   * Whether the learner has answered everything. `false` keeps Check disabled until they have;
   * absent counts as complete, so a language that does not say never blocks the button.
   */
  complete?: boolean;
}

/**
 * Score the live model, or return `undefined` when it has nothing to check (no answer key, no
 * blanks). Called on every change, so keep it cheap and never throw.
 */
export type LanguageScore = (data: any) => Score | undefined;

/** Actions that represent a user changing the form, and so warrant a recompile. */
const RECOMPILE_ON = new Set(["update", "response"]);

/**
 * Actions that carry a model from OUTSIDE the Form, and so may re-seed an uncontrolled one.
 * `compiled` is absent deliberately: after the initial load every compile is a response to an
 * edit the Form itself reported, and re-seeding from it is the flash this exists to stop.
 */
const EXTERNAL_LOAD = new Set(["init", "loaded"]);

// Normalize a response into the { data, errors } envelope. Accepts a bare value (treated
// as data with no errors) for backward/forward compatibility.
function asEnvelope(payload: any): { data: any; errors: CompileError[] } {
  if (payload && typeof payload === "object" && Array.isArray(payload.errors)) {
    return { data: payload.data ?? null, errors: payload.errors };
  }
  return { data: payload, errors: [] };
}

function hasRenderable(data: any, errors: CompileError[]): boolean {
  if (errors.length > 0) return true;
  if (data === undefined || data === null) return false;
  if (typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 0) {
    return false;
  }
  return true;
}

const isPlainObject = (v: any): boolean =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// Merge only when both sides are records. A program can compile to an ATOMIC value (`10`, a
// string, an array); spreading one into an object yields `{}` (or index keys), which the
// reducer then saw as "no change" — leaving the model empty and the View blank. A scalar or
// array result REPLACES the model instead. A null result (e.g. a compile that produced only
// errors) leaves the model alone, as the spread always did.
const merge = (data: any, args: any): any => {
  if (args === null || args === undefined) return data;
  return isPlainObject(data) && isPlainObject(args) ? { ...data, ...args } : args;
};

function baseReduce(data: any, { type, args }: StateAction): any {
  switch (type) {
    case "init":
      return isPlainObject(args) ? { ...args } : args;
    case "compiled":
    case "loaded":
    case "update":
    case "response":
      return merge(data, args);
    case "focus":
      return { ...data, focus: args };
    default:
      console.error(`Unimplemented action type: ${type}`);
      return data;
  }
}

/**
 * Structural equality, used to decide whether an action actually changed the model.
 *
 * This replaces `JSON.stringify(a) === JSON.stringify(b)`, which serialized the ENTIRE model
 * twice on every dispatched action. For a spreadsheet of a few hundred cells that is real work
 * on a path that runs on every keystroke, focus change and response — and it is work done to
 * answer a question that usually resolves on the first differing key.
 *
 * Unlike the stringify comparison this is insensitive to key ORDER, which is the intended
 * meaning: a model whose keys were rebuilt in a different order has not changed.
 */
const deepEqual = (a: any, b: any): boolean => {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
};

interface ViewState {
  data: any;
  /**
   * What the Form is rendered from. Under `formModel: "live"` it is always `data`; under
   * `"loaded"` its IDENTITY only changes on an external load, which is what keeps an
   * uncontrolled Form from re-seeding itself on its own edits.
   */
  renderData: any;
  /** Bumped by each user edit. The compile effect keys off it, never off `data` itself. */
  compileSeq: number;
  /**
   * Bumped whenever `data` changes. Effects that need to run on a real change key off this
   * instead of off a serialization of the whole model.
   */
  version: number;
}

const makeReducer =
  (reduce: LanguageReducer | undefined, formModel: FormModel) =>
  (prev: ViewState, action: StateAction): ViewState => {
    const claimed = reduce ? reduce(prev.data, action) : undefined;
    const data = claimed !== undefined ? claimed : baseReduce(prev.data, action);
    if (data === prev.data || deepEqual(data, prev.data)) {
      return prev;
    }
    return {
      data,
      renderData:
        formModel === "live" || EXTERNAL_LOAD.has(action.type) ? data : prev.renderData,
      compileSeq: prev.compileSeq + (RECOMPILE_ON.has(action.type) ? 1 : 0),
      version: prev.version + 1,
    };
  };

export const View = ({
  Form,
  reduce,
  formModel = "live",
  score,
  id: idProp,
  accessToken: accessTokenProp,
}: {
  Form: FormComponent;
  reduce?: LanguageReducer;
  formModel?: FormModel;
  score?: LanguageScore;
  /**
   * The item to load. A host that mounts the View as a React component passes it here; the
   * embeddable /form bundle leaves it out and the View reads `?id=` from the page URL instead.
   */
  id?: string;
  /** Credential for a private item. Falls back to `?access_token=`, like `id`. */
  accessToken?: string;
}) => {
  const [params] = useState(() => new URLSearchParams(window.location.search));
  const id = idProp ?? params.get("id") ?? undefined;
  const accessToken = accessTokenProp ?? params.get("access_token") ?? undefined;
  const [targetOrigin] = useState<string | undefined>(params.get("origin") ?? undefined);
  const [errors, setErrors] = useState<CompileError[]>([]);

  const reducer = useMemo(() => makeReducer(reduce, formModel), [reduce, formModel]);
  const [state, apply] = useReducer(reducer, undefined, () => ({
    data: {},
    renderData: {},
    compileSeq: 0,
    version: 0,
  }));
  const { data, renderData, compileSeq, version } = state;

  // Initialize from a `data` search param on first load.
  useEffect(() => {
    const seed = params.get("data");
    if (seed) apply({ type: "init", args: JSON.parse(seed) });
  }, []);

  // Announce load to the host.
  useEffect(() => {
    if (targetOrigin) {
      window.parent.postMessage({ type: "onload", data }, targetOrigin);
    }
  }, []);

  // Post state to the host whenever it changes.
  //
  // Keyed on the reducer's own version counter. It used to be keyed on `JSON.stringify(data)`,
  // which serialized the whole model on EVERY render rather than only when something changed —
  // and the reducer already knows the answer, because it returns `prev` untouched when an action
  // changes nothing.
  useEffect(() => {
    if (targetOrigin) {
      window.parent.postMessage({ type: "data-updated", data }, targetOrigin);
    }
  }, [version]);

  // Fetch stored data when an id is present.
  //
  // Revalidation is off: this is a one-shot load, and a background refetch on window focus
  // would re-apply the STORED model over whatever the learner has since entered — the form
  // silently reverting when you tab away and back.
  const getDataResp = useSWR(id ? { accessToken, id } : null, getData, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
  });

  // Apply the loaded data in an EFFECT. Applying it during render (as this used to) both
  // mutated state mid-render and re-ran on every subsequent render, because the SWR result
  // stays populated — the old code only escaped that loop by flipping its own fetch key to
  // null, which is what let a warm cache entry re-apply a stale model later.
  useEffect(() => {
    if (getDataResp.data === undefined) return;
    const env = asEnvelope(getDataResp.data);
    apply({ type: "loaded", args: env.data });
    setErrors(env.errors);
  }, [getDataResp.data]);

  // Recompile after a user edit.
  //
  // Deliberately NOT SWR: a compile is a mutation, not a cacheable query. Keying it on the
  // data (as this used to) meant returning a cell to a value it already held replayed an
  // OLDER compiled snapshot straight out of the cache, reverting the sheet. A bare request
  // with last-write-wins ordering has no cache to go stale.
  const latestCompile = useRef(0);
  useEffect(() => {
    if (compileSeq === 0 || !id) return;
    const seq = ++latestCompile.current;
    if (targetOrigin) {
      window.parent.postMessage({ focus: { type: "update", value: data } }, targetOrigin);
    }
    let cancelled = false;
    (async () => {
      try {
        const out = await compile({ accessToken, id, data });
        // Drop a response that a newer edit has already superseded, so a slow compile can
        // never overwrite a faster one that started later.
        if (cancelled || seq !== latestCompile.current) return;
        const env = asEnvelope(out);
        apply({ type: "compiled", args: env.data });
        setErrors(env.errors);
      } catch (err: any) {
        if (!cancelled && seq === latestCompile.current) {
          setErrors([{ message: String(err?.message ?? err) }]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compileSeq]);

  // The Form sees `renderData`; everything else here (postMessage, recompiles) uses the live
  // `data`. They are the same object unless the language asked for `formModel: "loaded"`, and
  // the fallback covers the one case where they can disagree about EXISTENCE rather than
  // content: a model that arrived without ever passing through an external load.
  const formData = hasRenderable(renderData, []) ? renderData : data;

  // Checking. A change the learner makes hides the result again; a compile does not, since it
  // only echoes a change that already did. Keyed on `compileSeq`, which moves only when an
  // `update`/`response` actually changed the model: L0179 reports both on every caret move, and
  // clearing on the action alone wiped the check the moment the learner clicked a cell.
  const [checked, setChecked] = useState(false);
  useEffect(() => setChecked(false), [compileSeq]);
  // Scored from the live model, which under `formModel: "loaded"` is not what the Form renders.
  const result = useMemo(
    () => (score && errors.length === 0 ? score(data) : undefined),
    [score, data, errors],
  );
  const shown =
    checked && result && isPlainObject(formData) ? { ...formData, showValidationUI: true } : formData;
  const formState = useMemo(() => ({ data: shown, errors, apply }), [shown, errors]);

  // Render priority: real content first; otherwise surface why there's none.
  // A getData failure (e.g. a stale/expired token 401ing a public read) used to
  // fall through to a blank `<div/>` with no console output — indistinguishable
  // from "still loading" and impossible to diagnose. Show the error (and a
  // retry) instead. Once data has loaded, a later revalidation error is ignored
  // so the form isn't replaced by an error screen.
  const retry = useCallback(() => getDataResp.mutate(), [getDataResp]);

  if (hasRenderable(data, errors)) {
    if (!result) return <Form state={formState} />;
    return (
      <>
        <Form state={formState} />
        <CheckBar result={result} checked={checked} onToggle={() => setChecked((c) => !c)} />
      </>
    );
  }
  if (getDataResp.error) {
    return (
      <div role="alert" style={MESSAGE_STYLE}>
        <p style={{ margin: 0, fontWeight: 600 }}>Couldn’t load this form.</p>
        <p style={{ margin: "4px 0 12px", color: "#555" }}>
          {String((getDataResp.error as { message?: string })?.message ?? getDataResp.error)}
        </p>
        <button type="button" style={RETRY_STYLE} onClick={retry}>
          Retry
        </button>
      </div>
    );
  }
  if (getDataResp.isLoading) {
    return (
      <div role="status" aria-live="polite" style={MESSAGE_STYLE}>
        Loading…
      </div>
    );
  }
  return <div />;
};

/**
 * The host's Check button and the score it reveals. Exported for hosts that mount a Form without
 * the View (the MCP widget), so every one of our hosts checks the same way.
 *
 * Drawn as player chrome — its own bordered strip, set apart from the question — because it is
 * the host's control, not part of the interaction. It is a toggle (`aria-pressed`), disabled
 * until the response is complete; a check already showing can always be hidden.
 */
export const CheckBar = ({
  result,
  checked,
  onToggle,
}: {
  result: Score;
  checked: boolean;
  onToggle: () => void;
}) => {
  const waiting = !checked && result.complete === false;
  return (
    <div role="group" aria-label="Check your answers" style={CHECK_BAR_STYLE}>
      <button
        type="button"
        aria-pressed={checked}
        style={{ ...CHECK_BUTTON_STYLE, ...(checked ? CHECK_BUTTON_ON : {}), ...(waiting ? CHECK_BUTTON_OFF : {}) }}
        onClick={onToggle}
        disabled={waiting}
      >
        Check
      </button>
      <span aria-live="polite" style={{ color: "#52525b", minWidth: "10em" }}>
        {checked
          ? `${result.score} of ${result.max} points`
          : waiting
            ? "Answer everything to check."
            : ""}
      </span>
    </div>
  );
};

const CHECK_BAR_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "12px",
  margin: "12px auto 0",
  maxWidth: "64rem",
  padding: "10px 16px",
  border: "1px solid #d4d4d8",
  borderRadius: "8px",
  background: "#f4f4f5",
  font: "14px/1.4 system-ui, sans-serif",
  boxSizing: "border-box",
};

const CHECK_BUTTON_STYLE: CSSProperties = {
  padding: "8px 16px",
  border: "1px solid #18181b",
  borderRadius: "6px",
  background: "#18181b",
  color: "#fff",
  fontWeight: 500,
  cursor: "pointer",
};

/** Pressed: the check is showing, and pressing again hides it. */
const CHECK_BUTTON_ON: CSSProperties = {
  background: "#fff",
  color: "#18181b",
};

const CHECK_BUTTON_OFF: CSSProperties = {
  opacity: 0.45,
  cursor: "default",
};

const MESSAGE_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  padding: "24px",
  textAlign: "center",
  font: "14px/1.4 system-ui, sans-serif",
};

const RETRY_STYLE: CSSProperties = {
  padding: "6px 14px",
  border: "1px solid #888",
  borderRadius: "4px",
  background: "#fff",
  cursor: "pointer",
};
