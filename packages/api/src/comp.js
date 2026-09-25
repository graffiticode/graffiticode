export const buildCompile = ({ langCompile }) =>
  ({ lang, code, data = {}, auth = null, options = {}, uid = null, connectionId = null, intentToken = null }) => {
    // connectionId and intentToken ride at the top level of the compile
    // request, where the language server moves them into the invocation's
    // ExecContext — never into `options`/`config`, which programs can read and
    // write.
    const req = { code, data, auth, options };
    if (connectionId) req.connectionId = connectionId;
    if (intentToken) req.intentToken = intentToken;
    return langCompile(`L${lang}`, req, { uid });
  };
