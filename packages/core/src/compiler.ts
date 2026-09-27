// SPDX-License-Identifier: MIT
/* Copyright (c) 2023, ARTCOMPILER INC */
// L0176 inherits L0000: its Checker/Transformer extend L0000's, adding handlers
// for the L0176 Learnosity vocabulary. Ported from L0158 (@graffiticode/basis) —
// the record encoding, CPS visitor contract, and SET_VAR→options mechanism are
// identical between basis and L0000, so the port is mechanical (import swap +
// credential injection via config instead of module-scope env reads).
import {
  Checker as BaseChecker,
  Transformer as BaseTransformer,
  Compiler,
} from "@graffiticode/l0000";

import { buildDataApi } from "./dataapi.js";
import { buildCreateItems, buildInitItems } from "./items.js";
import { buildCreateQuestions, buildInitQuestions } from "./questions.js";
import { buildInitAuthor, buildCreateAuthor } from "./author.js";
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

import LearnositySDK from "learnosity-sdk-nodejs";
const sdk = new LearnositySDK();
// `domain` is non-secret wiring — baked at module scope from NODE_ENV. The
// Learnosity consumer key/secret are secrets and are injected per-compile via
// `config` (see resolveCredentials + packages/api/src/compile.ts).
const domain = process.env.NODE_ENV === "production" ? "l0176.graffiticode.org" : "localhost";
const baseUrl = "https://data.learnosity.com/v2025.2.LTS";
const dataApi = buildDataApi({ baseUrl });
const createItems = buildCreateItems({ sdk, domain, dataApi });
const initItems = buildInitItems({ sdk, domain });
const createQuestions = buildCreateQuestions({ sdk, domain, dataApi });
const initQuestions = buildInitQuestions({ sdk, domain });
const initAuthor = buildInitAuthor({ sdk, domain });
const createAuthor = buildCreateAuthor({ sdk, domain, dataApi });

// Sentinel `lrn-id` (= get-val-public "itemId") injected by the console during
// code-generation VERIFICATION. Must match VERIFY_ITEM_ID in the console
// (code-generation-service.ts). A compile whose lrn-id is this value is a dry
// run: the caller's Learnosity credentials aren't injected during verification,
// so we validate the program but skip item-bank writes and their credential
// gate (the real post-generation compile carries the credentials and performs
// the write).
const VERIFY_ITEM_ID = "verify-itemid";

// Resolve the Learnosity credentials for a compilation. A program may supply
// its own consumer key/secret via `set-var "learnosity-key" ...` /
// `set-var "learnosity-secret" ...`, which L0000's SET_VAR writes into
// `options`. The two must be supplied together (a key with a mismatched secret
// fails Learnosity's signature validation). When both are present they're used
// for all signing and `fromOptions` is true (the gate that permits item-bank
// mutations); otherwise the config-injected defaults (from the api layer's env)
// are used. Returns `{ error }` when exactly one is supplied.
function resolveCredentials(options: any): any {
  const cfg = (options && options.config && options.config.learnosity) || {};
  const optKey = options["learnosity-key"];
  const optSecret = options["learnosity-secret"];
  const hasKey = typeof optKey === "string" && optKey !== "";
  const hasSecret = typeof optSecret === "string" && optSecret !== "";
  if (hasKey !== hasSecret) {
    return { error: `Error: set-var "learnosity-key" and "learnosity-secret" must both be set together.` };
  }
  if (hasKey && hasSecret) {
    return { key: optKey, secret: optSecret, fromOptions: true };
  }
  return { key: cfg.key, secret: cfg.secret, fromOptions: false };
}

