// Policy's client for the broker's credential-provisioning routes. Policy is
// the only caller those routes accept. The credential is in the request body
// only; nothing here logs or returns it.

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
    if (!res.ok) {
      throw new Error(`broker ${method} secret failed (${res.status})`);
    }
  };
  return {
    putSecret: (connectionId, { key, secret }) => call("PUT", connectionId, { key, secret }),
    deleteSecret: connectionId => call("DELETE", connectionId)
  };
};
