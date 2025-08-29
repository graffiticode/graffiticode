const buildGetData = ({ compile }) =>
  async ({ taskStorer, compileStorer, id, auth, authToken, options, action }) => {
    const tasks = await taskStorer.get({ id, auth });
    if (tasks) {
      // There exists a task that we are authorized to see.
      const compile = await compileStorer.get({ id, auth });
      if (compile && compile.data) {
        return compile.data;
      }
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
