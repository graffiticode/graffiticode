const buildGetData = ({ compile }) =>
  async ({ taskDao, compileDao, id, auth, authToken, options }) => {
    const tasks = await taskDao.get({ id, auth });
    if (tasks) {
      // There exists a task that we are authorized to see.
      const compile = await compileDao.get({ id, auth });
      if (compile && compile.data) {
        return JSON.parse(compile.data);
      }
    }
    const obj = await tasks.reduceRight(
      async (dataPromise, task) => {
        const data = await dataPromise;
        const { lang, code } = task;
        if (+lang === 1 && !Number.isInteger(+code.root)) {
          // If lang is 1 and root is not an integer, then the code is the data.
          return code;
        } else {
          const obj = await compile({
            lang,
            code,
            data,
            auth: authToken,
            options
          });
          return obj;
        }
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
