import { createHttpApp } from "@graffiticode/common/http";

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
  const db = new Map();

  const app = createHttpApp(app => {
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

  const setData = (code, data) => db.set(createKey(code), data);

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
