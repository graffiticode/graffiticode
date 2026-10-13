// Jest resolver for the TS migration (phase 3). Converted sources keep the
// .js specifiers NodeNext requires ("./app.js" for app.ts). This resolves
// exactly as Jest always has, and only when that fails tries the .ts file, so
// it changes nothing while every file is still JavaScript.
module.exports = (request, options) => {
  try {
    return options.defaultResolver(request, options);
  } catch (err) {
    if (/^\.{1,2}\/.*\.js$/.test(request)) return options.defaultResolver(request.replace(/\.js$/, ".ts"), options);
    throw err;
  }
};
