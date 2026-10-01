// api's src/app.js loads config/config.json (or $CONFIG) into global.config,
// which src/util.js and src/config/config.js read.
declare global {
  // eslint-disable-next-line no-var
  var config: Record<string, any>;
}
export {};
