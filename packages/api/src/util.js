const DEBUG = process.env.GRAFFITICODE_DEBUG === "true" || false;
const assert = (function assert() {
  // If 'DEBUG' is false then 'assert' is a no-op.
  return !DEBUG
    ? () => { }
    : (val, str) => {
        if (str === undefined) {
          str = "failed!";
        }
        if (!val) {
          const err = new Error(str);
          throw err;
        }
      };
})();

export function error(val, err) {
  // If 'val' is false then report 'err'.
  if (!val) {
    throw new Error(err);
  }
}

const messages = {};
export function message(errorCode, args = []) {
  let str = messages[errorCode];
  if (args) {
    args.forEach(function (arg, i) {
      str = str.replace("%" + (i + 1), arg);
    });
  }
  return errorCode + ": " + str;
}

const reservedCodes = [];
export function reserveCodeRange(first, last, moduleName) {
  assert(first <= last, "Invalid code range");
  const noConflict = reservedCodes.every(function (range) {
    return last < range.first || first > range.last;
  });
  assert(noConflict, "Conflicting request for error code range");
  reservedCodes.push({ first, last, name: moduleName });
}

export function parseJSON(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    console.log("ERROR parsing JSON: " + JSON.stringify(str));
    console.log(e.stack);
    return null;
  }
}

export function setMetadataBuilds(data, build) {
  if (typeof data !== "object" || data === null || data instanceof Array) {
    // We got nothing to hang the metadata on.
    return;
  }
  if (!data._) {
    data._ = {};
  }
  if (!data._.builds) {
    data._.builds = [];
  }
  if (!data._.builds.some(b => build.name === b.name)) {
    data._.builds.push(build);
  }
}

export function getCompilerHost(lang, config) {
  config = config || global.config || {};
  if (config.useLocalCompiles) {
    return "localhost";
  }
  lang = lang.toLowerCase();
  lang = lang.indexOf("l") === 0 && lang || "l" + lang;
  if (config.hosts && config.hosts[lang]) {
    return config.hosts[lang];
  }
  return `${lang}.graffiticode.org`;
}

export function getCompilerPort(lang, config) {
  config = config || global.config || {};
  lang = lang.toLowerCase();
  if (config.useLocalCompiles) {
    lang = lang.indexOf("l") === 0 && lang.substring(1) || lang;
    return `5${lang}`;
  }
  lang = lang.indexOf("l") === 0 && lang || "l" + lang;
  if (config.ports && config.ports[lang]) {
    return config.ports[lang];
  }
  return "443";
}

export function getClientHost(lang, config) {
  console.log("getClientHost() global.config=" + JSON.stringify(global.config));
  console.log("getClientHost() config=" + JSON.stringify(config));
  config = config || global.config || {};
  if (config.useLocalCompiles) {
    return "localhost";
  }
  return "console.graffiticode.com";
}

export function getClientPort(lang, config) {
  config = config || global.config || {};
  if (config.useLocalCompiles) {
    return "3000";
  }
  return "443";
}

export function isNonEmptyString(str) {
  return (typeof (str) === "string" && str.length > 0);
}

export function isNonNullObject(obj) {
  return (typeof obj === "object" && obj !== null);
}

export function cleanAndTrimObj(str) {
  if (!str) {
    return str;
  }
  str = str.replace(/'/g, "''");
  str = str.replace(/\n/g, " ");
  while (str.charAt(0) === " ") {
    str = str.substring(1);
  }
  while (str.charAt(str.length - 1) === " ") {
    str = str.substring(0, str.length - 1);
  }
  return str;
}

export function cleanAndTrimSrc(str) {
  if (!str || typeof str !== "string") {
    return str;
  }
  str = str.replace(/'/g, "''");
  while (str.charAt(0) === " ") {
    str = str.substring(1);
  }
  while (str.charAt(str.length - 1) === " ") {
    str = str.substring(0, str.length - 1);
  }
  return str;
}

// From http://javascript.about.com/library/blipconvert.htm
export function dot2num(dot) {
  const d = dot.split(".");
  const n = ((((((+d[0]) * 256) + (+d[1])) * 256) + (+d[2])) * 256) + (+d[3]);
  if (isNaN(n)) {
    return 0;
  }
  return n;
}

export function num2dot(num) {
  let d = num % 256;
  for (let i = 3; i > 0; i--) {
    num = Math.floor(num / 256);
    d = num % 256 + "." + d;
  }
  return d;
}

export function statusCodeFromErrors(errs) {
  if (!Array.isArray(errs)) {
    errs = [errs];
  }
  for (const err in errs) {
    if (err.statusCode) {
      return err.statusCode;
    }
  }
  return 500;
}

export function messageFromErrors(errs) {
  if (!Array.isArray(errs)) {
    errs = [errs];
  }
  for (const err in errs) {
    if (err.data) {
      if (err.data.error) {
        return err.data.error;
      }
      return err.data;
    }
  }
  return "Internal error";
}

const INTERNAL_ERROR = {
  statusCode: 500,
  error: "Internal error"
};
export function internalError(error) {
  return Object.assign(INTERNAL_ERROR, { error });
}
