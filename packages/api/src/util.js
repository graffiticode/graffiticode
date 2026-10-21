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

export function isNonEmptyString(str) {
  return (typeof (str) === "string" && str.length > 0);
}

export function isNonNullObject(obj) {
  return (typeof obj === "object" && obj !== null);
}
