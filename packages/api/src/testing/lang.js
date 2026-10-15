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
  // Compiles received, and gates that hold the next compiles open: a held
  // compile answers with the data set when it arrived, once released.
  let calls = 0;
  const gates = [];
  // Every compile received: its headers and body.
  const received = [];

  const app = createHttpApp(app => {
    app.post("/compile", async (req, res) => {
      calls++;
      received.push({ headers: req.headers, body: req.body });
      const key = createKey(req.body.code);
      const answer = db.get(key);
      const gate = gates.shift();
      if (gate) {
        gate.arrived();
        await gate.released;
      }
      if (answer !== undefined) {
        res.status(200).json(answer);
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

  // Holds the next compile open: `arrived` resolves when it reaches the
  // server, and `release()` lets it answer.
  const hold = () => {
    const gate = {};
    const arrived = new Promise(resolve => { gate.arrived = resolve; });
    let release;
    gate.released = new Promise(resolve => { release = resolve; });
    gates.push(gate);
    return { arrived, release };
  };

  return { url, setData, cleanUp, hold, calls: () => calls, received: () => received };
};
