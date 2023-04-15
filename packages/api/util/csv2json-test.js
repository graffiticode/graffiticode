const csv2json = require("./csv2json.js");
const csv = `album, year, US_peak_chart_post
The White Stripes, 1999, -
De Stijl, 2000, -
White Blood Cells, 2001, 61
Elephant, 2003, 6
Get Behind Me Satan, 2005, 3
Icky Thump, 2007, 2
Under Great White Northern Lights, 2010, 11
Live in Mississippi, 2011, -
Live at the Gold Dollar, 2012, -
Nine Miles from the White City, 2013, -`;

const json = csv2json(csv, { parseNumbers: true });
console.log("xxx:" + JSON.stringify(json, null, 2));
