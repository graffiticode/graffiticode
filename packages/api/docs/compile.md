### POST /compile [{id, data, ...}, ...]

Compiles are idempotent. That is, the same response object will always be
returned for the same body given in the response.

const composeResponse = ({ item, data }) => {
  delete item.data;
  return { data: Object.assign(item, data) };
};

const getTaskFromData = data => ({
  lang: "0001",
  code: {
    1: { elts: [JSON.stringify(data)], tag: "STR" },
    2: { elts: [1], tag: "JSON" },
    root: 2
  }
});

const items = getItemsFromRequest(req);
const auth = getAuthFromRequest(req);
const data = await Promise.all(items.map(async item => {
  const { id, data } = item;
  const dataId = postTask({ auth, task: getTaskFromData(data) });
  const taskId = [taskId, dataId].join("+");
  return composeResponse({ item, data: await getData({ auth, taskId }) });
}));
