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
// leave the pool: RESET_RETRY_DELAYS_MS, at most two retries. A 503 is retried
// the same way: a language service answers it when the auth service couldn't
// judge the caller's token (the kernel's CachingVerifier), which says nothing
// about the token. A call that may act is never retried: its first attempt may
// already have.
export const RESET_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);
export const RESET_RETRY_DELAYS_MS = Object.freeze([50, 250]);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Every call to a language service has a deadline (bent has none): a request on
// a half-open pooled socket gets no reset and would otherwise wait until Cloud
// Run ends the api's request at 300 s (the B5 drive, 2026-11-05: a batch of
// POST /compile hung that way with nothing slow at the services). A read call
// with no effects (`retryReset`) gives up after 30 s and is sent again; any
// other call after 240 s, and its answer is lost (data.js decides what that
// means for the stage).
export const CALL_DEADLINES_MS = Object.freeze({ read: 30000, other: 240000 });
const LANG_TIMEOUT = "LANG_TIMEOUT";
const withDeadline = (promise, ms, what) => {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${what} gave no answer in ${ms} ms`), { code: LANG_TIMEOUT })), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
};
// @ts-expect-error TS-MIGRATE: checkJs infers a destructured parameter's type from its default; optional fields read as missing
export const buildCompile = ({ getBaseUrlForLanguage, bent, delays = RESET_RETRY_DELAYS_MS, deadlines = CALL_DEADLINES_MS }) => async (lang, req, { uid, baseUrl: pinned = null, headers = null, path = "/compile", retryReset = false } = {}) => {
  const baseUrl = pinned ?? await getBaseUrlForLanguage(lang, { uid });
  const deadline = retryReset ? deadlines.read : deadlines.other;
  const send = () => {
    const compilePost = bent(baseUrl, "POST", "json", 200, 202);
    return withDeadline(headers ? compilePost(path, req, headers) : compilePost(path, req), deadline, `${path} to ${lang}`);
  };
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await send();
      } catch (x) {
        if (x?.code === LANG_TIMEOUT) console.log(`WARN ${x.message}`);
        const retryable = RESET_CODES.has(x?.code) || x?.code === LANG_TIMEOUT || x?.statusCode === 503;
        if (!retryReset || !retryable || attempt >= delays.length) throw x;
        console.log(`WARN ${path} to ${lang} ${x?.code ? `reset (${x.code})` : `answered ${x.statusCode}`}; sending it again in ${delays[attempt]} ms`);
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
