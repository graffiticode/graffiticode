import { createHttpApp } from "@graffiticode/common/http";

const DEFAULT_LEXICON = {
  hello: { tk: 1, name: "HELLO", cls: "function", length: 1 },
  val: { tk: 1, name: "VAL", cls: "function", length: 2, arity: 2 },
  key: { tk: 1, name: "KEY", cls: "function", length: 2, arity: 2 },
  len: { tk: 1, name: "LEN", cls: "function", length: 1, arity: 1 },
  concat: { tk: 1, name: "CONCAT", cls: "function", length: 1, arity: 1 },
  add: { tk: 1, name: "ADD", cls: "function", length: 2, arity: 2 },
  mul: { tk: 1, name: "MUL", cls: "function", length: 2, arity: 2 },
  pow: { tk: 1, name: "POW", cls: "function", length: 2, arity: 2 },
  style: { tk: 1, name: "STYLE", cls: "function", length: 2, arity: 2 },
  map: { tk: 1, name: "MAP", cls: "function", length: 2, arity: 2 },
  apply: { tk: 1, name: "APPLY", cls: "function", length: 2, arity: 2 },
  in: { tk: 1, name: "IN", cls: "function", length: 0, arity: 0 },
  arg: { tk: 1, name: "ARG", cls: "function", length: 1, arity: 1 },
  data: { tk: 1, name: "DATA", cls: "function", length: 1, arity: 1 }
};

const listen = app => {
  return new Promise(resolve => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
};

const createKey = code => {
  if (Array.isArray(code)) {
    return `[${code.map(createKey).join(",")}]`;
  }
  if (code === null) {
    return "null";
  }
  const type = typeof code;
  if (["boolean", "number"].includes(type)) {
    return `${code}`;
  }
  if (type === "string") {
    return `"${code}"`;
  }
  if (type === "object") {
    return `{${Object.keys(code).sort().map(k => `${k}:${createKey(code[k])}`).join(",")}}`;
  }
  return JSON.stringify(code, Object.keys(code).sort());
};

export const startLangApp = async () => {
  const lexicon = DEFAULT_LEXICON;
  const db = new Map();

  const app = createHttpApp(app => {
    app.get("/lexicon.js", (req, res) => res.status(200).send(JSON.stringify(lexicon)));
    app.post("/compile", (req, res) => {
      const key = createKey(req.body.code);
      if (db.has(key)) {
        res.status(200).json(db.get(key));
      } else {
        console.log(key);
        res.sendStatus(404);
      }
    });
  });
  const server = await listen(app);
  const { address, port } = server.address();
  const url = `http://${address}:${port}`;

  const setData = (code, data) => (
    db.set(createKey(code), data)
  );

  const cleanUp = async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  };

  return { url, setData, cleanUp };
};
