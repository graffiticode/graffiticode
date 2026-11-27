import { loggableReason, readRefusal } from "./bounded-body.js";

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
// Every call to a language service has a deadline: a request on a half-open
// pooled socket gets no reset and would otherwise wait until Cloud Run ends
// the api's request at 300 s (the B5 drive, 2026-11-05: a batch of POST
// /compile hung that way with nothing slow at the services). A read call with
// no effects (`retryReset`) gives up after 30 s and is sent again; any other
// call after 240 s, and its answer is lost (data.js decides what that means for
// the stage). The deadline aborts the request itself, body included, so
// abandoned work doesn't keep a socket (error handling proposal, PR 1c).
/** @type {Readonly<{ read: number, other: number }>} */
export const CALL_DEADLINES_MS = Object.freeze({ read: 30000, other: 240000 });
const LANG_TIMEOUT = "LANG_TIMEOUT";
// The answers a language gives: 200, or 202 for a call it accepted.
const ANSWERED = new Set([200, 202]);

// An answer with a 4xx status is a refusal the language gave: the call was
// answered, so it is not lost, and it ran nothing (language services refuse
// before executing: the caller's token, a malformed request, a preflight
// refusal). Its reason and category are kept (bounded-body.js). Any other
// failure, a 5xx included (it can follow an effect), is a lost answer.
const isRefusal = status => status >= 400 && status < 500;

// The diagnostic a refusal becomes: the reason in `code`, as the gateway's own
// diagnostics carry it (data.js failedWith), with its category and status.
const refusalEnvelope = ({ status, reason, category, message }) => ({
  errors: [{
    message: `Language server refused the call (${status}${reason ? `, ${reason}` : ""})${message ? `: ${message}` : ""}`,
    from: -1,
    to: -1,
    ...(reason ? { code: reason } : {}),
    category,
    status,
  }],
  refused: true,
});

// One line per failed call, with allowlisted fields only: never a body, its
// message, or the request.
const logFailure = (log, fields) => log(`ERROR language call ${JSON.stringify(fields)}`);

// @ts-expect-error TS-MIGRATE: checkJs infers a destructured parameter's type from its default; optional fields read as missing
export const buildCompile = ({ getBaseUrlForLanguage, fetch: doFetch = fetch, delays = RESET_RETRY_DELAYS_MS, deadlines = CALL_DEADLINES_MS, log = console.log }) => async (lang, req, { uid, baseUrl: pinned = null, headers = null, path = "/compile", retryReset = false } = {}) => {
  const baseUrl = pinned ?? await getBaseUrlForLanguage(lang, { uid });
  const deadline = retryReset ? deadlines.read : deadlines.other;
  const what = `${path} to ${lang}`;
  const send = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadline);
    try {
      const res = await doFetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...(headers ?? {}) },
        body: JSON.stringify(req),
        redirect: "manual",
        signal: controller.signal,
      });
      if (ANSWERED.has(res.status)) return await res.json();
      if (isRefusal(res.status)) {
        const refusal = await readRefusal(res);
        throw Object.assign(new Error(`${what} refused (${res.status})`), { statusCode: res.status, refusal });
      }
      await res.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`${what} answered ${res.status}`), { statusCode: res.status });
    } catch (e) {
      if (controller.signal.aborted) {
        throw Object.assign(new Error(`${what} gave no answer in ${deadline} ms`), { code: LANG_TIMEOUT });
      }
      // fetch reports a socket failure as a TypeError whose cause names it.
      if (e?.statusCode === undefined && e?.code === undefined && typeof e?.cause?.code === "string") {
        throw Object.assign(new Error(`${what} failed (${e.cause.code})`), { code: e.cause.code });
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };
  let attempt = 0;
  try {
    for (; ; attempt++) {
      try {
        return await send();
      } catch (x) {
        if (x?.code === LANG_TIMEOUT) log(`WARN ${x.message}`);
        const retryable = RESET_CODES.has(x?.code) || x?.code === LANG_TIMEOUT || x?.statusCode === 503;
        if (!retryReset || !retryable || attempt >= delays.length) throw x;
        log(`WARN ${what} ${x?.code ? `reset (${x.code})` : `answered ${x.statusCode}`}; sending it again in ${delays[attempt]} ms`);
        await pause(delays[attempt]);
      }
    }
  } catch (x) {
    const refusal = x?.refusal ?? null;
    logFailure(log, {
      lang,
      path,
      attempt,
      status: x?.statusCode ?? null,
      code: typeof x?.code === "string" ? x.code : null,
      ...(refusal ? { reason: loggableReason(refusal.reason), category: refusal.category, bytesRead: refusal.bytesRead, truncated: refusal.truncated } : {}),
    });
    if (refusal) return refusalEnvelope(refusal);
    // No usable answer: the compiler may have acted before it was lost. The
    // gateway decides what that means for the stage (data.js).
    return { errors: [{ message: `Language server error: ${x?.message ?? "no answer"}`, from: -1, to: -1 }], responseLost: true };
  }
};
