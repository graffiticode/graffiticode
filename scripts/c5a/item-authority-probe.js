// C5a Step 27: a one-off, read-only probe of the console's item-authority
// route as Policy's own account (docs/capability-policy-iam-review.md, Step 27,
// verification step 1). Run as a Cloud Run job whose service account is
// policy-run; it takes ID tokens from the metadata server and calls the route:
//
//   known      the canary's item, with a token for the route's audience
//              (expect 200 { exists: true, ownerUid, isPublic, taskId, lang })
//   unknown    an id no one holds, same token (expect 200 { exists: false })
//   wrong-aud  the known item, with a token for another audience (expect 403)
//
// Every answer must be Cache-Control: no-store. It prints one line,
// `C5A-ITEM-AUTHORITY-PROBE <json>`, with each call's status, cache-control
// and answer fields, and the token's verified email and audience. It never
// prints a token. Plain Node 22, no dependencies, CommonJS so it can run
// with `node -e`.
//
//   PROBE_URL       the route as Policy calls it (ITEM_AUTHORITY_URL)
//   PROBE_AUDIENCE  the route's audience (ITEM_AUTHORITY_AUDIENCE)
//   PROBE_ITEM      a known item id
//   PROBE_WRONG_AUDIENCE  another audience (default: PROBE_URL)

const METADATA = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity";

const claimsOf = token => {
  const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  return { email: payload.email ?? null, emailVerified: payload.email_verified ?? null, aud: payload.aud ?? null, iss: payload.iss ?? null };
};

const idToken = async audience => {
  const res = await fetch(`${METADATA}?audience=${encodeURIComponent(audience)}&format=full`, { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error(`metadata identity answered ${res.status}`);
  return (await res.text()).trim();
};

const ANSWER_FIELDS = ["exists", "ambiguous", "ownerUid", "isPublic", "taskId", "lang", "error"];

const call = async ({ url, token, itemId }) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ itemId }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const answer = body?.data ?? body;
  const fields = answer && typeof answer === "object" ? Object.fromEntries(ANSWER_FIELDS.filter(k => k in answer).map(k => [k, answer[k]])) : null;
  return { status: res.status, cacheControl: res.headers.get("cache-control"), answer: fields };
};

const main = async () => {
  const url = process.env.PROBE_URL;
  const audience = process.env.PROBE_AUDIENCE;
  const item = process.env.PROBE_ITEM;
  const wrongAudience = process.env.PROBE_WRONG_AUDIENCE || url;
  if (!url || !audience || !item) throw new Error("PROBE_URL, PROBE_AUDIENCE and PROBE_ITEM are required");
  if (wrongAudience === audience) throw new Error("the wrong audience must differ from the route's");
  const unknown = `c5a-probe-unknown-${Date.now().toString(36)}`;
  const token = await idToken(audience);
  const wrong = await idToken(wrongAudience);
  const out = {
    at: new Date().toISOString(),
    execution: process.env.CLOUD_RUN_EXECUTION ?? null,
    url,
    audience,
    caller: claimsOf(token),
    wrongCaller: claimsOf(wrong),
    known: { itemId: item, ...(await call({ url, token, itemId: item })) },
    unknown: { itemId: unknown, ...(await call({ url, token, itemId: unknown })) },
    wrongAudience: { itemId: item, audience: wrongAudience, ...(await call({ url, token: wrong, itemId: item })) },
  };
  const expect = {
    known: out.known.status === 200 && out.known.answer?.exists === true && typeof out.known.answer?.ownerUid === "string",
    unknown: out.unknown.status === 200 && out.unknown.answer?.exists === false,
    wrongAudience: out.wrongAudience.status === 403,
    noStore: [out.known, out.unknown, out.wrongAudience].every(c => /no-store/.test(c.cacheControl ?? "")),
  };
  out.checks = expect;
  out.passed = Object.values(expect).every(Boolean);
  console.log(`C5A-ITEM-AUTHORITY-PROBE ${JSON.stringify(out)}`);
  if (!out.passed) process.exitCode = 1;
};

main().catch(e => {
  console.log(`C5A-ITEM-AUTHORITY-PROBE ${JSON.stringify({ error: String(e?.message ?? e) })}`);
  process.exitCode = 1;
});
