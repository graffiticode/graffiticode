// SPDX-License-Identifier: MIT
/* Copyright (c) 2023, ARTCOMPILER INC */
// L0176 inherits L0000: its Checker/Transformer extend L0000's, adding handlers
// for the L0176 Learnosity vocabulary. Ported from L0158 (@graffiticode/basis) —
// the record encoding, CPS visitor contract, and SET_VAR→options mechanism are
// identical between basis and L0000, so the port is mechanical. The compiler
// holds no Learnosity credential: every signature comes from the broker.
import {
  Checker as BaseChecker,
  Transformer as BaseTransformer,
  Compiler,
} from "@graffiticode/l0000";

import { buildCreateItems } from "./items.js";
import { lowerLegacySave } from "./save-lowering.js";
import {
  PROTECTED_FUNCTIONS,
  IMPLICIT_PROTECTED_FUNCTIONS,
  isBrokered,
  brokeredSign,
  brokeredSave,
  systemPreviewSign,
  protectedError,
} from "./protection.js";
import type { SystemPreviewClient } from "./protection.js";
import type { PolicyClient } from "@graffiticode/l0000";
import { buildCreateQuestions } from "./questions.js";
import { buildCreateAuthor } from "./author.js";
import {
  questionTypeBuilders,
  memberFields,
  mergeMembers,
  inferShape,
  partitionItemsList,
  assertItemMembers,
  assertItemsEntries,
  isMemberList,
} from "./question-types.js";

// Unwrap L0000's internal Record representation ({_type:"record", _entries:Map})
// to plain JS, stripping the tag:/str:/num: key prefixes. Identical shape to
// basis's records, so this ports verbatim from L0158.
function toPlainObject(val: any): any {
  if (val !== null && typeof val === "object" && val._type === "record" && val._entries instanceof Map) {
    const obj: any = {};
    for (const [k, v] of val._entries) {
      const name = (k as string).replace(/^(tag|str|num):/, "");
      obj[name] = toPlainObject(v);
    }
    return obj;
  }
  if (Array.isArray(val)) {
    return val.map(toPlainObject);
  }
  return val;
}

const createItems = buildCreateItems();
const createQuestions = buildCreateQuestions();

// The system preview client (policy's POST /v1/preview-session plus the
// mint-then-broker invoker), set by the api with setPolicyClient. Module
// state because the Compiler is a singleton and the per-compile Transformer
// cannot reach it; it holds no credential and no per-invocation state.
let systemPreviewClient: SystemPreviewClient | null = null;

// Save plans belong to ONE invocation. The Compiler (a singleton reused across
// requests) creates a fresh Transformer per compile; each Transformer gets its
// own map from the activities it built to their save plans.
// `save-to-itembank <activity>` is the ONLY consumer and looks its argument up
// in its own Transformer's map, so it can save only an activity built by this
// same compile — an activity object retained from another invocation is not
// found. Building one never writes.
const savePlansByInvocation = new WeakMap<object, WeakMap<object, any>>();

function savePlansFor(transformer: object): WeakMap<object, any> {
  let plans = savePlansByInvocation.get(transformer);
  if (!plans) {
    plans = new WeakMap();
    savePlansByInvocation.set(transformer, plans);
  }
  return plans;
}

// Stable per-node key for occurrence ids: the same node in a retried compile of
// the same program gets the same key. Policy accepts ids of [A-Za-z0-9_:.-]
// only, so the separator is ":" (brokered.test.ts checks the full id).
const occurrenceKey = (node: any) => `${node?.tag}:${node?.coord?.from ?? "-"}`;

const LEGACY_SAVE_MEMBER_ERROR =
  "Error: save-to-itembank wraps the activity to save: `save-to-itembank items [...] {}`. " +
  "As an items-list member it is only accepted as the literal `save-to-itembank true`.";
const createAuthor = buildCreateAuthor();

