// The api's identity on the compiles it sends (plan: system preview signing
// rate limits, design point 1). Every compile to L0176 carries
// `X-Caller-Identity: <Google ID token>`, audience `urn:graffiticode:0176`,
// minted for the api's runtime identity exactly as preflight's are
// (admission.js, invocations.js buildMetadataIdToken). L0176 signs on the
// system path only for a verified api identity, so the per-client limit at
// the api can't be stepped around by calling L0176 directly.
//
// Only the languages that check it get it. Fail-safe: if minting fails or
// stalls, the compile goes without it (L0176 then treats it as a direct
// caller and answers unsigned), and it's logged; no compile is ever blocked.
import { normalizeLang } from "./admission.js";

export const CALLER_IDENTITY_HEADER = "X-Caller-Identity";
export const CALLER_IDENTITY_LANGS = Object.freeze(["0176"]);

const withTimeout = (promise, ms) => {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no token within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

// `idToken(audience)`: this service's Google ID token, or null when it has
// none (local runs). Resolves to the headers to add, or null.
export const buildCallerIdentity = ({ idToken = null, langs = CALLER_IDENTITY_LANGS, timeoutMs = 2000, log = console.log } = {}) =>
  async lang => {
    const l = normalizeLang(lang);
    if (!langs.includes(l)) return null;
    if (!idToken) return null;
    try {
      const token = await withTimeout(Promise.resolve().then(() => idToken(`urn:graffiticode:${l}`)), timeoutMs);
      if (typeof token !== "string" || !token) throw new Error("empty token");
      return { [CALLER_IDENTITY_HEADER]: token };
    } catch (e) {
      log(`ERROR caller identity for L${l} not minted; compiling without it: ${e?.message}`);
      return null;
    }
  };
