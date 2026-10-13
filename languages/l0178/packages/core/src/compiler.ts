// SPDX-License-Identifier: MIT
/* Copyright (c) 2023, ARTCOMPILER INC */
// L0178 — Learnosity Data API cookbook.
//
// Uniform surface (derived from vocab.ts): every PROPERTY is an arity-2 kebab
// function; a BLOCK is arity-2 and folds its [list] into a request; paging policy
// values are UPPERCASE TAG tokens. Everything except the block and the paging policy
// is optional.
//
// Property functions are deliberately DUMB — they collect, they do not validate. A
// field's legality and type depend on the (endpoint, action) block it lands in, and a
// property function cannot see that context. All validation therefore happens at the
// fold, where the block is known. This is the same discipline L0177 arrived at, and
// for the same reason: a field validated in isolation is a field validated against
// the wrong schema.
//
// Each accepted field records its exact Learnosity path in `paths`, so the recipe
// never infers one from a kebab name (`include-items` is `include.items`, but
// `item-pool-id` is `item_pool_id`).
//
// NOTE ON FAIL-OPEN: L0177 drops unknown fields because the Author API silently
// ignores them. The Data API reports errors instead, so the reason here is different
// and narrower — an unknown field is a design mistake worth naming, not a silent
// enforcement failure. Do not import L0177's differential-verification reasoning.
import {
  Checker as BaseChecker,
  Transformer as BaseTransformer,
  Compiler,
} from "@graffiticode/l0000";
import {
  ARITY1, BLOCKS, TOPLEVEL, PROPERTIES, PAGING_TAGS, TOK,
  type Constraint, type Fields,
} from "./vocab.js";

function toPlainObject(val: any): any {
  if (val !== null && typeof val === "object" && val._type === "record" && val._entries instanceof Map) {
    const obj: any = {};
    for (const [k, v] of val._entries) obj[(k as string).replace(/^(tag|str|num):/, "")] = toPlainObject(v);
    return obj;
  }
  if (Array.isArray(val)) return val.map(toPlainObject);
  return val;
}
const pushWarn = (options: any, w: string) => { (options.__warnings ||= []).push(w); };
const recordPath = (options: any, from: string, to: string) => { (options.__paths ||= {})[from] = to; };

