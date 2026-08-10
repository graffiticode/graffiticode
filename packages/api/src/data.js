const buildGetData = ({ compile, langOverrideStorer }) =>
  async ({ taskStorer, compileStorer, id, auth, authToken, options, action }) => {
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
    const bypassCache = Boolean(override);
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
    let cacheable = true;
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
          uid
        });
        if (obj && typeof obj === "object" && obj.cache === false) {
          cacheable = false;
          // Strip the directive: it is for us, and would otherwise ride along
          // into the next layer's input data and out to the client.
          const { cache, ...rest } = obj;
          return rest;
        }
        return obj;
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
    if (!bypassCache && cacheable) {
      await compileStorer.create({
        id,
        compile: {
          timestamp: Date.now(),
          data: obj
        }
      });
    }
    return obj;
  };
export const buildDataApi = ({ compile, langOverrideStorer }) => {
  return { get: buildGetData({ compile, langOverrideStorer }) };
};