// Learnosity credentials never come from a program or from `config`. A legacy
// program's `set-var "learnosity-key"/"learnosity-secret"` still compiles —
// L0000's SET_VAR writes them into `options` — but nothing reads them: they
// sign nothing. Signing is the broker's, through the selected connection or,
// without one, the system preview session.

// Sign the compiled Learnosity activity so the view can hand `request` straight
// to LearnosityApp.init. The compile produces the unsigned `{ type, data }`
// activity (createItems/createQuestions/createAuthor); the browser SDK needs a
// *signed* request. L0158 did this signing in a second, client-triggered
// `init data {}` compile pass (its own View issued it after the cached
// compile); L0176 renders through the shared @graffiticode/l0000-view, which
// issues a single POST /compile and hands the result to the Form verbatim, so
// we fold the signing into the compile output here.
//
// Signing runs after the full transform, so it never duplicates a
// save-to-itembank write. Each signing stamps a fresh
// user_id / signature, so the compile output's `request` changes on every
// (re)compile even when the assessment is unchanged — that churn is why the
// Form keys its one-time Learnosity init on the stable question content rather
// than object identity (see packages/view/src/components/form/contentKey.ts).
async function signForRender(plain: any, exec?: any): Promise<any> {
  // Only sign Learnosity render output: a `{ type, data }` activity that has
  // not already been signed. Leaves bare/non-Learnosity values untouched.
  if (!plain || typeof plain !== "object" || !plain.type || plain.request) {
    return plain;
  }
  // Brokered: the connection's credential signs, inside the broker.
  if (isBrokered(exec)) {
    const request = await brokeredSign(exec, plain, "prog");
    return request ? { ...plain, request } : plain;
  }
  // Without a connection there is no authority to open the Author Site, which
  // can edit and delete items: leave it unsigned.
  if (plain.type !== "questions" && plain.type !== "items") {
    return plain;
  }
  // Without a connection, a preview is signed by the broker under a system
  // preview session. If none is available the activity goes out unsigned
  // with `signing: { unsigned, message }` — not a compile error.
  return systemPreviewSign(exec, systemPreviewClient, plain, "prog");
}

export class Checker extends BaseChecker {
  [key: string]: any;

  HELLO(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, _v0: any) => {
      const err = ([] as any[]).concat(e0 || []);
      const val = node;
      resume(err, val);
    });
  }


  ITEMS(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, _v0: any) => {
      this.visit(node.elts[1], options, async (e1: any, _v1: any) => {
        const err = ([] as any[]).concat(e0 || [], e1 || []);
        const val = node;
        resume(err, val);
      });
    });
  }

  ITEM(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, _v0: any) => {
      const err = ([] as any[]).concat(e0 || []);
      const val = node;
      resume(err, val);
    });
  }

  QUESTIONS(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, _v0: any) => {
      this.visit(node.elts[1], options, async (e1: any, _v1: any) => {
        const err = ([] as any[]).concat(e0 || [], e1 || []);
        const val = node;
        resume(err, val);
      });
    });
  }



  AUTHOR(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, _v0: any) => {
      const err = ([] as any[]).concat(e0 || []);
      const val = node;
      resume(err, val);
    });
  }

}

// Generate Checker methods for question types (arity 1)
for (const name of Object.keys(questionTypeBuilders)) {
  Checker.prototype[name] = function (node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, _v0: any) => {
      const err = ([] as any[]).concat(e0 || []);
      const val = node;
      resume(err, val);
    });
  };
}

// Generate Checker methods for attribute members (arity 1). Shape validation
// happens in the Transformer, where the values are known; the Checker walks the
// child expression.
for (const name of Object.keys(memberFields)) {
  Checker.prototype[name] = function (node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, _v0: any) => {
      resume(([] as any[]).concat(e0 || []), node);
    });
  };
}


export class Transformer extends BaseTransformer {
  [key: string]: any;

