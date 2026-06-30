export const buildCompile = ({ langCompile }) =>
  ({ lang, code, data = {}, auth = null, options = {}, uid = null }) => {
    return langCompile(`L${lang}`, { code, data, auth, options }, { uid });
  };
