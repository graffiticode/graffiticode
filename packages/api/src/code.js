let nodePool;
let nodeMap;

function intern(n) {
  if (!n) {
    return 0;
  }
  const tag = n.tag;
  let elts = "";
  const count = n.elts.length;
  for (let i = 0; i < count; i++) {
    if (typeof n.elts[i] === "object") {
      n.elts[i] = intern(n.elts[i]);
    }
    elts += n.elts[i];
  }
  const key = tag + count + elts;
  let nid = nodeMap[key];
  if (nid === 0) {
    nodePool.push({ tag, elts: n.elts });
    nid = nodePool.length - 1;
    nodeMap[key] = nid;
    if (n.coord) {
      // ctx.state.coords[nid] = n.coord;
    }
  }
  return nid;
}

function newNode(tag, elts) {
  return { tag, elts };
};

const NULL = "NULL";
const STR = "STR";
const NUM = "NUM";
const BOOL = "BOOL";
const LIST = "LIST";
const RECORD = "RECORD";
const BINDING = "BINDING";

function objectChildToCode(data) {
  const type = typeof data;
  const tag =
    (data === null && NULL) ||
    (type === "string" && STR) ||
    (type === "number" && NUM) ||
    (type === "boolean" && BOOL) ||
    (Array.isArray(data) && LIST) ||
    (type === "object" && RECORD);
  const elts = [];
  if (tag === LIST) {
    Object.keys(data).forEach(k => {
      elts.push(intern(objectChildToCode(data[k])));
    });
  } else if (tag === RECORD) {
    Object.keys(data).forEach(k => {
      elts.push(newNode(BINDING, [
        intern(newNode(STR, [k])),
        intern(objectChildToCode(data[k]))
      ]));
    });
  } else {
    elts.push(data);
  }
  const node = newNode(tag, elts);
  return node;
}

export function objectToCode(data) {
  if (!data || Object.keys(data).length === 0) {
    return null;
  }
  nodePool = ["unused"];
  nodeMap = {};
  intern(objectChildToCode(data));
  return poolToObject();
}

function poolToObject() {
  const obj = {};
  for (let i = 1; i < nodePool.length; i++) {
    const n = nodePool[i];
    obj[i] = nodeToObject(n);
  }
  obj.root = nodePool.length - 1;
  return obj;
}

function nodeToObject(n) {
  let obj;
  if (typeof n === "object") {
    switch (n.tag) {
      case "num":
        obj = n.elts[0];
        break;
      case "str":
        obj = n.elts[0];
        break;
      default:
        obj = {};
        obj.tag = n.tag;
        obj.elts = [];
        for (let i = 0; i < n.elts.length; i++) {
          obj.elts[i] = nodeToObject(n.elts[i]);
        }
        break;
    }
  } else if (typeof n === "string") {
    obj = n;
  } else {
    obj = n;
  }
  return obj;
}
