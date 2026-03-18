const buildGetData = ({ compile }) =>
  async ({ taskStorer, compileStorer, id, auth, authToken, options, action }) => {
    const tasks = await taskStorer.get({ id, auth });
    if (!tasks) {
      return { errors: [{ message: "Task not found", from: -1, to: -1 }] };
    }
    // There exists a task that we are authorized to see.
    const cached = await compileStorer.get({ id, auth });
    if (cached && cached.data) {
      return cached.data;
    }
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
          options
        });
        return obj;
      },
      Promise.resolve({})
    );
    if (!obj.errors?.length && typeof action === "object") {
      // If a successful compile, then log it.
      action.compiled = true;
    }
    await compileStorer.create({
      id,
      compile: {
        timestamp: Date.now(),
        data: obj
      }
    });
    return obj;
  };
export const buildDataApi = ({ compile }) => {
  return { get: buildGetData({ compile }) };
};