// --- property value validation (called from the fold, which knows the type) ---
function validateProp(
  name: string, type: string, value: any, options: any, c?: Constraint,
): any {
  const inRange = (v: any) => !c?.values || c.values.includes(v);
  const rangeWarn = (v: any) =>
    pushWarn(options, `${name}: ${JSON.stringify(v)} isn't one of ${c!.values!.map((s) => `"${s}"`).join(", ")}.`);

  if (type === "tags") {
    // Learnosity's TagsV2: a list of {type, name?}. Written as gc records so the design
    // mirrors the payload — [{type: "subject", name: "English"}] — rather than inventing
    // a constructor that would have to be kept in step with it.
    const list = Array.isArray(value) ? value : value == null ? [] : [value];
    const out: any[] = [];
    for (const t of list) {
      if (!t || typeof t !== "object" || Array.isArray(t)) {
        pushWarn(options, `${name}: each tag must be a record like {type: "subject", name: "English"}.`);
        continue;
      }
      if (typeof t.type !== "string" || t.type.trim() === "") {
        pushWarn(options, `${name}: every tag needs a "type" string — e.g. {type: "subject", name: "English"}.`);
        continue;
      }
      const nm = t.name;
      if (!(nm === undefined || typeof nm === "string")) {
        pushWarn(options, `${name}: a tag's "name" must be a string.`);
        continue;
      }
      for (const k of Object.keys(t)) {
        if (k !== "type" && k !== "name") {
          pushWarn(options, `${name}: "${k}" isn't part of a tag — a tag is {type, name}; "name" is optional and matches every name of that type when omitted.`);
        }
      }
      out.push(nm === undefined ? { type: t.type } : { type: t.type, name: nm });
    }
    return out;
  }
  if (type === "unmodeled") {
    // Documented by Learnosity, deliberately not modelled here. It passes through so a
    // valid request can still be built, and says so — which is more useful than silence
    // (the caller would not know it was unchecked) or a typo error (it is not a typo).
    pushWarn(options, `${name}: passed through unchecked. It carries item CONTENT, which this dialect does not model — compose it where the content lives and hand it through. Nothing here validates its shape.`);
    return value;
  }
  if (type === "records") {
    // A list of records checked against a declared element schema. Each key is validated
    // by the same machinery as a top-level field, so nested types and enums come for
    // free. Ported from L0177, which needed it for item banks; here it is `items`, the
    // ItemObjects an offline package is built from.
    const schema = (c?.schema || {}) as Fields;
    const required = c?.required || [];
    const list = Array.isArray(value) ? value : value == null ? [] : [value];
    const out: any[] = [];
    for (const rec of list) {
      if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
        pushWarn(options, `${name}: each entry must be a record, e.g. {${Object.keys(schema)[0]}: …}.`);
        continue;
      }
      const clean: any = {};
      for (const [k, v] of Object.entries(rec)) {
        const f = schema[k];
        if (!f) {
          pushWarn(options, `${name}: "${k}" isn't part of this record. Accepts: ${Object.keys(schema).join(", ")}.`);
          continue;
        }
        clean[k] = validateProp(k, f[1], v, options, f[2] as Constraint | undefined);
      }
      for (const r of required) {
        if (clean[r] === undefined) pushWarn(options, `${name}: every entry needs "${r}".`);
      }
      out.push(clean);
    }
    if (c?.maxEntries && out.length > c.maxEntries) {
      pushWarn(options, `${name}: ${out.length} entries exceeds the documented maximum of ${c.maxEntries}.`);
    }
    return out;
  }
  if (type === "strings") {
    const list = Array.isArray(value) ? value : value == null ? [] : [value];
    if (!list.every((s) => typeof s === "string")) pushWarn(options, `${name} must be a list of strings.`);
    else for (const s of list) if (!inRange(s)) rangeWarn(s);
    if (c?.maxEntries && list.length > c.maxEntries) {
      pushWarn(options, `${name}: ${list.length} entries exceeds the documented maximum of ${c.maxEntries}.`);
    }
    return list;
  }
  if (type === "timestamp") {
    // Learnosity accepts a UTC Unix integer OR an ISO 8601 string here, so neither
    // alone is a type error and only a third kind of value is.
    if (typeof value !== "number" && typeof value !== "string") {
      pushWarn(options, `${name} must be a UTC Unix timestamp (number) or an ISO 8601 datetime string.`);
    }
    return value;
  }
  if (type === "boolean" && typeof value !== "boolean") {
    pushWarn(options, `${name} must be true or false.`);
    return value;
  }
  if (type === "number") {
    if (typeof value !== "number") pushWarn(options, `${name} must be a number.`);
    else if (c?.max !== undefined && value > c.max) {
      // Measured, not merely documented: the API CLAMPS rather than rejects. A limit of
      // 100 returns 50 records with meta.status true and no error — so every page then
      // looks short, and a loop that stops when data.length < limit quits after one page
      // while meta.next was present the whole time. That is why this is worth a warning
      // at all: the request succeeds, and the damage is silent.
      pushWarn(options, `${name}: ${value} exceeds the maximum of ${c.max}. Learnosity silently clamps it — the request succeeds and returns ${c.max} records with no error, so every page looks short and a loop that stops on a short page will drop the rest. Set ${name} to ${c.max} or less, and terminate the loop on this endpoint's own end-of-data signal rather than on page size.`);
    }
  } else if (type === "string") {
    if (typeof value !== "string") pushWarn(options, `${name} must be a string.`);
    else if (!inRange(value)) rangeWarn(value);
  }
  return value;
}

// Validate a collected property chain against the field set legal in THIS block.
// A field that doesn't belong is warned and DROPPED rather than passed through: it
// would be sent to Learnosity as part of a signed request body, and the caller would
// be debugging an API-level rejection instead of reading it here.
function validateFields(rec: any, fields: Fields, label: string, options: any): any {
  const out: any = {};
  for (const [k, v] of Object.entries(rec)) {
    const spec = fields[k];
    if (!spec) {
      pushWarn(options, `${label}: "${k}" isn't a request field of this operation — dropped. ` +
        `Accepts: ${Object.keys(fields).join(", ")}.`);
      continue;
    }
    const [path, type, constraint] = spec;
    out[k] = validateProp(k, type, v, options, constraint as Constraint | undefined);
    recordPath(options, k, path);
  }
  return out;
}

