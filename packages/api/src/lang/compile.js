export const buildCompile = ({ getBaseUrlForLanguage, bent }) => async (lang, req) => {
  const baseUrl = getBaseUrlForLanguage(lang);
  try {
    const compilePost = bent(baseUrl, "POST", "json", 200, 202);
    return await compilePost("/compile", req);
  } catch (x) {
    console.log(
      "ERROR",
      x,
    );
    return null;
  }
};
