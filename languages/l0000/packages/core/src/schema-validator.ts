// SPDX-License-Identifier: MIT
//
// Schema fetching and runtime validation for the `data use "<lang>"` form.
//
// At compile time the basis USE visitor calls `getLanguageSchema(lang)` to
// resolve the upstream's published `schema.json` over HTTP, and the DATA
// visitor calls `validateAgainstSchema(value, schema)` to type-check the
// chained upstream value before merging it into the head's result.

import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

// The default ajv class reads draft-07 only; L0175, L0180 and L0182 publish
// draft 2020-12 schemas, which it refuses outright. Pick by `$schema`.
const ajv07 = new (Ajv as any)({ allErrors: true, strict: false });
const ajv2020 = new (Ajv2020 as any)({ allErrors: true, strict: false });
const DRAFT_2020 = /json-schema\.org\/draft\/2020-12/;
const ajvFor = (schema) =>
  DRAFT_2020.test(String(schema?.$schema || "")) ? ajv2020 : ajv07;
const compiled = new Map();

function fingerprint(schema) {
  if (schema && typeof schema === "object" && typeof schema.$id === "string") {
    return schema.$id;
  }
  try {
    return JSON.stringify(schema);
  } catch (_) {
    return null;
  }
}

export function validateAgainstSchema(value, schema) {
  const key = fingerprint(schema);
  let validate = key && compiled.get(key);
  if (!validate) {
    validate = ajvFor(schema).compile(schema);
    if (key) compiled.set(key, validate);
  }
  if (validate(value)) return [];
  const title = schema?.title || schema?.$id || "schema";
  return (validate.errors || []).map((e) => ({
    message: `upstream data does not match ${title}: ${e.instancePath || "(root)"} ${e.message}`,
    from: -1,
    to: -1,
  }));
}

// ---------------------------------------------------------------------------
// Schema fetching
// ---------------------------------------------------------------------------

const SCHEMA_FETCH_TTL_MS = 60 * 60 * 1000; // 1 hour
const schemaFetchCache = new Map(); // lang -> { value, expires }

// Allow tests (and future use cases) to swap the underlying fetcher.
let _fetchImpl = (typeof fetch === "function") ? fetch : null;
export function setSchemaFetcher(fn) {
  _fetchImpl = fn;
}

function apiBaseUrl() {
  return process.env.GRAFFITICODE_API_URL || "https://api.graffiticode.org";
}

export function clearSchemaCache() {
  schemaFetchCache.clear();
}

// Fetches L<lang>/schema.json from the configured api server. Caches successful
// fetches with TTL. Throws on non-2xx or invalid JSON — the caller (USE) maps
// this into a compile error.
export async function getLanguageSchema(lang) {
  const cached = schemaFetchCache.get(lang);
  if (cached && Date.now() < cached.expires) {
    return cached.value;
  }
  if (!_fetchImpl) {
    throw new Error("no fetch implementation available (node 18+ or setSchemaFetcher)");
  }
  const url = `${apiBaseUrl()}/L${lang}/schema.json`;
  let res;
  try {
    res = await _fetchImpl(url);
  } catch (err) {
    throw new Error(`network error fetching ${url}: ${err.message}`, { cause: err });
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  let schema;
  try {
    schema = await res.json();
  } catch (err) {
    throw new Error(`invalid JSON at ${url}: ${err.message}`, { cause: err });
  }
  schemaFetchCache.set(lang, { value: schema, expires: Date.now() + SCHEMA_FETCH_TTL_MS });
  return schema;
}