// Cross-field rules the docs state but a per-field check cannot see.
function checkCoherence(block: any, req: any, options: any) {
  if (req["advanced-tags-none"] !== undefined
      && req["advanced-tags-all"] === undefined
      && req["advanced-tags-either"] === undefined) {
    pushWarn(options, "advanced-tags-none can't be used on its own — Learnosity requires advanced-tags-all or advanced-tags-either in the same request.");
  }
  if (req["authoring-workflow-states"] !== undefined
      && req["authoring-workflow-reference"] === undefined) {
    pushWarn(options, "authoring-workflow-states needs authoring-workflow-reference — the workflow reference is mandatory whenever authoring_workflow is part of the request.");
  }
  if (req.next !== undefined) {
    pushWarn(options, "`next` is a cursor the API hands back in meta.next, not a value to author. Set a paging policy instead and let the procedure carry the token between requests.");
  }
}

// --- data-job finalize: top-level coherence, holes, ordering ---
const TOP_ALLOWED = new Set<string>([...Object.keys(TOPLEVEL), "block", "request", "paths"]);

function finalize(rec: any, options: any): any {
  const holes: string[] = [];
  const specificity: string[] = [];
  const top: any = {};
  for (const [k, v] of Object.entries(rec)) {
    if (!TOP_ALLOWED.has(k)) { pushWarn(options, `"${k}" isn't a top-level data-job property.`); continue; }
    top[k] = v;
  }

  const block = top.block;
  const request = top.request || {};

  if (!block) {
    holes.push(`Which Data API operation? Use exactly one of: ${Object.keys(BLOCKS).join(", ")}.`);
  }

  // The centrepiece. A paged read that does not say how far it reads is the bug this
  // dialect exists to prevent: the API returns 200 with a well-formed record set that
  // is silently short, and meta.records counts the page rather than the total.
  if (block?.paged && top.paging === undefined) {
    holes.push("This read is paged and the design doesn't say how far it reads. Set `paging EXHAUSTIVE` to read the whole result set, or `paging SINGLE-PAGE` to deliberately take one page. Leaving it unsaid is how a truncated read ships: the response is a valid 200 either way, and meta.records counts the page you got, not the total that matched.");
  }

  if (block) {
    if (top.paging === "single-page") {
      specificity.push("`paging SINGLE-PAGE` returns at most one page. The result is not the full match set, and nothing in the response says so — meta.records counts what came back.");
    }
    // What counts as a filter depends on the block, so derive it from the block's own
    // fields rather than from a hand-kept list. Everything that is not paging, ordering
    // or response-shaping narrows the result set.
    // organisation-id and item-pool-id choose the CONTAINER, not the contents — a job
    // that names only a bank still reads the whole bank, so they must not count as
    // narrowing or the "reads everything" advisory goes quiet exactly when it matters.
    const NON_FILTER = new Set([
      "limit", "next", "sort", "sort-field", "organisation-id", "item-pool-id",
    ]);
    const filters = Object.keys(block.fields)
      .filter((f) => !NON_FILTER.has(f) && !f.startsWith("include-"));
    if (block.paged && !filters.some((f) => request[f] !== undefined)) {
      specificity.push(`No filter is set, so this reads everything ${block.endpoint} returns. Narrow it with ${filters.slice(0, 4).join(", ")} or a mintime/maxtime window unless a full extract is what you want.`);
    }
    if (block.primaryBankDefault && request["organisation-id"] === undefined) {
      specificity.push("No Item bank specified (`organisation-id`) — the consumer's primary Item bank is used.");
    }
    // Write safety. Every hazard here is silent — the request succeeds and the damage
    // surfaces later — so these are advisories on a job that is otherwise correct.
    if (block.destructive) {
      // A delete gets its own warning, ahead of the generic write one: there is nothing
      // to re-read afterwards and nothing to roll back to.
      specificity.push(`This job DESTROYS data irreversibly. ${block.endpoint} + ${block.action} cannot be undone, the response carries only a job reference, and there is nothing to re-read afterwards to check what went. Confirm the target is what you mean BEFORE running it, not after.`);
    }
    if (block.writes) {
      // "Item bank" is only right for itembank/* — sessions are not in one, and telling a
      // reader to point a session write at a scratch BANK is advice they cannot follow.
      const inBank = block.endpoint.startsWith("itembank/");
      specificity.push(`This job WRITES. ${block.endpoint} + ${block.action} persists${inBank ? " to the Item bank" : ""}, and the response does not echo what was written — re-read to confirm.` + (inBank ? " Point it at a scratch bank until you have seen it do the right thing." : " Rehearse it against data you can afford to lose before pointing it at anything real."));
      // Which of the two semantics applies is measured per (endpoint, action), not implied
      // by the verb: on itembank/items/tags, `set` replaces the tag set and `update` merges
      // into it, and the reference documents identical parameters for both.
      if (block.writeSemantics === "replace") {
        specificity.push(`\`${block.action}\` on this endpoint REPLACES what is there — anything you do not send is cleared, not kept. To change one thing without losing the rest, send the whole picture, or use an operation on this endpoint that merges if one exists.`);
      } else if (block.writeSemantics === undefined) {
        // Silence would be worse than a hedge here. Merge-vs-replace is the most
        // dangerous unknown a write carries, and the two operations measured so far are
        // both tag-assignment endpoints — not enough to generalise from.
        specificity.push("Whether this REPLACES what is there or MERGES into it has NOT been established for this operation. Two endpoints were measured and both replace under `set` and merge under `update`, but they were both tag assignments, and this API has repeatedly turned out to differ per endpoint. Rehearse against data you can afford to lose and observe which it does before trusting it.");
      } else if (block.writeSemantics === "merge") {
        specificity.push(`\`${block.action}\` on this endpoint MERGES into what is there, so this adds without clearing. That is measured for this operation and does not generalise — the same endpoint's \`set\` replaces.`);
      }
      const entries = Array.isArray(request.items) ? request.items : [];
      if (entries.some((e: any) => e && e.status === undefined)) {
        specificity.push("An Item written without `status` defaults to `unpublished`, and an unpublished Item cannot be used in an assessment. The write succeeds either way, so nothing tells you until delivery is empty — set `status` explicitly.");
      }
      if (entries.some((e: any) => e && e["new-reference"] !== undefined)) {
        specificity.push("`new-reference` RENAMES the Item at `reference`. Anything referring to the old reference — activities, saved sessions, your own records — will no longer resolve.");
      }
    }
    if (request.limit === undefined && block.paged) {
      specificity.push("No `limit` set — Learnosity's default page size applies, and the documented maximum is 50.");
    }
  }

  // Holes lead (progressive disclosure), and specificity nudges wait until they're
  // filled — but validity warnings always surface: they report input we rejected.
  const attrWarnings: string[] = options.__warnings || [];
  const warnings = holes.length > 0 ? [...holes, ...attrWarnings] : [...attrWarnings, ...specificity];

  return {
    endpoint: block?.endpoint,
    action: block?.action,
    writes: block?.writes,
    // merge | replace, measured per (endpoint, action). Never inferred from the verb.
    write_semantics: block?.writeSemantics,
    paged: block?.paged,
    // Which end-of-data signal this endpoint uses. The recipe branches on it; there is
    // no correct universal loop. See vocab.ts PagingEnd.
    paging_end: block?.pagingEnd,
    async: block?.async,
    // Where an async operation is redeemed. Carried in the output for the same reason as
    // paging_end: the recipe should branch on data it is given rather than hard-code the
    // knowledge that `jobs` is the channel. Async operations are spread across four path
    // families, so the channel is not inferable from the endpoint.
    poll_with: block?.async
      ? {
        endpoint: "jobs",
        action: "get",
        // Where to read the reference from THIS endpoint's response. Verified to differ
        // per endpoint, so the recipe must be told rather than left to generalise.
        // Only stated when the block declares a shape. Guessing would be worse than
        // silence: both forms are real, and a wrong one yields `undefined` and a poll
        // that never finds its job.
        ...(block.asyncEnvelope
          ? {
            job_reference_at: block.asyncEnvelope === "object"
              ? "data.job_reference"
              : "data[0].job_reference",
          }
          : {}),
      }
      : undefined,
    paging: top.paging,
    request,
    // Every request field this job sets, mapped to its exact Learnosity path, so the
    // recipe names paths rather than inferring them from kebab names.
    paths: options.__paths || {},
    complete: holes.length === 0,
    warnings,
  };
}

