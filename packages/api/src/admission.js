// Chain admission at the gateway (capability plan W4, section F; spec
// ADMIT-01, ADMIT-02, API-01, RUN-01). For a compile through a connection on
// a marked invocation, before any stage executes:
//
//   1. ask policy for the invocation's plan (a retry pins what it pinned),
//   2. preflight every stage at its compiler: the revision serving now, or the
//      one the plan pins (its tag URL); never a user's language override,
//   3. check each manifest's source digest against the stored task,
//   4. one admission decision for the whole chain,
//
// then execute through the pinned revisions with the admission token. A
// stage the gateway can't preflight, a refusal, or Policy unavailable blocks
// the chain with zero effects.

import { buildPolicyRequest, PolicyRefused } from "@graffiticode/policy/client";

export const normalizeLang = lang => String(lang ?? "").replace(/^L/i, "").padStart(4, "0");
const languageAudience = lang => `urn:graffiticode:${normalizeLang(lang)}`;

export class PreflightUnavailable extends Error {}

// `CHAIN_ADMISSION`: off (the default), canary (only the connections named by
// CHAIN_ADMISSION_CONNECTIONS) or all. It decides whether a NEW invocation is
// allocated for admission; an invocation already marked always takes the
// admission path (policy invocations.js), whatever it says now.
export const parseChainAdmission = (env = process.env) => {
  const mode = env.CHAIN_ADMISSION || "off";
  if (!["off", "canary", "all"].includes(mode)) throw new Error(`CHAIN_ADMISSION must be off, canary or all, not ${mode}`);
  const connections = new Set((env.CHAIN_ADMISSION_CONNECTIONS ?? "").split(",").map(s => s.trim()).filter(Boolean));
  return { mode, wants: connectionId => mode === "all" || (mode === "canary" && connections.has(connectionId)) };
};

// `baseUrlFor(lang)`: the language's normal URL (env or config, never a
// user's override). `idToken(audience)`: this service's Google ID token.
export const buildChainAdmission = ({ policyUrl, idToken, baseUrlFor, fetch: doFetch = fetch }) => {
  const request = buildPolicyRequest({ policyUrl, idToken, fetch: doFetch });
  const policyData = async (path, authToken, body) => {
    const { ok, status, body: json } = await request("POST", path, { authToken, body });
    // Admission refuses with 409 (plan-mismatch, revision-retiring) and 503
    // (maintenance) as well as 403: any answer naming a reason is a refusal.
    if (!ok && typeof json?.error?.reason === "string") throw new PolicyRefused(json.error.reason);
    if (!ok || !json?.data) throw new Error(`policy ${path} failed (${status})`);
    return json.data;
  };
  return {
    baseUrlFor,
    lookupPlan: ({ authToken, invocationToken }) => policyData("/v1/invocations/plan", authToken, { invocationToken }),
    admit: ({ authToken, invocationToken, taskIds, stages }) => policyData("/v1/admissions", authToken, { invocationToken, taskIds, stages }),
    // One stage's manifest, from its compiler, as the gateway. The body is
    // the compile request's own program and (absent) config, so the compiler
    // pins the options it will actually run with.
    async preflight({ baseUrl, lang, stage, code }) {
      let res;
      try {
        res = await doFetch(`${baseUrl}/preflight`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Caller-Identity": await idToken(languageAudience(lang)) },
          body: JSON.stringify({ stage, lang: normalizeLang(lang), code }),
        });
      } catch (e) {
        throw new PreflightUnavailable(`preflight of ${stage} unreachable: ${e?.message}`);
      }
      /** @type {any} */
      const json = await res.json().catch(() => null);
      if (res.status !== 200 || json?.status !== "success" || !json.data) {
        throw new PreflightUnavailable(`preflight of ${stage} failed (${res.status}${json?.error?.reason ? `, ${json.error.reason}` : ""})`);
      }
      return json.data;
    },
  };
};

export { PolicyRefused };
