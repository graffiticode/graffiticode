export const buildCompile = ({ langCompile }) =>
  ({ lang, code, data = {}, auth = null, options = {}, uid = null, connectionId = null }) => {
    // connectionId rides at the top level of the compile request, where the
    // language server moves it into the invocation's ExecContext — never into
    // `options`/`config`, which programs can read and write.
    const req = connectionId ? { code, data, auth, options, connectionId } : { code, data, auth, options };
    return langCompile(`L${lang}`, req, { uid });
  };
