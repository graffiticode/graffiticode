export const buildCompile = ({ getBaseUrlForLanguage, bent }) => async (lang, req, { uid } = {}) => {
  const baseUrl = await getBaseUrlForLanguage(lang, { uid });
  try {
    const compilePost = bent(baseUrl, "POST", "json", 200, 202);
    return await compilePost("/compile", req);
  } catch (x) {
    console.log(
      "ERROR",
      x,
    );
    return { errors: [{ message: `Language server error: ${x.message}`, from: -1, to: -1 }] };
  }
};