  HELLO(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      const err: any[] = [];
      const val = v0;
      resume(err, val);
    });
  }

  INIT(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      const plain = toPlainObject(v0);
      const err: any[] = [];
      if (isBrokered(this.execContext)) {
        try {
          resume(err, await brokeredSign(this.execContext, plain, occurrenceKey(node)));
        } catch (e: any) {
          resume([protectedError(e, this.execContext)], undefined);
        }
        return;
      }
      const { type } = plain ?? {};
      if (type === "questions" || type === "items") {
        // No connection: sign through the system preview session. `init`
        // evaluates to the signed request; unsigned, to the activity with
        // `signing: { unsigned, message }`.
        const signed = await systemPreviewSign(this.execContext, systemPreviewClient, plain, occurrenceKey(node));
        resume(err, signed.request ?? signed);
        return;
      }
      // Without a connection there is no authority to open the Author Site
      // (see signForRender): return it unsigned.
      resume(err, type === "author" ? plain : undefined);
    });
  }


  // The list holds two kinds of thing: items-level members (`params`,
  // `save-to-itembank`), which are single-key records whose key is one of
  // those fields, and `item` entries, which are everything else. The readings
  // do not overlap — `item [metadata [...]]` merges to `{metadata: ...}`, and
  // `metadata` is not an items-level member. The continuation carries
  // program-level metadata and is spread onto the compiled envelope.
  ITEMS(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      this.visit(node.elts[1], options, async (e1: any, v1: any) => {
        const plain = toPlainObject(v0);
        const err = ([] as any[]).concat(e0 || [], e1 || []);
        let entries;
        if (Array.isArray(plain)) {
          entries = plain;
        } else if (plain && typeof plain === "object" && plain.list != null) {
          entries = Array.isArray(plain.list) ? plain.list : [plain.list];
        } else {
          entries = [plain];
        }
        const { members, items } = partitionItemsList(entries);
        if (!options["lrn-id"]) {
          resume([...err, `Error: set-var "lrn-id" must be set to a non-empty string before items is called.`], undefined);
          return;
        }
        if (items.length === 0) {
          resume([...err, "items: no `item` entries — an items list needs at least one item."], undefined);
          return;
        }
        // If any child errored (e.g. a builder threw validation), bail before
        // createItems — the items/questions arrays contain `undefined` for the
        // failed entry and would crash the wrapper.
        if (err.length > 0) {
          resume(err, undefined);
          return;
        }
        try {
          assertItemsEntries(items);
        } catch (e: any) {
          resume([...err, String((e && e.message) || e)], undefined);
          return;
        }
        // A save flag that survived lowering was not the literal member form
        // (e.g. assembled by another expression). Refuse it rather than
        // guess: only `save-to-itembank <activity>` writes.
        if (members.save_to_itembank !== undefined) {
          resume([...err, LEGACY_SAVE_MEMBER_ERROR], undefined);
          return;
        }
        let built;
        try {
          built = await createItems({ items, params: members.params, id: options["lrn-id"] });
        } catch (e: any) {
          resume([...err, `Error: ${String((e && e.message) || e)}`], undefined);
          return;
        }
        const continuation = toPlainObject(v1);
        const val = { ...continuation, ...built.activity };
        savePlansFor(this).set(val, built.savePlan);
        resume(err, val);
      });
    });
  }

  // `item` takes a member list, like a question type: `metadata` is a member at
  // both levels and a word has one arity. `questions [...] {}` is still an
  // arity-2 block and merges in as one entry of that list.
  ITEM(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      const err = ([] as any[]).concat(e0 || []);
      try {
        const merged = mergeMembers(toPlainObject(v0), "item");
        assertItemMembers(merged);
        resume(err, merged);
      } catch (e: any) {
        resume(err.concat(String((e && e.message) || e)), {});
      }
    });
  }

  // The list is partitioned the same way `items` partitions its own: a
  // single-key record whose key is an items-level member is a member, and
  // everything else is a question. That is what lets the standalone questions
  // path carry `save-to-itembank` now that it is an arity-1 member rather than
  // an attribute chaining onto the continuation.
  QUESTIONS(node: any, options: any, resume: any) {
    this.visit(node.elts[1], options, async (e1: any, v1: any) => {
      this.visit(node.elts[0], options, async (e0: any, v0: any) => {
        const plain = toPlainObject(v0);
        const err = ([] as any[]).concat(e0 || [], e1 || []);
        // Normalize to array: L0000 LIST node produces an array; guard {list:x} too
        let entries;
        if (Array.isArray(plain)) {
          entries = plain;
        } else if (plain && typeof plain === "object" && plain.list != null) {
          entries = Array.isArray(plain.list) ? plain.list : [plain.list];
        } else {
          entries = [plain];
        }
        const { members, items: questions } = partitionItemsList(entries);
        if (!options["lrn-id"]) {
          resume(err, {});
          return;
        }
        // If any child errored (e.g. a question builder threw validation),
        // bail before createQuestions — the questions array contains
        // `undefined` for the failed entry and would crash the wrapper.
        if (err.length > 0) {
          resume(err, {});
          return;
        }
        if (members.save_to_itembank !== undefined) {
          resume([...err, LEGACY_SAVE_MEMBER_ERROR], {});
          return;
        }
        let built;
        try {
          built = await createQuestions(questions, { id: options["lrn-id"] });
        } catch (e: any) {
          resume([...err, `Error: ${String((e && e.message) || e)}`], {});
          return;
        }
        const continuation = toPlainObject(v1);
        const val = { ...continuation, ...built.activity };
        savePlansFor(this).set(val, built.savePlan);
        resume(err, val);
      });
    });
  }



  // The item-bank write. Its argument must be an activity `items` or
  // `questions` built in this compile; the save plan comes from that build,
  // never from program data, and nothing else in the language writes.
  SAVE_TO_ITEMBANK(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      const err = ([] as any[]).concat(e0 || []);
      if (err.length > 0) {
        resume(err, undefined);
        return;
      }
      const plan = v0 && typeof v0 === "object" ? savePlansFor(this).get(v0) : undefined;
      if (!plan) {
        resume([typeof v0 === "boolean" ? LEGACY_SAVE_MEMBER_ERROR
          : "Error: save-to-itembank must wrap an activity built by `items [...] {}` or `questions [...] {}`."], undefined);
        return;
      }
      // Brokered: the write happens in the broker, under the connection's
      // credential, whenever the program runs and policy grants it.
      if (isBrokered(this.execContext)) {
        try {
          const itemBank = await brokeredSave(this.execContext, plan, occurrenceKey(node));
          resume(err, { ...v0, data: { ...v0.data, itemBank } });
        } catch (e: any) {
          resume([protectedError(e, this.execContext)], undefined);
        }
        return;
      }
      // No connection: no authority to write. The save is validated but not
      // executed, and reported beside the activity rather than as an error, so
      // a valid program still compiles and its preview still renders.
      // Generation, verification, the corpus ping and eval all land here.
      resume(err, {
        ...v0,
        data: {
          ...v0.data,
          itemBank: { skipped: "no-connection", fn: "save-to-itembank", occurrence: occurrenceKey(node) },
        },
      });
    });
  }

  AUTHOR(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      const plain = toPlainObject(v0);
      const err: any[] = [];
      if (!options["lrn-id"]) {
        resume([`Error: set-var "lrn-id" must be set to a non-empty string before author is called.`], undefined);
        return;
      }
      const val = await createAuthor({ ...plain, id: options["lrn-id"] });
      resume(err, val);
    });
  }

  PROG(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      const err = e0;
      const val = v0.pop();
      // Don't sign a failed compile — `val` is undefined/partial on error.
      if (err && err.length > 0) {
        resume(err, val);
        return;
      }
      // Attach the signed Learnosity `request` (see signForRender).
      try {
        resume(err, await signForRender(val, this.execContext));
      } catch (e: any) {
        resume([protectedError(e, this.execContext)], undefined);
      }
    });
  }
}

