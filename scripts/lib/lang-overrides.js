// The logic behind scripts/lang-overrides.js: per-user language-server
// bindings (packages/api/src/storage/lang-override.js), for P5's soak of a
// language's Rust service before its switch (docs/graffiticode-interpreter-plan.md).
//
//   lang-overrides/{uid} = { bindings: { "L0184": "https://l0184r-....run.app" } }
//
// The API reads a binding within 10 s and routes that user's compiles, forms
// and assets for the language to it, bypassing the shared compile cache. A
// compile through a connection is refused under an override, so a soak covers
// only paths without one.

export const COLLECTION = "lang-overrides";

// The API's key for a language: "L" and four digits.
export const bindingKey = lang => {
  const digits = String(lang ?? "").replace(/^L/i, "");
  if (!/^\d{1,4}$/.test(digits)) throw new Error(`not a language id: ${lang}`);
  return `L${digits.padStart(4, "0")}`;
};

// A soak binds a language only to its own Rust service (lNNNNr) on Cloud Run,
// over https; anything else needs --any-url, said on purpose.
export const urlProblem = (lang, url, { anyUrl = false } = {}) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return `not a URL: ${url}`;
  }
  if (parsed.protocol !== "https:") return `not https: ${url}`;
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return `a base URL has no path, query or fragment: ${url}`;
  if (anyUrl) return null;
  const service = `${bindingKey(lang).toLowerCase()}r`;
  const host = parsed.hostname;
  // A service URL (lNNNNr-<hash>-<region>.a.run.app) or a revision tag URL (<tag>---lNNNNr-...).
  const name = host.includes("---") ? host.split("---")[1] : host;
  if (!(name.startsWith(`${service}-`) && host.endsWith(".run.app"))) {
    return `${url} isn't ${service}'s Cloud Run URL; pass --any-url to bind another`;
  }
  return null;
};

// Who must never be overridden: accounts whose routing other checks rely on.
export const uidProblem = (uid, { refused = {} } = {}) => {
  if (typeof uid !== "string" || !/^[A-Za-z0-9_-]{6,128}$/.test(uid)) return `not a uid: ${uid}`;
  if (refused[uid]) return `${uid} is the ${refused[uid]}, whose routing must stay the default`;
  return null;
};

export const parse = (argv, { refused = {} } = {}) => {
  const [command, ...rest] = argv;
  const opts = { command, project: "graffiticode", plan: false, anyUrl: false, uid: null, lang: null, url: null };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--plan") opts.plan = true;
    else if (a === "--any-url") opts.anyUrl = true;
    else if (["--uid", "--lang", "--url", "--project"].includes(a)) {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = value;
    } else throw new Error(`unknown option ${a}`);
  }
  if (!["status", "set", "clear"].includes(command)) throw new Error("usage: lang-overrides.js status [--uid U] | set --uid U --lang NNNN [--url URL] [--any-url] [--plan] | clear --uid U [--lang NNNN] [--plan]");
  if (command !== "status" || opts.uid) {
    const problem = uidProblem(opts.uid, { refused });
    if (problem) throw new Error(problem);
  }
  if (command === "set" && !opts.lang) throw new Error("set needs --lang");
  if (opts.lang) opts.lang = bindingKey(opts.lang);
  return opts;
};

// The bindings after binding `key` to `url`, or after clearing `key` (or all).
export const withBinding = (bindings, key, url) => ({ ...(bindings ?? {}), [key]: url });
export const withoutBinding = (bindings, key) => {
  if (!key) return {};
  const { [key]: _gone, ...rest } = bindings ?? {};
  return rest;
};

export const readBindings = async (db, uid) => {
  const snap = await db.doc(`${COLLECTION}/${uid}`).get();
  return snap.exists ? (snap.data()?.bindings ?? {}) : {};
};

// Writes the bindings, deleting the document when none are left, so a
// cleared user is exactly a user with no override. Returns what it wrote.
export const writeBindings = async (db, uid, bindings, { plan = false } = {}) => {
  const ref = db.doc(`${COLLECTION}/${uid}`);
  const empty = Object.keys(bindings).length === 0;
  if (!plan) {
    if (empty) await ref.delete();
    else await ref.set({ bindings });
  }
  return empty ? { uid, deleted: true } : { uid, bindings };
};
