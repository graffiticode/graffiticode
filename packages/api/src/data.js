const buildGetData = ({ compile }) =>
  async ({ taskDao, compileDao, id, auth, authToken, options, action }) => {
    const tasks = await taskDao.get({ id, auth });
    if (tasks) {
      // There exists a task that we are authorized to see.
      const compile = await compileDao.get({ id, auth });
      if (compile && compile.data) {
        return JSON.parse(compile.data);
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
    // FIXME store compile here.
    compileDao.create({
      id,
      compile: {
        timestamp: Date.now(),
        data: JSON.stringify(obj)
      }
    });
    return obj;
  };

export const buildDataApi = ({ compile }) => {
  return { get: buildGetData({ compile }) };
};