// Generate Transformer methods for question types (arity 1). Wrap the
// builder call so validating builders (e.g. bowtie) can throw with a
// human-readable message and have it surface via the standard error list
// instead of becoming an unhandled rejection.
for (const [name, builder] of Object.entries(questionTypeBuilders)) {
  Transformer.prototype[name] = function (node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      // Propagate descendant errors (e.g. DATA's schema-validation failures)
      // instead of silently dropping them and emitting a null value for the
      // affected attribute.
      if (e0 && e0.length > 0) {
        resume(e0, null);
        return;
      }
      try {
        const attrs = mergeMembers(toPlainObject(v0), name.toLowerCase().replace(/_/g, "-"));
        resume([], builder(attrs));
      } catch (e: any) {
        resume([String((e && e.message) || e)], undefined);
      }
    });
  };
}

// Generate Transformer methods for attribute members (arity 1). Each returns a
// single-key record; whatever encloses it — a question type, or an object-shaped
// member — merges the list. `shape` says how deep to read the argument.
for (const [name, meta] of Object.entries(memberFields)) {
  Transformer.prototype[name] = function (node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      const err = ([] as any[]).concat(e0 || []);
      const raw = toPlainObject(v0);
      const where = meta.field.replace(/_/g, "-");
      try {
        let value = raw;
        // A value that is not shaped the way this member expects is passed
        // through rather than rejected here. The builder reports it instead,
        // because it knows the question type: `valid-response [0]` on an mcq is
        // an attribute in the wrong place, not a badly written member list, and
        // only the builder can tell those apart.
        if (meta.shape === "object") {
          if (Array.isArray(raw) && (raw.length === 0 || isMemberList(raw))) {
            value = mergeMembers(raw, where);
          }
        } else if (meta.shape === "objectArray") {
          if (Array.isArray(raw) && raw.every(isMemberList)) {
            value = raw.map((entry: any, i: number) => mergeMembers(entry, `${where}[${i + 1}]`));
          }
        } else if (meta.shape === "infer") {
          value = inferShape(raw, where);
        }
        resume(err, { [meta.field]: value });
      } catch (e: any) {
        resume(err.concat(String((e && e.message) || e)), {});
      }
    });
  };
}


