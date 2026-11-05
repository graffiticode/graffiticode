// `baseUrl`, when given, is a pinned revision's URL (chain admission, W4): it
// is used as is, never resolved, so no override or redeploy can redirect it.
// `headers`, when given, ride with the compile (the api's identity, comp.js).
// `path` is the route posted to: /compile, or /interpret for an interpreted
// stage (interpreter plan B3).
// `retryReset`, for a call with no effects (an interpreted stage's model and
// read, comp.js), sends it again when the connection was reset before an
// answer: a pooled keep-alive socket the far end had just closed (ECONNRESET
// within milliseconds, seen under load on 2026-11-05). An immediate retry can
// take another stale socket from the same pool (the B5 drive saw resets
// survive one), so each retry waits first, long enough for closed sockets to
// leave the pool: RESET_RETRY_DELAYS_MS, at most two retries. A call that may
// act is never retried: its first attempt may already have.
export const RESET_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);
export const RESET_RETRY_DELAYS_MS = Object.freeze([50, 250]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// @ts-expect-error TS-MIGRATE: checkJs infers a destructured parameter's type from its default; optional fields read as missing
export const buildCompile = ({ getBaseUrlForLanguage, bent, delays = RESET_RETRY_DELAYS_MS }) => async (lang, req, { uid, baseUrl: pinned = null, headers = null, path = "/compile", retryReset = false } = {}) => {
  const baseUrl = pinned ?? await getBaseUrlForLanguage(lang, { uid });
  const send = () => {
    const compilePost = bent(baseUrl, "POST", "json", 200, 202);
    return headers ? compilePost(path, req, headers) : compilePost(path, req);
  };
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send();
      } catch (x) {
        if (!retryReset || !RESET_CODES.has(x?.code) || attempt >= delays.length) throw x;
        console.log(`WARN ${path} to ${lang} reset (${x.code}); sending it again in ${delays[attempt]} ms`);
        await pause(delays[attempt]);
      }
    }
  } catch (x) {
    console.log(
      "ERROR",
      x,
    );
    // No usable answer: the compiler may have acted before it was lost. The
    // gateway decides what that means for the stage (data.js).
    return { errors: [{ message: `Language server error: ${x.message}`, from: -1, to: -1 }], responseLost: true };
  }
};