// Sign the compiled Learnosity activity so the view can hand `request` straight
// to LearnosityApp.init. The compile produces the unsigned `{ type, data }`
// activity (createItems/createQuestions/createAuthor); the browser SDK needs a
// *signed* request. L0158 did this signing in a second, client-triggered
// `init data {}` compile pass (its own View issued it after the cached
// compile); L0176 renders through the shared @graffiticode/l0000-view, which
// issues a single POST /compile and hands the result to the Form verbatim, so
// we fold the signing into the compile output here.
//
// Signing is pure (no network) and runs after the full transform, so it never
// duplicates a save-to-itembank write. Each signing stamps a fresh
// user_id / signature, so the compile output's `request` changes on every
// (re)compile even when the assessment is unchanged — that churn is why the
// Form keys its one-time Learnosity init on the stable question content rather
// than object identity (see packages/view/src/components/form/contentKey.ts).
async function signForRender(plain: any, options: any): Promise<any> {
  // Only sign Learnosity render output: a `{ type, data }` activity that has
  // not already been signed. Leaves bare/non-Learnosity values untouched.
  if (!plain || typeof plain !== "object" || !plain.type || plain.request) {
    return plain;
  }
  const creds = resolveCredentials(options);
  if (creds.error || !creds.key || !creds.secret) {
    // No usable credentials (e.g. a verification dry run without injected
    // secrets): leave the unsigned activity as-is rather than throwing.
    return plain;
  }
  const credArgs = { key: creds.key, secret: creds.secret };
  let request;
  switch (plain.type) {
  case "questions":
    request = await initQuestions(plain, credArgs);
    break;
  case "items":
    request = await initItems(plain, credArgs);
    break;
  case "author":
    // An Author Site session can edit and delete items, so it is signed only
    // with the program's own credentials, never with the server's default
    // account.
    if (!creds.fromOptions) {
      return plain;
    }
    request = await initAuthor(plain, credArgs);
    break;
  default:
    return plain;
  }
  return { ...plain, request };
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
      const creds = resolveCredentials(options);
      if (creds.error) {
        resume([creds.error], undefined);
        return;
      }
      const credArgs = { key: creds.key, secret: creds.secret };
      const { type } = plain;
      let val;
      switch (type) {
      case "questions":
        val = await initQuestions(plain, credArgs);
        break;
      case "items":
        val = await initItems(plain, credArgs);
        break;
      case "author":
        // Never with the server's default account; see signForRender.
        val = creds.fromOptions ? await initAuthor(plain, credArgs) : plain;
        break;
      }
      resume(err, val);
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
        // Dry run during generation-time verification: credentials aren't
        // injected (and `get-val-private` of an absent value bakes encrypt("")),
        // so skip BOTH credential gates and the write — just validate structure.
        const dryRun = options["lrn-id"] === VERIFY_ITEM_ID;
        const creds = resolveCredentials(options);
        if (creds.error && !dryRun) {
          resume([...err, creds.error], undefined);
          return;
        }
        const saveToItembank = members.save_to_itembank === true && !dryRun;
        if (saveToItembank && !creds.fromOptions) {
          resume([...err, `Error: save-to-itembank requires set-var "learnosity-key" and "learnosity-secret"; item bank writes are not permitted with the default credentials.`], undefined);
          return;
        }
        let itemsResult;
        try {
          itemsResult = await createItems({
            items,
            params: members.params,
            id: options["lrn-id"],
            saveToItembank,
            key: creds.key,
            secret: creds.secret,
          });
        } catch (e: any) {
          // A failed item-bank write (e.g. Learnosity Data API rejects the
          // signed request) must surface as a compile error, not an unhandled
          // rejection: an uncaught throw here never calls resume, so the compile
          // never resolves and the embedding view hangs on "Loading…" forever.
          resume([...err, `Error: ${String((e && e.message) || e)}`], undefined);
          return;
        }
        const continuation = toPlainObject(v1);
        const val = { ...continuation, ...itemsResult };
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
        // Dry run during generation-time verification: credentials aren't
        // injected (and `get-val-private` of an absent value bakes encrypt("")),
        // so skip BOTH credential gates and the write — just validate structure.
        const dryRun = options["lrn-id"] === VERIFY_ITEM_ID;
        const creds = resolveCredentials(options);
        if (creds.error && !dryRun) {
          resume([...err, creds.error], {});
          return;
        }
        const saveToItembank = members.save_to_itembank === true && !dryRun;
        if (saveToItembank && !creds.fromOptions) {
          resume([...err, `Error: save-to-itembank requires set-var "learnosity-key" and "learnosity-secret"; item bank writes are not permitted with the default credentials.`], {});
          return;
        }
        let questionsResult;
        try {
          questionsResult = await createQuestions(questions, {
            id: options["lrn-id"],
            saveToItembank,
            key: creds.key,
            secret: creds.secret,
          });
        } catch (e: any) {
          // A failed item-bank write must surface as a compile error rather than
          // an unhandled rejection (which would leave resume uncalled and hang
          // the embedding view on "Loading…"). See the matching guard in ITEMS.
          resume([...err, `Error: ${String((e && e.message) || e)}`], {});
          return;
        }
        const continuation = toPlainObject(v1);
        const val = { ...continuation, ...questionsResult };
        resume(err, val);
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
      const signed = await signForRender(val, options);
      resume(err, signed);
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


export const compiler = new Compiler({
  langID: "0176",
  version: "v0.0.1",
  Checker,
  Transformer,
});
