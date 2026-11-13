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
// receives as `data`. Both calls have no effects (commands are B5), so a
// connection reset is retried once (lang/compile.js, retryReset).
export const buildInterpreter = ({ langCompile, callerIdentity = async _lang => null }) => {
  const post = async (lang, path, req, { uid, baseUrl }) => {
    const headers = await callerIdentity(lang);
    return langCompile(`L${lang}`, req, { uid, path, retryReset: true, ...(baseUrl ? { baseUrl } : {}), ...(headers ? { headers } : {}) });
  };
  return {
    model: ({ lang, code, auth = null, options = {}, uid = null, baseUrl = null }) =>
      post(lang, "/compile", { code, data: {}, auth, options, form: "model" }, { uid, baseUrl }),
    interpret: ({ lang, model, input, mode, auth = null, options = {}, uid = null, baseUrl = null }) =>
      post(lang, "/interpret", { model, input, mode, auth, options }, { uid, baseUrl }),
  };
};

// A command stage's start (B5 §6 step 3): POST /interpret with operation
// "start", the stage and its command session, at the stage's pinned revision.
// It may act, so it is never sent again: a lost answer comes back as
// `responseLost` (lang/compile.js), and the worker settles from receipts.
// A repair's start (B6, decision 7a) also carries the stage's recorded
// occurrences, `{ completed: { <occurrence>: { argd, result } }, blocked }`,
// which the kernel answers from their records with no call.
export const buildCommandStart = ({ langCompile, callerIdentity = async _lang => null }) =>
  async ({ lang, model, input, commandSession, stage, baseUrl, recorded = null }) => {
    const headers = await callerIdentity(lang);
    const req = { model, input, operation: "start", commandSession, stage, mode: "evaluate", ...(recorded ? { recorded } : {}) };
    return langCompile(`L${lang}`, req, { path: "/interpret", baseUrl, ...(headers ? { headers } : {}) });
  };

// A stage rebuilt from its records (B6, decision 6): POST /interpret with
// operation "materialize", the stage's admitted model, its pinned input and
// its recorded occurrences, at the stage's pinned revision. The kernel's
// replay mode acts on nothing (no session, no Policy, no Broker), so a lost
// answer is retried once like a read.
export const buildCommandMaterialize = ({ langCompile, callerIdentity = async _lang => null }) =>
  async ({ lang, model, input, recorded, baseUrl }) => {
    const headers = await callerIdentity(lang);
    const req = { model, input, operation: "materialize", recorded, mode: "evaluate" };
    return langCompile(`L${lang}`, req, { path: "/interpret", baseUrl, retryReset: true, ...(headers ? { headers } : {}) });
  };
