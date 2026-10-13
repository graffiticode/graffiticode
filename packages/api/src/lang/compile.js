// @ts-expect-error TS-MIGRATE: checkJs infers a destructured parameter's type from its default; optional fields read as missing
// `baseUrl`, when given, is a pinned revision's URL (chain admission, W4): it
// is used as is, never resolved, so no override or redeploy can redirect it.
export const buildCompile = ({ getBaseUrlForLanguage, bent }) => async (lang, req, { uid, baseUrl: pinned = null } = {}) => {
  const baseUrl = pinned ?? await getBaseUrlForLanguage(lang, { uid });
  try {
    const compilePost = bent(baseUrl, "POST", "json", 200, 202);
    return await compilePost("/compile", req);
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
