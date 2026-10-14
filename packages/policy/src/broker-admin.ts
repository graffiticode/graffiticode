// Policy's client for the broker's credential-provisioning routes. Policy is
// the only caller those routes accept. The credential is in the request body
// only; nothing here logs or returns it.

// The broker refused the change as a conflict: a reused connection id, or a
// rotation that would change the owner, backend or provider account.
export class BrokerConflict extends Error {}

export const createBrokerAdminClient = ({ brokerUrl, idToken, fetch: doFetch = fetch }) => {
  const call = async (method: string, connectionId: string, body?: object) => {
    const [invoker, caller] = await Promise.all([idToken(brokerUrl), idToken("urn:graffiticode:broker")]);
    const res = await doFetch(`${brokerUrl}/v1/secrets/${encodeURIComponent(connectionId)}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Serverless-Authorization": `Bearer ${invoker}`,
        "X-Caller-Identity": caller
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 409) {
      throw new BrokerConflict(`broker ${method} secret refused (409)`);
    }
    if (!res.ok) {
      throw new Error(`broker ${method} secret failed (${res.status})`);
    }
  };
  const body = ({ ownerUid, backend, key, secret }) => ({ ownerUid, backend, key, secret });
  // Reconciliation (WRITE-02, W5): Broker reads the provider for evidence about
  // one invocation's writes and appends what it found. A refusal carries
  // Broker's reason.
  const reconcile = async ({ connectionId, invocationId, decisionId }) => {
    const [invoker, caller] = await Promise.all([idToken(brokerUrl), idToken("urn:graffiticode:broker")]);
    const res = await doFetch(`${brokerUrl}/v1/reconcile`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Serverless-Authorization": `Bearer ${invoker}`, "X-Caller-Identity": caller },
      body: JSON.stringify({ connectionId, invocationId, decisionId })
    });
    let json: any = null;
    try { json = await res.json(); } catch { json = null; }
    if (res.ok && json?.status === "success") return json.data;
    const reason = typeof json?.error?.reason === "string" ? json.error.reason : null;
    throw Object.assign(new Error(`broker reconcile failed (${res.status})`), { reason, status: res.status });
  };
  return {
    reconcile,
    createSecret: (connectionId, credential) => call("POST", connectionId, body(credential)),
    rotateSecret: (connectionId, credential) => call("PUT", connectionId, body(credential)),
    deleteSecret: connectionId => call("DELETE", connectionId)
  };
};
