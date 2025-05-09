export const buildCompile = ({ getBaseUrlForLanguage, bent }) => async (lang, req) => {
  const baseUrl = getBaseUrlForLanguage(lang);
  const compilePost = bent(baseUrl, "POST", "json", 200, 202);
  return await compilePost("/compile", req);
};
