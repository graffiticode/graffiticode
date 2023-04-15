export const buildCompile = ({ getBaseUrlForLanguage, bent }) => async (lang, req) => {
  const baseUrl = getBaseUrlForLanguage(lang);
  const compilePost = bent(baseUrl, "POST", "json");
  return await compilePost("/compile", req);
};
