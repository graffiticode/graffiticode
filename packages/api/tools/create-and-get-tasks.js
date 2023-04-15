import bent from "bent";
import { TASK1, TASK2 } from "../src/testing/fixture.js";
import { isNonEmptyString } from "../src/util.js";

const fixToken = token => {
  if (!isNonEmptyString(token)) {
    return null;
  }
  const parts = token.split(".");

  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  console.log(header);
  parts[0] = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");

  const body = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  console.log(body);
  body.aud = "graffiticode";
  body.iss = "https://securetoken.google.com/graffiticode";
  console.log(body);
  parts[1] = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");

  return `${parts[0]}.${parts[1]}.`;
};

// const baseUrl = "https://api.graffiticode.org";
const baseUrl = "http://localhost:3100";
const token = fixToken(process.env.AUTH_TOKEN);

const callCreateTask = bent(`${baseUrl}/task`, "POST", "json");
const callGetData = bent(`${baseUrl}/data`, "GET", "json");

const createTask = async ({ task, storageType = "firestore", token = null }) => {
  const headers = { "x-graffiticode-storage-type": storageType };
  if (isNonEmptyString(token)) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await callCreateTask("", { task }, headers);
  if (res.status !== "success") {
    throw new Error(res.error);
  }
  return res.data.id;
};

const getData = async ({ id, storageType = "firestore", token = null }) => {
  const headers = { "x-graffiticode-storage-type": storageType };
  if (isNonEmptyString(token)) {
    headers.Authorization = `Bearer: ${token}`;
  }
  const params = new URLSearchParams();
  params.append("id", id);
  const res = await callGetData(`?${params.toString()}`, null, headers);
  if (res.status !== "success") {
    throw new Error(res.error);
  }
  return res.data;
};

const run = async () => {
  const id1 = await createTask({ token, task: TASK1 });
  console.log(id1);
  const id2 = await createTask({ token, task: TASK2 });
  console.log(id2);

  const data1 = await getData({ id: id1 });
  console.log(data1);
  const data2 = await getData({ id: id2 });
  console.log(data2);
  const dataN = await getData({ id: `${id1}+${id2}` });
  console.log(dataN);
};

run().catch(err => {
  if (err.name === "StatusError") {
    console.log(err.headers);
    err.text().then(console.log);
  } else {
    console.log(err);
  }
});