// --- Checker: arity-aware, generated for every function token ---
const ARITIES: Record<string, number> = {};
for (const k of ARITY1) ARITIES[TOK(k)] = 1;
for (const k of [...Object.keys(BLOCKS), ...PROPERTIES]) ARITIES[TOK(k)] = 2;

class Checker extends BaseChecker { [key: string]: any; }
for (const [tok, arity] of Object.entries(ARITIES)) {
  Checker.prototype[tok] = arity === 1
    ? function (node: any, options: any, resume: any) {
      this.visit(node.elts[0], options, async (e0: any) => resume(([] as any[]).concat(e0 || []), node));
    }
    : function (node: any, options: any, resume: any) {
      this.visit(node.elts[0], options, async (e0: any) => {
        this.visit(node.elts[1], options, async (e1: any) => resume(([] as any[]).concat(e0 || [], e1 || []), node));
      });
    };
}

// --- Transformer ---
class Transformer extends BaseTransformer {
  [key: string]: any;
  PROG(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => resume(e0, v0.pop()));
  }
  DATA_JOB(node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => resume(e0, finalize(toPlainObject(v0) || {}, options)));
  }
}

// property functions (arity 2): merge { name: value }. No validation — the fold does
// it, because only the fold knows which block this property landed in.
for (const name of PROPERTIES) {
  Transformer.prototype[TOK(name)] = function (node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      this.visit(node.elts[1], options, async (e1: any, v1: any) => {
        const cont = toPlainObject(v1) || {};
        let val = toPlainObject(v0);
        // `paging` is design intent carried by a TAG, not an API field. Resolve it here
        // rather than at the fold: it has no block to be scoped by.
        if (name === "paging") {
          const tag = val && typeof val === "object" && "tag" in val ? (val as any).tag : val;
          if (PAGING_TAGS[tag]) val = PAGING_TAGS[tag];
          else {
            pushWarn(options, `paging: ${tag} isn't a paging policy — use ${Object.keys(PAGING_TAGS).join(" or ")}.`);
            val = undefined;
          }
        }
        resume(([] as any[]).concat(e0 || [], e1 || []), { ...cont, [name]: val });
      });
    });
  };
}

