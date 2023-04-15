const csv2json = require("./csv2json.js");
const fs = require("graceful-fs");

fs.readFile("knewton-dump.csv", "utf-8", function (err, data) {
  const json = csv2json(data, { parseNumbers: true });
  console.log(JSON.stringify(json, null, 2));
});
