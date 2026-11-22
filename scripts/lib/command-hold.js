// The rules behind scripts/command-hold.js (C5d, docs/c5d-refusal-and-hold-plan.md
// decisions 6, 9 and 11), with the credential, token-info, gcloud, the file
// system and the hold store injected, so every refusal is tested offline
// (scripts/test/command-hold.test.js). See the entry point for usage.
//
// An act runs in this order, and stops at the first refusal:
//   1. its request: a new act's from the options, or a retry's from its
//      intent file (`--intent`), which fixes the act exactly;
//   2. the operator's identity, before any Firestore call: the access token
//      of the one application-default credential the Firestore client uses,
//      asked of Google's token-info endpoint (the token goes only there and is
//      never logged or written). Every field the email scope gives must be
//      there: `email`, `email_verified` true, and `azp`, with `expires_in` of
//      at least 60 s. The email must be a user's, not a service account's,
//      and equal `--operator`, the intent's operator and the gcloud account;
//   3. a new act's intent file, written once, before the first send;
//   4. the act, in one Policy transaction (@graffiticode/policy/holds), whose
//      `appliedBy` is the verified identity. A retry of a committed act
//      answers `replayed: true` and writes nothing.

import { randomUUID as uuid } from "node:crypto";
import { join } from "node:path";

export const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
export const MIN_TOKEN_SECONDS = 60;
// Where intent files go (the owner's decision on #464): one per act, by its id.
export const DEFAULT_INTENT_DIR = "docs/evidence/command-holds";
// C5d's acts keep C5d's evidence location (the plan, §5 and §9).
export const C5D_INTENT_DIR = "docs/evidence/c5d/hold";
export const INTENT_SCHEMA = 1;

const COMMAND_ID = /^c:[a-f0-9]{64}$/;
const ACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9-]{1,64}$/;
const EMAIL = /^[^\s@]{1,200}@[^\s@]{1,120}$/;
const NOTE_MAX = 500;
const ACTS = ["apply", "lift"];

export const USAGE = [
  "usage: command-hold.js status <commandId>",
  "       command-hold.js apply <commandId> --reason <slug> --note <text> --decision <ref> --operator <email> [--decided-by <name>] [--intent-dir <dir>]",
  "       command-hold.js lift <commandId> --lifts <actId> --reason <slug> --note <text> --decision <ref> --operator <email> [--decided-by <name>] [--intent-dir <dir>]",
  "       command-hold.js apply|lift [<commandId>] --intent <file> --operator <email>     (a retry: the file fixes the act)",
  "       [--project <id>] (default graffiticode)",
].join("\n");

// An operator's refusal: `reason` names it; the message never carries a token.
export class HoldRefused extends Error {
  constructor(reason, message = reason) {
    super(message);
    this.reason = reason;
  }
}

const OPTIONS = { "--reason": "reason", "--note": "note", "--decision": "decision", "--operator": "operator", "--lifts": "lifts", "--intent": "intent", "--intent-dir": "intentDir", "--project": "project", "--decided-by": "decidedBy" };
// What an intent file fixes, so a retry may not also give it.
const ACT_OPTIONS = ["reason", "note", "decision", "lifts", "decidedBy", "intentDir"];

export const parse = argv => {
  const [command, ...rest] = argv;
  if (!["status", ...ACTS].includes(command)) throw new HoldRefused("usage", USAGE);
  const opts = { command, commandId: null, reason: null, note: null, decision: null, operator: null, lifts: null, intent: null, intentDir: null, project: "graffiticode", decidedBy: null };
  let i = 0;
  if (rest[0] !== undefined && !rest[0].startsWith("--")) opts.commandId = rest[i++];
  for (; i < rest.length; i++) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!OPTIONS[key] || value === undefined) throw new HoldRefused("usage", `unknown or incomplete option ${key}\n${USAGE}`);
    if (opts[OPTIONS[key]] !== null && OPTIONS[key] !== "project") throw new HoldRefused("usage", `${key} given twice`);
    opts[OPTIONS[key]] = value;
    i++;
  }
  if (opts.commandId !== null && !COMMAND_ID.test(opts.commandId)) throw new HoldRefused("usage", "the command id is c: and 64 hex digits");
  if (command === "status") {
    if (!opts.commandId) throw new HoldRefused("usage", USAGE);
    return opts;
  }
  if (!opts.operator || !EMAIL.test(opts.operator)) throw new HoldRefused("usage", "--operator <email> is required");
  if (opts.intent !== null) {
    const extra = ACT_OPTIONS.filter(k => opts[k] !== null);
    if (extra.length) throw new HoldRefused("usage", `a retry's act is its intent file's: drop ${extra.join(", ")}`);
    return opts;
  }
  if (!opts.commandId) throw new HoldRefused("usage", USAGE);
  if (!opts.reason || !SLUG.test(opts.reason)) throw new HoldRefused("usage", "--reason is a slug: a-z, 0-9 and -, at most 64");
  if (opts.note === null || opts.note.length > NOTE_MAX) throw new HoldRefused("usage", `--note is required, at most ${NOTE_MAX} characters`);
  if (!opts.decision || !opts.decision.trim()) throw new HoldRefused("usage", "--decision <ref> names the owner's decision");
  if (command === "lift" ? !opts.lifts || !ACT_ID.test(opts.lifts) : opts.lifts !== null) {
    throw new HoldRefused("usage", command === "lift" ? "lift requires --lifts <actId>, the current hold's act id" : "--lifts is for lift only");
  }
  return opts;
};