// Lowers the legacy save member before anything else — checker, permission
// admission, transformer — sees the program (see save-lowering.ts), then picks
// the path: a compile that selects a connection is BROKERED (protected
// functions admitted by policy, executed by the broker); one that does not
// never writes and never signs an Author session, and signs previews through
// the system preview session when the policy client offers one. A selected
// connection on a server with no policy client configured fails closed rather
// than falling back.
class L0176Compiler extends Compiler {
  #brokered: Compiler | null = null;

  setPolicyClient(policy: PolicyClient & { getPreviewSession?: SystemPreviewClient["getPreviewSession"] }) {
    systemPreviewClient = typeof policy.getPreviewSession === "function" && typeof policy.invoke === "function"
      ? { getPreviewSession: policy.getPreviewSession.bind(policy), invoke: policy.invoke }
      : null;
    this.#brokered = new Compiler({
      langID: "0176",
      version: "v0.0.1",
      Checker,
      Transformer,
      protectedFunctions: PROTECTED_FUNCTIONS as any,
      implicitProtectedFunctions: IMPLICIT_PROTECTED_FUNCTIONS as any,
      policy,
    });
  }

  compile(code: any, data: any, config: any, resume: any, identity?: any) {
    let lowered;
    try {
      lowered = lowerLegacySave(code);
    } catch (e: any) {
      resume([{ message: `Error: ${String((e && e.message) || e)}`, from: -1, to: -1 }]);
      return;
    }
    if (identity?.connectionId) {
      if (!this.#brokered) {
        resume([{ message: "Error: connections are not available on this server.", from: -1, to: -1 }]);
        return;
      }
      return this.#brokered.compile(lowered, data, config, resume, identity);
    }
    return super.compile(lowered, data, config, resume, identity);
  }
}

export const compiler = new L0176Compiler({
  langID: "0176",
  version: "v0.0.1",
  Checker,
  Transformer,
});
