const buildGetData = ({ compile }) =>
  async ({ taskStorer, compileStorer, id, auth, authToken, options, action }) => {
    const tasks = await taskStorer.get({ id, auth });
//    console.log("getData() id=" + id);
    if (tasks) {
      // There exists a task that we are authorized to see.
      const compile = await compileStorer.get({ id, auth });
      if (compile && compile.data) {
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
//    console.log("getData() obj=" + JSON.stringify(obj, null, 2));
    return obj;
  };

export const buildDataApi = ({ compile }) => {
  return { get: buildGetData({ compile }) };
};
