import { taskRequiresProtected } from "@graffiticode/common/protected-registry";

const buildGetData = ({ compile, langOverrideStorer, validateOutput }) =>
  async ({ taskStorer, compileStorer, id, auth, authToken, options, action, refresh, connectionId = null, intentToken = null }) => {
    const tasks = await taskStorer.get({ id, auth });
    if (!tasks) {
      return { errors: [{ message: "Task not found", from: -1, to: -1 }] };
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
    const obj = await tasks.reduceRight(
      // OPTIMIZATION Call getData recursively using the longest id suffix to
      // use any existing compiles.
      async (dataPromise, task) => {
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
          intentToken
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
export const buildDataApi = ({ compile, langOverrideStorer, validateOutput }) => {
  return { get: buildGetData({ compile, langOverrideStorer, validateOutput }) };
};
