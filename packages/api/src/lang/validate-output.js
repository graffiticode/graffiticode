import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

// Checks a compile result's `data` against the schema.json its own language
// publishes. A shape the language's view cannot read is not a program error the
// checker or transformer caught — it is an uncaught compiler bug — so the
// errors are marked `internal` and ride alongside the data rather than
// replacing it: an upstream agent can still see what came out.
//
// The validator must never be the thing that breaks a compile. A language with
// no schema.json, a schema that cannot be fetched, or one ajv cannot compile is
// logged and skipped.
//
// COMPILE_SCHEMA_CHECK: "off" does nothing; "log" (the default) records
// mismatches without changing the response; "emit" also returns them. `log`
// exists because a schema that has never been checked against real output can
// be the thing that is wrong, and a view that refuses to render on any error
// would turn that into an outage.

const MODES = ["off", "log", "emit"];
const SCHEMA_TTL_MS = 5 * 60 * 1000;
const MAX_ERRORS = 5;

const DRAFT_2020 = /json-schema\.org\/draft\/2020-12/;

// A fresh ajv per schema: languages give their schemas an $id such as "L0180",
// and a shared instance refuses a second schema under an id it already holds —
// which is exactly what a redeployed language's schema is. Compiled validators
// are cached below, so this runs at most once per TTL per language.
const compileValidator = schema => {
  const Class = DRAFT_2020.test(String(schema?.$schema || "")) ? Ajv2020 : Ajv;
  return new Class({ allErrors: true, strict: false }).compile(schema);
};

export const buildValidateOutput = ({
  getBaseUrlForLanguage,
  getAsset,
  env = process.env,
  log = console.log,
  now = Date.now
}) => {
  const cache = new Map(); // `${lang} ${baseUrl}` -> { validate, expires }

  const getValidator = async (lang, { uid }) => {
    const baseUrl = await getBaseUrlForLanguage(lang, { uid });
    const key = `${lang} ${baseUrl}`;
    const cached = cache.get(key);
    if (cached && now() < cached.expires) {
      return cached.validate;
    }
    let validate = null;
    try {
      const text = await getAsset(lang, "/schema.json", { uid });
      if (text !== null && text !== undefined) {
        const schema = typeof text === "string" ? JSON.parse(text) : text;
        validate = compileValidator(schema);
      }
    } catch (err) {
      log(`WARN schema check skipped for ${lang}: ${err.message}`);
    }
    // A missing or broken schema is cached too, so a language without one is
    // not re-fetched on every compile.
    cache.set(key, { validate, expires: now() + SCHEMA_TTL_MS });
    return validate;
  };

  return async (lang, obj, { uid, id } = {}) => {
    const mode = MODES.includes(env.COMPILE_SCHEMA_CHECK) ? env.COMPILE_SCHEMA_CHECK : "log";
    if (mode === "off") {
      return [];
    }
    // The schema describes `data` inside the {data, errors} envelope, and a
    // compile that already failed has nothing well-formed to check.
    if (!obj || typeof obj !== "object" || !("data" in obj) || obj.errors?.length) {
      return [];
    }
    const name = `L${String(lang).replace(/^L/, "")}`;
    let validate;
    try {
      validate = await getValidator(name, { uid });
    } catch (err) {
      log(`WARN schema check skipped for ${name}: ${err.message}`);
      return [];
    }
    if (!validate || validate(obj.data)) {
      return [];
    }
    const errors = (validate.errors || []).slice(0, MAX_ERRORS).map(e => ({
      message: `${name} compiler output does not match its schema.json: ${e.instancePath || "(root)"} ${e.message}`,
      from: -1,
      to: -1,
      internal: true,
      kind: "schema",
      lang: name,
      path: e.instancePath || ""
    }));
    for (const e of errors) {
      log(`ERROR schema mismatch id=${id} ${e.message}`);
    }
    return mode === "emit" ? errors : [];
  };
};
