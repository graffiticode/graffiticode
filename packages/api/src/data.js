const buildGetData = ({ compile }) =>
    async ({ taskStorer, compileStorer, id, auth, authToken, options, action }) => {
    const tasks = await taskStorer.get({ id, auth });
    console.log("[1] getData() id=" + id);
    if (tasks) {
      // There exists a task that we are authorized to see.
      const compile = await compileStorer.get({ id, auth });
      if (compile && compile.data) {
        console.log("[2] getData() data=" + JSON.stringify(compile.data, null, 2));
        return compile.data;
      }
    }
    if (typeof action === "object") {
      action.compiled = true;
    }
    const obj = await tasks.reduceRight(
      // OPTIMIZATION Call getData recursively using the longest id suffix to
      // use any existing compiles.
      async (dataPromise, task) => {
        const data = await dataPromise;
        console.log("[3] getData() data=" + JSON.stringify(data, null, 2));
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