// A new act's complete request, with its id generated once.
export const newIntent = (opts, { randomUUID = uuid, now = () => Date.now() } = {}) => ({
  schema: INTENT_SCHEMA,
  actId: randomUUID(),
  commandId: opts.commandId,
  act: opts.command,
  reason: opts.reason,
  note: opts.note,
  decision: opts.decision,
  decidedBy: opts.decidedBy ?? "owner",
  lifts: opts.command === "lift" ? opts.lifts : null,
  operator: opts.operator,
  createdAt: new Date(now()).toISOString(),
});

const intentProblem = intent => {
  if (!intent || typeof intent !== "object" || intent.schema !== INTENT_SCHEMA) return "not an intent file";
  if (!ACT_ID.test(intent.actId ?? "") || !COMMAND_ID.test(intent.commandId ?? "") || !ACTS.includes(intent.act)) return "its act id, command or act is malformed";
  if (!SLUG.test(intent.reason ?? "") || typeof intent.note !== "string" || intent.note.length > NOTE_MAX) return "its reason or note is malformed";
  if (typeof intent.decision !== "string" || !intent.decision.trim() || typeof intent.decidedBy !== "string" || !intent.decidedBy.trim()) return "its decision is malformed";
  if (intent.act === "lift" ? !ACT_ID.test(intent.lifts ?? "") : intent.lifts !== null) return "its lift target is malformed";
  if (!EMAIL.test(intent.operator ?? "")) return "its operator is malformed";
  return null;
};

export const intentPathFor = (root, intentDir, actId) => join(root, intentDir ?? DEFAULT_INTENT_DIR, `${actId}.intent.json`);

// Write-once: an intent file is never overwritten.
export const writeIntentOnce = async ({ fs, path, intent }) => {
  await fs.mkdir(join(path, ".."), { recursive: true });
  try {
    await fs.writeFile(path, `${JSON.stringify(intent, null, 2)}\n`, { flag: "wx" });
  } catch (e) {
    if (e?.code === "EEXIST") throw new HoldRefused("intent-exists", `${path} exists: an intent file is written once; retry with --intent`);
    throw e;
  }
};

export const readIntent = async ({ fs, path }) => {
  let intent;
  try {
    intent = JSON.parse(await fs.readFile(path, "utf8"));
  } catch (e) {
    throw new HoldRefused("intent-unreadable", `can't read the intent file ${path}: ${e?.code ?? e?.name ?? "error"}`);
  }
  const problem = intentProblem(intent);
  if (problem) throw new HoldRefused("intent-invalid", `${path}: ${problem}`);
  return intent;
};

const same = (a, b) => typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();

// Google's answer about the access token. POSTed, so the token is in no URL.
// -> the parsed answer   throws HoldRefused("tokeninfo-failed")
export const fetchTokenInfo = async ({ fetch, accessToken }) => {
  let res;
  try {
    res = await fetch(TOKENINFO_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ access_token: accessToken }).toString() });
  } catch (e) {
    throw new HoldRefused("tokeninfo-failed", `token-info could not be asked (${e?.name ?? "error"})`);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok || !body || typeof body !== "object" || body.error !== undefined || body.error_description !== undefined) {
    throw new HoldRefused("tokeninfo-failed", `token-info refused the token (HTTP ${res.status})`);
  }
  return body;
};

