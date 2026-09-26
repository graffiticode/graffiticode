import { taskRequiresProtected, REGISTRY_VERSION } from "@graffiticode/common/protected-registry";
import { InvocationRefused } from "./invocations.js";
import { buildReadArtifact } from "./read.js";

const ARTIFACT_WRITE_ATTEMPTS = 3;
const ARTIFACT_RETRY_MS = 100;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

const buildGetData = ({ compile, langOverrideStorer, validateOutput, allocateInvocation = null, artifactStorer = null }) => {
  const readArtifact = buildReadArtifact({ compile, artifactStorer, allocateInvocation });
  return async ({
    taskStorer, compileStorer, id, auth, authToken, options, action, refresh,
    connectionId = null, intentToken = null, idempotencyKey = null, read = false
  }) => {
    const tasks = await taskStorer.get({ id, auth });
    if (!tasks) {
      return { errors: [{ message: "Task not found", from: -1, to: -1 }] };
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
    const override = uid && langOverrideStorer
      ? await langOverrideStorer.get({ uid })
      : undefined;
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
    const bypassCache =
      Boolean(override) || Boolean(refresh) || Boolean(connectionId) || requiresProtected;
    // There exists a task that we are authorized to see.
    if (!bypassCache) {
      const cached = await compileStorer.get({ id, auth });
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
    const checkShape = async (lang, obj) => {
      if (typeof validateOutput !== "function") {
        return obj;
      }
      const schemaErrors = await validateOutput(lang, obj, { uid, id });
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
    let invocation = null;
    if (connectionId) {
      if (!allocateInvocation) {
        return { errors: [{ message: "Error: connections are not available on this server.", from: -1, to: -1 }] };
      }
      try {
        invocation = await allocateInvocation({ authToken, connectionId, taskId: id, options, idempotencyKey });
      } catch (e) {
        const message = e instanceof InvocationRefused
          ? `Error: permission denied (${e.reason})`
          : "Error: could not start a compile through this connection";
        return { errors: [{ message, from: -1, to: -1 }] };
      }
    }
    const obj = await tasks.reduceRight(
      // OPTIMIZATION Call getData recursively using the longest id suffix to
      // use any existing compiles.
      async (dataPromise, task, index) => {
        const data = await dataPromise;
        const { lang, code } = task;
        const obj = await compile({
          lang,
          code,
          data,
          auth: authToken,
          options,
          uid,
          connectionId,
          intentToken,
          invocationToken: invocation?.invocationToken ?? null,
          stage: invocation ? `s${index}` : null
        });
        if (obj && typeof obj === "object" && obj.cache === false) {
          cacheable = false;
          // Strip the directive: it is for us, and would otherwise ride along
          // into the next layer's input data and out to the client.
          const { cache, ...rest } = obj;
          return checkShape(lang, rest);
        }
        return checkShape(lang, obj);
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
    // record it is logged, not returned as a compile error; recovery finishes
    // it from the invocation's receipts.
    const content = invocation && !obj.errors?.length ? unsignedContent(obj) : null;
    if (content && carriesSignature(content)) {
      console.log("artifact not stored: the output carries a signature");
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
      // retrying the invocation with the same idempotency key.
      for (let attempt = 1; attempt <= ARTIFACT_WRITE_ATTEMPTS; attempt++) {
        try {
          await artifactStorer.put(artifact);
          break;
        } catch (e) {
          console.log(`ERROR recording artifact (attempt ${attempt})`, e?.message);
          if (attempt < ARTIFACT_WRITE_ATTEMPTS) await sleep(ARTIFACT_RETRY_MS * attempt);
        }
      }
    }
    if (!cacheable && typeof action === "object") {
      // Let the route drop the immutable cache headers — an expiring compile
      // must not be held by the browser or the CDN either.
      action.noStore = true;
    }
    // A refresh writes its fresh result back; an override must not, since its
    // result is specific to that user's language-server revision and would
    // pollute the shared cache for everyone else.
    if ((!bypassCache || refresh) && cacheable) {
      await compileStorer.create({
        id,
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
    return obj;
  };
};
export const buildDataApi = ({ compile, langOverrideStorer, validateOutput, allocateInvocation, artifactStorer }) => {
  return { get: buildGetData({ compile, langOverrideStorer, validateOutput, allocateInvocation, artifactStorer }) };
};
