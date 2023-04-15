export const buildCompile = ({ langCompile }) =>
  ({ lang, code, data = {}, auth = null, options = {} }) => {
    return langCompile(`L${lang}`, { code, data, auth, options });
  };
