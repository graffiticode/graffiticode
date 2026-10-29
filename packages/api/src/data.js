import { taskRequiresProtected, REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { InvocationRefused } from "./invocations.js";
import { buildReadArtifact, buildReadPublished } from "./read.js";
import { ArtifactConflict } from "./storage/artifacts.js";
import { bindingFor } from "./storage/lang-override.js";
import { randomUUID } from "node:crypto";
import { classify } from "@graffiticode/common/failures";
import { canonicalDigest } from "@graffiticode/common/canonical";
import { decodeChainId } from "@graffiticode/common/chain";
import { noAudit } from "./audit.js";
import { normalizeLang, PreflightUnavailable } from "./admission.js";
import { checkGeneration, compileCacheKey, getActiveGeneration as readActiveGeneration, getLanguageGenerations as readLanguageGenerations } from "./generation.js";
import { INTERPRETER_DECLARATIONS, interpreterLangFor } from "@graffiticode/common/interpreter-manifest";
import {
  NO_STORE, PERMANENT, authorityFor, combineRestrictions, getInterpreterLanguages as readInterpreterLanguages,
  interpretedRestrictions, legacyRestrictions, permanent, sharable, stageCacheKey, withoutStageMetadata,
} from "./interpret.js";

// A compile error that names why it failed (spec FAIL-01): `message` is the
// text callers already read; `code` and `category` say which kind of failure.
const failedWith = (message, code) => ({ message, from: -1, to: -1, code, category: classify(code).category });

const ARTIFACT_WRITE_ATTEMPTS = 3;
const ARTIFACT_RETRY_MS = 100;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// What each stage of a chain with an interpreted stage did (interpreter plan
// B3): its stage id, language, how it ran and whether the stage cache answered.
// It is kept out of every stage's data and the response.
const logStage = record => console.log("stage", JSON.stringify(record));

// What a private artifact keeps of a compile's output: everything but a
// signature. A language's envelope is { data, errors }; L0176 folds its
// time-limited preview signature into data.request, and the read path signs
// afresh for each view instead.
const unsignedContent = obj => {
  const data = obj?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return obj;
  const { request: _signature, ...rest } = data;
  return { ...obj, data: rest };
};

// A signature can also come from elsewhere in a program (L0176's explicit
// `init` returns a signed request as the value itself). A signed request is
// recognized by its structure — a `security` block, an object or its JSON
// text, carrying a string `signature` — never by text, so content that merely
// mentions a signature is stored as usual. Output that still holds a signed
// request after stripping is not stored.
const parsedSecurity = security => {
  if (typeof security !== "string") return security;
  try {
    return JSON.parse(security);
  } catch {
    return null;
  }
};
const isSignedRequest = value => {
  const security = parsedSecurity(value.security);
  return Boolean(security) && typeof security === "object" && typeof security.signature === "string";
};
const carriesSignature = value => {
  if (Array.isArray(value)) return value.some(carriesSignature);
  if (value && typeof value === "object") {
    return isSignedRequest(value) || Object.values(value).some(carriesSignature);
  }
  return false;
};

// When a compile through a connection succeeded but its artifact was not
// stored, the response says so explicitly (spec RECOVER-01) beside the result,
// never as a compile error: the provider effects happened. It carries the
// invocation and retry identity:
//   artifact-storage-unavailable  transient; retrying the same request with
//                                 the same idempotency key replays the
//                                 receipts and stores it, writing nothing again
//   artifact-rejected             permanent; the output carries signed
//                                 authority, or differs from the artifact this
//                                 invocation already stored (a new run, and a
//                                 republish for published content, is needed)
const artifactNotStored = ({ error, reason, invocation, idempotencyKey }) => ({
  stored: false,
  error,
  category: classify(error).category,
  reason,
  // Without the key a retry is a new invocation, which may write again.
  retryable: error === "artifact-storage-unavailable" && Boolean(idempotencyKey),
  invocationId: invocation.invocationId,
  seq: invocation.seq,
  idempotencyKey,
});

const buildGetData = ({
  compile, langOverrideStorer, validateOutput, allocateInvocation = null, artifactStorer = null, publications = null, audit = noAudit,
  // Chain admission (W4): the admission client, and whether a new invocation
  // through this connection is allocated for it (CHAIN_ADMISSION).
  chainAdmission = null, admissionWanted = _connectionId => false,
  // The active compile generation, and the per-language switch generations
  // (generation.js), each read at each request's start.
  getActiveGeneration = readActiveGeneration, getLanguageGenerations = readLanguageGenerations,
  // The interpreter pass (B3): the client for a language's model and
  // /interpret calls (comp.js), the stage cache (storage/stage-results.js),
  // the languages turned on (interpret.js, read at each request's start) and
  // the declarations that cap them. Without an interpreter every stage is
  // legacy.
  interpreter = null, stageResults = null, getInterpreterLanguages = readInterpreterLanguages,
  declarations = INTERPRETER_DECLARATIONS, onStage = logStage, now = Date.now
}) => {
  const readArtifact = buildReadArtifact({ compile, artifactStorer, allocateInvocation, audit });

  // Chain admission for a marked invocation (W4 section F): returns
  // { admissionToken, stages: [{ stage, lang, revision, tagUrl }] }, or
  // { errors } with nothing executed.
  const admitChain = async ({ tasks, id, invocation, authToken, connectionId, attemptId, override = null }) => {
    const refuseChain = async (message, code, stage = undefined) => {
      await audit({ event: "admission", outcome: code === "preflight-unavailable" || code === "policy-unavailable" ? "failed" : "denied", reason: code, category: classify(code).category, stage, invocationId: invocation.invocationId, connectionId, attemptId });
      return { errors: [failedWith(message, code)] };
    };
    if (!chainAdmission) return refuseChain("Error: this server can't run an admitted plan", "connections-unavailable");
    const { invocationToken } = invocation;
    const policyFailure = (e, what) => (e?.reason
      ? refuseChain(`Error: permission denied (${e.reason})`, e.reason)
      : refuseChain(`Error: could not ${what}`, "policy-unavailable"));
    let taskIds;
    try {
      taskIds = decodeChainId(id);
    } catch {
      return refuseChain("Error: the task chain could not be read", "plan-binding-mismatch");
    }
    if (taskIds.length !== tasks.length) return refuseChain("Error: the task chain could not be read", "plan-binding-mismatch");
    // A user's language override pins them to a revision no plan can admit:
    // refused before anything is preflighted, never silently ignored.
    const overridden = tasks.map(t => `L${normalizeLang(t.lang)}`).filter(lang => bindingFor(override?.bindings, lang));
    if (overridden.length) {
      const message = `Error: a language override (${[...new Set(overridden)].join(", ")}) can't run through a connection; remove it to run this`;
      return refuseChain(message, "language-override-refused");
    }
    // A retry pins what its first admission pinned, before resolving any URL.
    let plan;
    try {
      ({ plan } = await chainAdmission.lookupPlan({ authToken, invocationToken }));
    } catch (e) {
      return policyFailure(e, "look up this compile's plan");
    }
    const manifests = [];
    for (const [index, task] of tasks.entries()) {
      const stage = `s${index}`;
      let baseUrl;
      if (plan) {
        const pinned = plan.stages[index];
        if (!pinned || pinned.stage !== stage || !pinned.available || typeof pinned.tagUrl !== "string") {
          return refuseChain(`Error: the compiler revision this run was admitted on is no longer available (${stage}); start a new run, which may repeat its writes`, "pinned-revision-unavailable", stage);
        }
        baseUrl = pinned.tagUrl;
      } else {
        baseUrl = await chainAdmission.baseUrlFor(task.lang);
      }
      let out;
      try {
        out = await chainAdmission.preflight({ baseUrl, lang: task.lang, stage, code: task.code });
      } catch (e) {
        if (!(e instanceof PreflightUnavailable)) throw e;
        return refuseChain(`Error: ${e.message}`, "preflight-unavailable", stage);
      }
      // The compiler's own validation errors refuse the chain as compile errors.
      if (Array.isArray(out?.errors) && out.errors.length) return { errors: out.errors };
      const m = out?.manifest;
      // The gateway loaded the stored task; the compiler must pin that program.
      if (!m || m.stage !== stage || m.lang !== normalizeLang(task.lang) || m.sourceDigest !== canonicalDigest(task.code)) {
        return refuseChain(`Error: stage ${stage}'s compiler reported another program than the stored task`, "plan-binding-mismatch", stage);
      }
      manifests.push(m);
    }
    let admission;
    try {
      admission = await chainAdmission.admit({ authToken, invocationToken, taskIds, stages: manifests });
    } catch (e) {
      return policyFailure(e, "admit this compile");
    }
    // Each stage keeps the functions its plan admits (what it could do).
    return {
      admissionToken: admission.admissionToken,
      stages: admission.stages.map((s, i) => ({ ...s, requiredFunctions: manifests[i].requiredFunctions ?? [] })),
    };
  };
  const readPublished = buildReadPublished({ compile, artifactStorer, publications, audit });
  return async ({
    taskStorer, compileStorer, id, auth, authToken, options, action, refresh,
    connectionId = null, idempotencyKey = null, read = false, publicationId = null,
    generation = /** @type {string | undefined} */ (undefined),
    // The id's tasks, when the route already loaded them (to charge the
    // per-client signing limit, signing-limit.js), so they're read once.
    preloadedTasks = /** @type {any} */ (undefined)
  }) => {
    // Captured before anything else and kept for this request's read and its
    // write: a request that started without a generation, or before one was
    // active, never writes under it, however late it finishes.
    const active = getActiveGeneration();
    const generations = getLanguageGenerations();
    const interpreterLangs = interpreter ? getInterpreterLanguages() : new Set();
    const tasks = preloadedTasks !== undefined ? preloadedTasks : await taskStorer.get({ id, auth });
    if (!tasks) {
      return { errors: [{ message: "Task not found", from: -1, to: -1 }] };
    }
    // Refused (400) unless it is the active generation and every task is
    // L0158. It changes nothing but the compile store's key.
    checkGeneration({ generation, active, tasks });
    // Every language in the chain with a switch generation scopes it too.
    const cacheKey = compileCacheKey({ id, generation, tasks, generations });
    // A view of a published item serves the result the publication names,
    // under the publisher's authority; the viewer may be anonymous.
    if (read && publicationId) {
      if (typeof action === "object") action.noStore = true;
      return readPublished({ tasks, id, publicationId });
    }
    // A view through a connection serves the stored result and never runs the
    // program; POST /compile is the explicit run that makes one.
    if (read && connectionId) {
      if (typeof action === "object") action.noStore = true;
      return readArtifact({ tasks, id, uid: auth?.uid, authToken, connectionId });
    }
    // A user with a language-server override is testing a specific revision, so
    // bypass the shared compile cache entirely: returning a cached
    // default-binding result would mask the override, and writing the
    // revision-specific result would pollute the cache for everyone else.
    const uid = auth?.uid;
    // Read once: this snapshot routes every stage and schema fetch of the
    // request, so a binding that changes (or a memo that expires) mid-request
    // can't mix revisions, or route to a revision this decision didn't see.
    const override = uid && langOverrideStorer
      ? await langOverrideStorer.get({ uid })
      : undefined;
    const routeFor = lang => bindingFor(override?.bindings, lang);
    // `refresh` is the caller saying "compile this now", not "tell me what it
    // once compiled to". It exists because a taskId is content-addressed over
    // {lang, code} and says NOTHING about the compiler version: when a language
    // ships a breaking change, every cached compile from before it keeps
    // answering, so a program the checker now rejects still reads as a clean
    // 200 with no errors. That is a false PASS for anything asserting "this
    // compiles" — the daily corpus ping, the sweep, and the corpus generator
    // all verify through this path. Unlike `override`, a refresh WRITES its
    // result back (see below), so it repairs the record rather than dodging it.
    // A compile through a selected connection is specific to that caller and
    // connection, so it neither reads nor writes the shared, content-addressed
    // cache (a cached result would answer without the compiler ever consulting
    // policy, and a written one would hand this caller's output to everyone).
    // A chain that requires a protected function (per the authoritative
    // registry, any layer, with or without a selected connection) must never be
    // answered from, or written to, the shared cache: a cached result would skip
    // the compiler's permission admission entirely. This covers entries written
    // before the function was registered, because it is decided before lookup.
    const requiresProtected = tasks.some(task => taskRequiresProtected(task));
    // A stage is interpreted when its language is turned on, and never through
    // a connection (B3: commands come later; an admitted plan runs as today).
    // A chain with one is never answered from, or written to, the whole-chain
    // store: its key knows nothing of an interpreted stage's revision, expiry,
    // class or authority. Its stages use the stage cache instead.
    const isInterpreted = task => !connectionId && interpreterLangs.has(normalizeLang(task.lang));
    const interpretedChain = tasks.some(isInterpreted);
    const bypassCache =
      Boolean(override) || Boolean(refresh) || Boolean(connectionId) || requiresProtected || interpretedChain;
    // There exists a task that we are authorized to see.
    if (!bypassCache) {
      const cached = await compileStorer.get({ id: cacheKey, auth });
      if (cached && cached.data) {
        return cached.data;
      }
    }
    // A language whose output expires answers `cache: false` in its compile
    // envelope (L0176 folds a time-limited Learnosity signature into every
    // compile). One volatile layer makes the whole composed result volatile, so
    // this accumulates across the chain rather than taking the last answer.
    let cacheable = !requiresProtected && !connectionId;
    // Each layer is checked against its own language's schema.json, so a
    // mismatch is reported where it started rather than where it surfaced. The
    // data is kept — an upstream agent may still make use of it — but a result
    // carrying a schema error is never cached: it is a compiler bug, and the
    // next deploy should not be answered with this one's output.
    // `baseUrl` is the revision that produced `obj`, so its schema is the one
    // checked.
    const checkShape = async (lang, obj, baseUrl) => {
      if (typeof validateOutput !== "function") {
        return obj;
      }
      const schemaErrors = await validateOutput(lang, obj, { baseUrl, id });
      if (!schemaErrors.length) {
        return obj;
      }
      cacheable = false;
      return { ...obj, errors: [...(obj.errors ?? []), ...schemaErrors] };
    };
    // A compile through a connection runs under one logical invocation for the
    // whole chain, allocated here, before any stage is dispatched. Each stage
    // is named by its position in the chain, which is fixed by the
    // content-addressed id, so a retry gives every stage the same name.
    // This attempt's own id: repeated attempts under one idempotency key share
    // the invocation, and are told apart by it in the audit.
    let invocation = null;
    const attemptId = connectionId ? randomUUID() : undefined;
    if (connectionId) {
      if (!allocateInvocation) {
        return { errors: [failedWith("Error: connections are not available on this server.", "connections-unavailable")] };
      }
      try {
        invocation = await allocateInvocation({ authToken, connectionId, taskId: id, options, idempotencyKey, admission: Boolean(chainAdmission) && admissionWanted(connectionId) });
      } catch (e) {
        // Refused, the compile ends here: no other invocation is started.
        if (e instanceof InvocationRefused) {
          await audit({ event: "gateway-invocation", outcome: "denied", reason: e.reason, category: classify(e.reason).category, connectionId, attemptId });
          return { errors: [failedWith(`Error: permission denied (${e.reason})`, e.reason)] };
        }
        await audit({ event: "gateway-invocation", outcome: "failed", reason: "policy-unavailable", category: "unavailable", connectionId, attemptId });
        return { errors: [failedWith("Error: could not start a compile through this connection", "policy-unavailable")] };
      }
      await audit({ event: "gateway-invocation", outcome: "allowed", invocationId: invocation.invocationId, connectionId, attemptId });
    }
    // A marked invocation runs only under its admitted plan, whatever
    // CHAIN_ADMISSION says now (W4 section C): every stage preflighted and the
    // chain admitted before any stage executes, or nothing runs.
    let admitted = null;
    // From the cutover (Policy's minimum contract 2), an invocation started
    // before it has no plan and can't be resumed (spec RELEASE-01): an
    // explicit new run is required, and it may repeat writes.
    if (invocation && invocation.contract !== 2 && invocation.minContractVersion >= 2) {
      await audit({ event: "admission", outcome: "denied", reason: "invocation-incompatible", category: classify("invocation-incompatible").category, invocationId: invocation.invocationId, connectionId, attemptId });
      return { errors: [failedWith("Error: this run started under an earlier permission contract and can't be resumed. Start a new run (a new idempotency key); it may repeat writes this run already made", "invocation-incompatible")] };
    }
    if (invocation?.contract === 2) {
      const result = await admitChain({ tasks, id, invocation, authToken, connectionId, attemptId, override });
      if (result.errors) return { errors: result.errors };
      admitted = result;
    }
    // Every protected call's effects in this compile, stage by stage (spec
    // FAIL-01): an earlier stage's save is still reported when a later stage
    // fails. A language reports them as `effects` beside its output.
    const effects = [];
    const takeEffects = (obj, index) => {
      if (!obj || typeof obj !== "object" || !Array.isArray(obj.effects)) return obj;
      for (const e of obj.effects) {
        // The stage is ours (its position in the chain), never the language's.
        if (e && typeof e === "object") effects.push({ ...e, stage: `s${index}` });
      }
      // For us, not for the next stage's input or the result.
      const { effects: _taken, ...rest } = obj;
      return rest;
    };
    // The restrictions of the data the next stage receives: the strictest class
    // and earliest expiry of every stage so far. Stages run one at a time, in
    // order, so each reads it before the next stage starts.
    /** @type {import("./interpret.js").Restrictions} */
    let upstream = PERMANENT;
    // Set when a declared stage's no-store result would have fed another stage.
    let refused = false;
    // An interpreted stage (B3): its program compiled to a model, then the
    // model interpreted against its input, the upstream stage's envelope, in
    // `present` mode at the head and `evaluate` below it. Returns its envelope,
    // without the API's metadata, and its own restrictions.
    const interpretStage = async ({ task, index, data }) => {
      const lang = normalizeLang(task.lang);
      const interpreterLang = interpreterLangFor(lang, declarations);
      const stage = `s${index}`;
      const mode = index === 0 ? "present" : "evaluate";
      const modelBaseUrl = routeFor(task.lang);
      const baseUrl = interpreterLang === lang ? modelBaseUrl : routeFor(interpreterLang);
      const record = { stage, lang, interpreterLang, mode, run: "interpret" };
      const failure = (message, code) =>
        ({ out: { data: null, errors: [failedWith(message, code)] }, own: NO_STORE, baseUrl, record: { ...record, cache: "skip", outcome: code } });
      const compiled = await interpreter.model({ lang, code: task.code, auth: authToken, options, uid, baseUrl: modelBaseUrl });
      if (compiled?.responseLost) return failure(`Error: stage ${stage}'s compiler didn't answer`, "compile-response-lost");
      if (Array.isArray(compiled?.errors) && compiled.errors.length) {
        return { out: { data: null, errors: compiled.errors }, own: NO_STORE, baseUrl, record: { ...record, cache: "skip", outcome: "compile-errors" } };
      }
      const model = compiled?.model;
      if (!model || typeof model.digest !== "string") return failure(`Error: stage ${stage}'s compiler returned no model`, "model-unavailable");
      const revision = typeof compiled.revision === "string" ? compiled.revision : null;
      // The stage cache is shared: never for a user testing an override, never
      // for a protected task, never without the revision that keys it, and
      // only for input that may itself be shared (not private or no-store,
      // and not expired).
      const key = stageResults && !override && !taskRequiresProtected(task) && revision
        ? stageCacheKey({
          lang,
          interpreterLang,
          modelDigest: model.digest,
          revision,
          options,
          generation: { requested: generation ?? null, producer: generations[lang] ?? null, interpreter: generations[interpreterLang] ?? null },
          mode,
          authority: authorityFor(uid),
          input: data,
        })
        : null;
      const inputSharable = sharable(upstream, now());
      // The manifest's caps for this stage, the interpreter's and the
      // producer's, as they are now: applied to every result, fresh or cached.
      const capped = claimed => combineRestrictions(
        interpretedRestrictions(claimed, interpreterLang, mode, declarations),
        interpretedRestrictions({}, lang, mode, declarations)
      );
      if (key && inputSharable && !refresh) {
        let hit;
        try {
          hit = await stageResults.get({ key });
        } catch (e) {
          console.log("ERROR reading the stage cache", e?.message);
        }
        // A cap tightened since the entry was stored applies to it, and an
        // entry it no longer lets be shared is a miss.
        const own = hit && capped({ cache: hit.cacheClass, expiresAt: hit.expiresAt });
        if (hit && sharable(own, now())) {
          return { out: hit.data, own, baseUrl, hit: true, record: { ...record, revision, cache: "hit" } };
        }
      }
      const reply = await interpreter.interpret({ lang: interpreterLang, model, input: data, mode, auth: authToken, options, uid, baseUrl });
      const own = reply?.responseLost ? NO_STORE : capped(reply);
      const out = takeEffects(withoutStageMetadata(reply), index);
      // What the entry may be kept as: the result's own terms and its input's
      // together, so it is never retained longer or shared more widely than
      // the input it was computed from. Stored only when that may be shared,
      // the result has no errors, and the revision that interpreted it is the
      // one the key names (a deploy between the two calls is a miss next time).
      const effective = combineRestrictions(upstream, own);
      const store = Boolean(key) && inputSharable && sharable(effective, now()) && !out?.errors?.length && reply?.revision === revision;
      return { out, own, baseUrl, store: store ? { key, revision, ...effective } : null, mode, record: { ...record, revision, cache: key && inputSharable && !refresh ? "miss" : "skip" } };
    };
    const obj = await tasks.reduceRight(
      // OPTIMIZATION Call getData recursively using the longest id suffix to
      // use any existing compiles.
      async (dataPromise, task, index) => {
        const data = await dataPromise;
        // Under a plan, the first failing stage stops the chain: later stages
        // never execute (spec ADMIT-03). Its effects are already reported.
        if (admitted && data?.errors?.length) return data;
        // A refused chain stops at the refusal: no later stage runs.
        if (refused) return data;
        const { lang, code } = task;
        if (isInterpreted(task)) {
          const { out, own, baseUrl, store, hit, mode, record } = await interpretStage({ task, index, data });
          // Every stage after this one sees its restrictions, combined with
          // its input's, on a cache hit as on a fresh result.
          upstream = combineRestrictions(upstream, own);
          await onStage({ ...record, own, result: upstream });
          // A declared stage's no-store result never feeds another stage
          // (design §5 rule 2): what it carries (a signature, say) must not
          // reach a compiler that could keep or pass it on. Only legacy stages
          // keep today's forwarding. An envelope with no data, only errors, is
          // forwarded as any stage's errors are.
          if (index > 0 && own.cacheClass === "no-store" && out?.data !== null && out?.data !== undefined) {
            refused = true;
            return { data: null, errors: [failedWith(`Error: stage s${index} (L${normalizeLang(lang)}) produced a result that can't be stored, so it can't feed stage s${index - 1}`, "no-store-intermediate")] };
          }
          if (hit) return out;
          const checked = await checkShape(lang, out, baseUrl);
          if (store && checked === out) {
            try {
              await stageResults.put({ key: store.key, data: out, cacheClass: store.cacheClass, expiresAt: store.expiresAt, lang: normalizeLang(lang), mode, revision: store.revision });
            } catch (e) {
              console.log("ERROR writing the stage cache", e?.message);
            }
          }
          return checked;
        }
        const pinned = admitted?.stages[index];
        // The admitted revision, else the snapshot's binding, else (null) the
        // default resolution, which consults no override.
        const stageBaseUrl = pinned?.tagUrl ?? routeFor(lang);
        let obj = await compile({
          lang,
          code,
          data,
          auth: authToken,
          options,
          connectionId,
          invocationToken: invocation?.invocationToken ?? null,
          stage: invocation ? `s${index}` : null,
          baseUrl: stageBaseUrl,
          ...(pinned ? { admissionToken: admitted.admissionToken } : {})
        });
        if (pinned) {
          const { revision, responseLost, ...rest } = obj ?? {};
          if (responseLost) {
            // No answer is not a mismatch: the stage may have acted through
            // the connection before the response was lost. If it could have
            // (its plan admits protected functions), that is reported as an
            // uncertain effect, never hidden behind a compile error.
            const mayHaveActed = pinned.requiredFunctions.length > 0;
            obj = {
              ...rest,
              data: null,
              errors: [failedWith(mayHaveActed
                ? `Error: stage ${pinned.stage}'s compiler didn't answer, so what it did through the connection is uncertain. Check before running it again: a retry with the same key replays only what was recorded`
                : `Error: stage ${pinned.stage}'s compiler didn't answer`, "compile-response-lost")],
              ...(mayHaveActed ? { effects: [{ status: "uncertain", steps: [], reason: "compile-response-lost", category: "unavailable" }] } : {}),
            };
          } else if (revision !== pinned.revision) {
            // The revision that answered must be the one the plan pins.
            obj = { ...rest, data: null, errors: [failedWith(`Error: stage ${pinned.stage} answered from another compiler revision than the plan pins`, "plan-binding-mismatch")] };
          } else {
            obj = rest;
          }
        }
        const out = takeEffects(obj, index);
        const own = legacyRestrictions(out);
        upstream = combineRestrictions(upstream, own);
        if (interpretedChain) await onStage({ stage: `s${index}`, lang: normalizeLang(lang), run: "legacy", cache: "skip", own, result: upstream });
        // Before L0176 is upgraded (plan C6), every chain where a no-store
        // stage's output feeds another stage is recorded, to confirm none
        // relies on a signed intermediate.
        if (index > 0 && own.cacheClass === "no-store") {
          console.log(`chain: a no-store stage (L${normalizeLang(lang)}, s${index}) feeds s${index - 1}`);
        }
        if (out && typeof out === "object" && out.cache === false) {
          cacheable = false;
          // Strip the directive: it is for us, and would otherwise ride along
          // into the next layer's input data and out to the client.
          const { cache, ...rest } = out;
          return checkShape(lang, rest, stageBaseUrl);
        }
        return checkShape(lang, out, stageBaseUrl);
      },
      Promise.resolve({})
    );
    if (!obj.errors?.length && typeof action === "object") {
      // If a successful compile, then log it.
      action.compiled = true;
    }
    // A successful compile through a connection leaves a private artifact for
    // later views, which serve it rather than running the program again. The
    // compile has already happened (and any write with it), so failing to
    // record it is reported beside the result (artifactNotStored), not as a
    // compile error; recovery finishes it from the invocation's receipts.
    const content = invocation && !obj.errors?.length ? unsignedContent(obj) : null;
    let notStored = null;
    if (content && carriesSignature(content)) {
      console.log("artifact not stored: the output carries a signature");
      notStored = artifactNotStored({ error: "artifact-rejected", reason: "signed-content", invocation, idempotencyKey });
    } else if (content && artifactStorer) {
      const artifact = {
        uid,
        ownerUid: invocation.ownerUid,
        connectionId,
        taskId: id,
        invocationId: invocation.invocationId,
        seq: invocation.seq,
        registryVersion: REGISTRY_VERSION,
        content
      };
      // The write is atomic, so a failed attempt leaves nothing half-stored
      // and a repeat is safe. If every attempt fails, the caller recovers by
      // retrying the invocation with the same idempotency key. A conflict is
      // permanent and not retried.
      for (let attempt = 1; attempt <= ARTIFACT_WRITE_ATTEMPTS; attempt++) {
        try {
          await artifactStorer.put(artifact);
          break;
        } catch (e) {
          if (e instanceof ArtifactConflict) {
            console.log("artifact not stored: invocation already has a different artifact", e.reason);
            notStored = artifactNotStored({ error: "artifact-rejected", reason: e.reason, invocation, idempotencyKey });
            break;
          }
          console.log(`ERROR recording artifact (attempt ${attempt})`, e?.message);
          if (attempt < ARTIFACT_WRITE_ATTEMPTS) {
            await sleep(ARTIFACT_RETRY_MS * attempt);
          } else {
            notStored = artifactNotStored({ error: "artifact-storage-unavailable", reason: "storage-failed", invocation, idempotencyKey });
          }
        }
      }
    }
    if (invocation && content) {
      await audit(notStored
        ? { event: "artifact", outcome: "failed", reason: notStored.error, category: notStored.category, invocationId: invocation.invocationId, connectionId, attemptId }
        : { event: "artifact", outcome: "succeeded", invocationId: invocation.invocationId, connectionId, attemptId });
    }
    // A chain with an interpreted stage is never held as permanent while its
    // generation isn't in its URL (plan B4): a rollback that moves the
    // generation must reach browsers and the CDN too. Otherwise, only a result
    // that is immutable with no expiry may be.
    if ((!cacheable || interpretedChain || !permanent(upstream)) && typeof action === "object") {
      // Let the route drop the immutable cache headers — an expiring compile
      // must not be held by the browser or the CDN either.
      action.noStore = true;
    }
    // A refresh writes its fresh result back; an override must not, even with
    // a refresh, since its result is specific to that user's language-server
    // revision and would pollute the shared cache for everyone else.
    if (!override && (!bypassCache || refresh) && cacheable && !interpretedChain) {
      await compileStorer.create({
        id: cacheKey,
        compile: {
          timestamp: Date.now(),
          data: obj
        },
        // Existing docs are otherwise never rewritten (only count/lastCompile
        // move), which is what made a stale verdict permanent: nothing short of
        // deleting the doc could correct it.
        overwrite: Boolean(refresh)
      });
    }
    const result = effects.length ? { ...obj, effects } : obj;
    return notStored ? { ...result, artifact: notStored } : result;
  };
};
export const buildDataApi = ({
  compile, langOverrideStorer, validateOutput, allocateInvocation, artifactStorer, publications, audit, chainAdmission = null,
  admissionWanted = _connectionId => false, getActiveGeneration = readActiveGeneration, getLanguageGenerations = readLanguageGenerations,
  interpreter = null, stageResults = null, getInterpreterLanguages = readInterpreterLanguages, declarations = INTERPRETER_DECLARATIONS,
  onStage = logStage, now = Date.now
}) => {
  return {
    get: buildGetData({ compile, langOverrideStorer, validateOutput, allocateInvocation, artifactStorer, publications, audit, chainAdmission, admissionWanted, getActiveGeneration, getLanguageGenerations, interpreter, stageResults, getInterpreterLanguages, declarations, onStage, now })
  };
};
