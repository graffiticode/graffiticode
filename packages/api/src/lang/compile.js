export const buildCompile = ({ getBaseUrlForLanguage, bent }) => async (lang, req) => {
  const baseUrl = getBaseUrlForLanguage(lang);
  const compilePost = bent(baseUrl, "POST", "json", 200, 202, 500);
  try {
    return await compilePost("/compile", req);
  } catch (err) {
    console.error('Status:', err.statusCode);       // 500
    console.error('Headers:', err.headers);         // same object you pasted
    // body helpers ↓ are *async*
    try {
      const message = await err.text();             // or err.json()
      console.error('Server said:', message);
    } catch (e) {
      console.error('Could not read body:', e);
    }
    return null;
  }
};
