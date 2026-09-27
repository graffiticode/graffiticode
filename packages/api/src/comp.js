export const buildCompile = ({ langCompile }) =>
  ({
    lang, code, data = {}, auth = null, options = {}, uid = null,
    connectionId = null, invocationToken = null, stage = null
  }) => {
    // connectionId, invocationToken and stage ride at the top level of the
    // compile request, where the language server moves them into
    // the invocation's ExecContext — never into `options`/`config`, which
    // programs can read and write.
    const req = { code, data, auth, options };
    if (connectionId) req.connectionId = connectionId;
    if (invocationToken) req.invocationToken = invocationToken;
    if (stage) req.stage = stage;
    return langCompile(`L${lang}`, req, { uid });
  };