// blocks (arity 2): fold the [list] into a request, in context.
for (const [name, spec] of Object.entries(BLOCKS)) {
  Transformer.prototype[TOK(name)] = function (node: any, options: any, resume: any) {
    this.visit(node.elts[0], options, async (e0: any, v0: any) => {
      this.visit(node.elts[1], options, async (e1: any, v1: any) => {
        let elements = toPlainObject(v0);
        if (!Array.isArray(elements)) elements = elements == null ? [] : [elements];
        const request: any = {};
        for (const el of elements) {
          if (!el || typeof el !== "object") continue;
          Object.assign(request, validateFields(el, spec.fields, name, options));
        }
        // Discriminant values the operation always sends. Recorded in `paths` like any
        // other field so the recipe reproduces them verbatim.
        for (const [k, [path, value]] of Object.entries(spec.fixed || {})) {
          request[k] = value;
          recordPath(options, k, path);
        }
        checkCoherence(spec, request, options);
        const cont = toPlainObject(v1) || {};
        resume(([] as any[]).concat(e0 || [], e1 || []), { ...cont, block: spec, request });
      });
    });
  };
}

export { Checker, Transformer };
export const compiler = new Compiler({
  langID: "0178",
  version: "v0.0.1",
  Checker,
  Transformer,
});
