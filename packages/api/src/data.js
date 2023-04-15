const buildGetData = ({ compile }) =>
  async ({ taskDao, id, auth, authToken, options }) => {
    const tasks = await taskDao.get({ id, auth });
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
    return obj;
  };

export const buildDataApi = ({ compile }) => {
  return { get: buildGetData({ compile }) };
};
