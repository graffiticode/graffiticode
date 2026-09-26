// Policy's client for the broker's credential-provisioning routes. Policy is
// the only caller those routes accept. The credential is in the request body
// only; nothing here logs or returns it.

// The broker refused the change as a conflict: a reused connection id, or a
// rotation that would change the owner, backend or provider account.
export class BrokerConflict extends Error {}

export const createBrokerAdminClient = ({ brokerUrl, idToken, fetch: doFetch = fetch }) => {
  const call = async (method, connectionId, body) => {
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
  return {
    createSecret: (connectionId, credential) => call("POST", connectionId, body(credential)),
    rotateSecret: (connectionId, credential) => call("PUT", connectionId, body(credential)),
    deleteSecret: connectionId => call("DELETE", connectionId)
  };
};
