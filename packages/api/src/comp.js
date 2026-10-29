// `callerIdentity(lang)`: the identity headers a compile to this language
// carries (caller-identity.js), or null. It never fails a compile.
export const buildCompile = ({ langCompile, callerIdentity = async _lang => null }) =>
  async ({
    lang, code, data = {}, auth = null, options = {}, uid = null,
    connectionId = null, invocationToken = null, stage = null,
    // Chain admission (W4): the plan's proof, and the pinned revision's URL.
    admissionToken = null, baseUrl = null
  }) => {
    // connectionId, invocationToken and stage ride at the top level of the
    // compile request, where the language server moves them into
    // the invocation's ExecContext — never into `options`/`config`, which
    // programs can read and write.
    const req = { code, data, auth, options };
    if (connectionId) req.connectionId = connectionId;
    if (invocationToken) req.invocationToken = invocationToken;
    if (stage) req.stage = stage;
    if (admissionToken) req.admissionToken = admissionToken;
    const headers = await callerIdentity(lang);
    return langCompile(`L${lang}`, req, { uid, ...(baseUrl ? { baseUrl } : {}), ...(headers ? { headers } : {}) });
  };

// An interpreted stage's two calls to its language's service (interpreter plan
// B3), with the same token, options and identity headers a compile carries:
//   model      POST /compile { code, data: {}, form: "model" } -> { model, errors, revision }
//   interpret  POST /interpret { model, input, mode } -> the compile envelope, with revision
// `input` is the upstream stage's envelope, exactly what a legacy compile
// receives as `data`.
export const buildInterpreter = ({ langCompile, callerIdentity = async _lang => null }) => {
  const post = async (lang, path, req, { uid, baseUrl }) => {
    const headers = await callerIdentity(lang);
    return langCompile(`L${lang}`, req, { uid, path, ...(baseUrl ? { baseUrl } : {}), ...(headers ? { headers } : {}) });
  };
  return {
    model: ({ lang, code, auth = null, options = {}, uid = null, baseUrl = null }) =>
      post(lang, "/compile", { code, data: {}, auth, options, form: "model" }, { uid, baseUrl }),
    interpret: ({ lang, model, input, mode, auth = null, options = {}, uid = null, baseUrl = null }) =>
      post(lang, "/interpret", { model, input, mode, auth, options }, { uid, baseUrl }),
  };
};
