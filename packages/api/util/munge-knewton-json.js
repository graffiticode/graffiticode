const fs = require("graceful-fs");

fs.readFile("knewton.json", "utf-8", function (err, data) {
//  console.log(data);
  const json = JSON.parse(data);
  const out = [];
  json.forEach(r => {
    const params = JSON.parse(r["Atoms Learnosity Params"]);
    const question = JSON.parse(r["Atoms Question"])[0];
    //    console.log(params);
    if (params.validation &&
        params.validation.valid_response &&
        params.validation.valid_response.value &&
        params.validation.valid_response.value[0]) {
      // let val = {
      //   itemID: r["Atoms Atom ID"],
      //   typeID: "KNWT." + r["Atoms Learning Objective ID"],
      //   validation: {
      //     method: params.validation.valid_response.value[0].method,
      //     options: params.validation.valid_response.value[0].options,
      //     value: params.validation.valid_response.value[0].value,
      //   },
      //   question: question.value,
      // };
      // out.push({
      //   id: "xV6f9oM2to",
      //   data: val,
      // })
      out.push(params.validation.valid_response.value[0].value);
    }
  });
  console.log(JSON.stringify(out));
});
