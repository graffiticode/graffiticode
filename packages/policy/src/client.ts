// A service's client for calling Policy: the gateway (api) allocating
// invocations and managing publications, and Broker asking
// authorize-execution (W2). Each call carries the caller's two Google ID
// tokens, for the Cloud Run invoker check and for Policy's caller identity,
// and the end user's token when there is one.

// Policy refused the request (HTTP 403), with its reason. api re-exports this
// same class as InvocationRefused, so one `instanceof` covers both names.
export class PolicyRefused extends Error {
  declare reason: string;
  constructor(reason: string) {
    super(`policy refused: ${reason}`);
    this.reason = reason;
  }
}

// One call to Policy. A 403 is Policy's refusal, thrown with its reason;
// any other response is returned for the caller to judge.
export const buildPolicyRequest = ({ policyUrl, idToken, fetch: doFetch = fetch }) =>
  async (method: string, path: string, { body, authToken = null }: { body?: object, authToken?: string | null } = {}) => {
    const [invoker, caller] = await Promise.all([idToken(policyUrl), idToken("urn:graffiticode:policy")]);
    const res = await doFetch(`${policyUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        "X-Serverless-Authorization": `Bearer ${invoker}`,
        "X-Caller-Identity": caller
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const json: any = await res.json().catch(() => null);
    if (res.status === 403) throw new PolicyRefused(json?.error?.reason ?? "denied");
    return { status: res.status, ok: res.ok, body: json };
  };