// The operator, as token-info answered for the token. Fails closed: any
// field missing, or any mismatch, refuses.
// -> appliedBy { email, verifiedVia: "tokeninfo", azp }
export const verifyIdentity = ({ tokenInfo, operator, intentOperator, gcloudAccount }) => {
  for (const field of ["email", "email_verified", "azp", "expires_in"]) {
    const v = tokenInfo?.[field];
    if (v === undefined || v === null || v === "") throw new HoldRefused("tokeninfo-field-missing", `token-info gave no ${field}: the credential needs the email scope`);
  }
  const { email, azp } = tokenInfo;
  if (typeof email !== "string" || !EMAIL.test(email)) throw new HoldRefused("email-invalid", "token-info's email is malformed");
  if (tokenInfo.email_verified !== "true" && tokenInfo.email_verified !== true) throw new HoldRefused("email-unverified", `token-info says ${email} is not verified`);
  const expiresIn = Number(tokenInfo.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn < MIN_TOKEN_SECONDS) throw new HoldRefused("token-expiring", `the token expires in ${tokenInfo.expires_in} s, under ${MIN_TOKEN_SECONDS} s`);
  if (/\.gserviceaccount\.com$/i.test(email.trim())) throw new HoldRefused("service-account", `${email} is a service account: an act is an Owner's, with their own credentials`);
  if (typeof azp !== "string") throw new HoldRefused("tokeninfo-field-missing", "token-info's azp is malformed");
  if (!same(email, operator)) throw new HoldRefused("operator-mismatch", `the credential is ${email}, not --operator ${operator}`);
  if (!same(email, intentOperator)) throw new HoldRefused("intent-operator-mismatch", `the credential is ${email}, not the intent's operator ${intentOperator}`);
  if (!same(email, gcloudAccount)) throw new HoldRefused("gcloud-account-mismatch", `the credential is ${email}, but gcloud's account is ${gcloudAccount || "unset"}`);
  return { email, verifiedVia: "tokeninfo", azp };
};

// One act. `deps`:
//   root                      the repository, for intent paths
//   fs                        node:fs/promises (mkdir, writeFile, readFile)
//   getAccessToken()          -> { access_token }, from the credential the Firestore client uses
//   fetch                     for token-info
//   gcloudAccount()           -> `gcloud config get-value account`
//   openHolds()               -> { applyHold, liftHold }, opened only after the identity is verified
//   randomUUID, now, log
// -> { intentPath, intent, appliedBy, result }
export const runAct = async (opts, deps) => {
  const { root, fs, getAccessToken, fetch, gcloudAccount, openHolds, randomUUID = uuid, now = () => Date.now() } = deps;
  // 1. The act.
  const retry = opts.intent !== null;
  const intent = retry ? await readIntent({ fs, path: opts.intent }) : newIntent(opts, { randomUUID, now });
  if (retry) {
    if (intent.act !== opts.command) throw new HoldRefused("intent-mismatch", `the intent file is a ${intent.act}, not a ${opts.command}`);
    if (opts.commandId !== null && opts.commandId !== intent.commandId) throw new HoldRefused("intent-mismatch", `the intent file is for ${intent.commandId}`);
  }
  const intentPath = retry ? opts.intent : intentPathFor(root, opts.intentDir, intent.actId);
  // 2. Who is acting, before anything reaches Firestore.
  let accessToken;
  try {
    accessToken = (await getAccessToken())?.access_token;
  } catch (e) {
    throw new HoldRefused("credential-failed", `the application-default credential gave no token (${e?.name ?? "error"})`);
  }
  if (typeof accessToken !== "string" || !accessToken) throw new HoldRefused("credential-failed", "the application-default credential gave no token");
  const tokenInfo = await fetchTokenInfo({ fetch, accessToken });
  let account = null;
  try {
    account = await gcloudAccount();
  } catch {
    account = null;
  }
  const appliedBy = verifyIdentity({ tokenInfo, operator: opts.operator, intentOperator: intent.operator, gcloudAccount: account });
  // 3. A new act is written down before it is first sent.
  if (!retry) await writeIntentOnce({ fs, path: intentPath, intent });
  // 4. The act, in Policy's database.
  const holds = await openHolds();
  const request = { commandId: intent.commandId, actId: intent.actId, reason: intent.reason, note: intent.note, decision: intent.decision, decidedBy: intent.decidedBy, appliedBy };
  const result = intent.act === "apply" ? await holds.applyHold(request) : await holds.liftHold({ ...request, lifts: intent.lifts });
  return { intentPath, intent, appliedBy, result };
};
