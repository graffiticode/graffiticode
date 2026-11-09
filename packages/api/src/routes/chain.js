// How a request's `data` joins its task chain, the same for POST /compile and
// POST /command (C6 plan, decision 8), so one item and key give one taskId on
// both routes: absent or empty data (`{}`) adds no task; other data becomes an
// L0000 JSON-literal task appended to the chain, unless the chain already
// ends in it.

// The L0000 task a request's `data` becomes.
export const dataTask = data => ({
  lang: "0000",
  code: {
    1: {
      elts: [
        JSON.stringify(data)
      ],
      tag: "STR"
    },
    2: {
      elts: [
        1
      ],
      tag: "JSON"
    },
    root: 2
  }
});

// `postTasks`: routes/tasks.js's. Returns withData({ auth, id, data, req }) ->
// { id, appended }, where `appended` says the data task was added.
export const buildChainWithData = ({ postTasks }) => {
  let emptyId = null;
  return async ({ auth, id, data, req }) => {
    emptyId = emptyId || await postTasks({ auth, tasks: dataTask({}), req });
    const dataId = await postTasks({ auth, tasks: dataTask(data || {}), req });
    if (dataId !== emptyId && id.indexOf(dataId) < 0) return { id: [id, dataId].join("+"), appended: true };
    return { id, appended: false };
  };
};
