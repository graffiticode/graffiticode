// SPDX-License-Identifier: MIT
//
// ExecContext is the per-invocation authorization context: who is compiling,
// through which connection, under which invocation, and the policy snapshot and
// client used to reach the credential broker. There are no execution modes:
// running the program is the action, and the grant is the authority.
//
// Two invariants make it a security boundary rather than a convenience:
//
// 1. It never lives in `options`/`config`. Programs read and write `options`
//    through GET_VAR/SET_VAR, so anything placed there is program-visible and
//    program-writable.
// 2. It belongs to one invocation, never to a Compiler. Language servers reuse a
//    singleton Compiler across concurrent requests (L0176 exports one), so state
//    on the Compiler would mix users. Each compile() allocates a fresh context and
//    binds it to that invocation's Checker and Transformer instances, which are
//    themselves created per compile.

import { randomUUID } from "crypto";

export interface ExecIdentity {
  uid?: string | null;
  connectionId?: string | null;
  // Forwarded to policy only; never exposed as properties.
  userToken?: string | null;
  // The logical invocation, allocated by the authenticated entry point (the
  // gateway) and shared by every retry of it, and this compile's position in
  // the task chain. Policy derives operation ids from them, so a retry reaches
  // the same write receipts.
  invocationToken?: string | null;
  stage?: string | null;
}

// What a language's transformer asks the broker to do for one protected call.
export interface ProtectedCall {
  fn: string;
  op: string;
  payload: unknown;
  // Stable within the invocation for the same node and ordinal (see
  // nextOccurrence), so a retried save reproduces the same operation ids.
  occurrenceId: string;
}

export type Invoker = (exec: ExecContext, call: ProtectedCall) => Promise<any>;

export class ExecContext {
  readonly uid: string | null;
  readonly connectionId: string | null;
  readonly stage: string | null;
  // Unique to this compile. For diagnostics only: the logical invocation, which
  // retries share, comes from the invocation token.
  readonly compileId: string;
  #userToken: string | null;
  #invocationToken: string | null;
  #sessionToken: string | null = null;
  #invoker: Invoker | null = null;
  #occurrences = new Map<string, number>();
  #snapshot: unknown = undefined;

  constructor(identity: ExecIdentity = {}) {
    this.uid = typeof identity.uid === "string" && identity.uid ? identity.uid : null;
    this.connectionId =
      typeof identity.connectionId === "string" && identity.connectionId ? identity.connectionId : null;
    this.#userToken = typeof identity.userToken === "string" && identity.userToken ? identity.userToken : null;
    this.#invocationToken =
      typeof identity.invocationToken === "string" && identity.invocationToken ? identity.invocationToken : null;
    this.stage = typeof identity.stage === "string" && identity.stage ? identity.stage : null;
    this.compileId = randomUUID();
    Object.freeze(this);
  }

  // Credentials a policy client forwards. Language code may read them; no
  // program can (the context is unreachable from the AST).
  policyCredentials(): { userToken: string | null; invocationToken: string | null } {
    return { userToken: this.#userToken, invocationToken: this.#invocationToken };
  }

  get sessionToken(): string | null {
    return this.#sessionToken;
  }

  setSessionToken(token: string): void {
    if (this.#sessionToken !== null) {
      throw new Error("ExecContext session is already set for this invocation");
    }
    this.#sessionToken = token;
  }

  // Deterministic occurrence ids: the Nth protected call made from the same
  // node in this invocation is `<key>.<N>`. A retry that follows the same path
  // reproduces them; a loop calling one node repeatedly gets distinct ones.
  nextOccurrence(key: string): string {
    const n = this.#occurrences.get(key) ?? 0;
    this.#occurrences.set(key, n + 1);
    return `${key}.${n}`;
  }

  bindInvoker(invoker: Invoker): void {
    if (this.#invoker !== null) {
      throw new Error("ExecContext invoker is already bound");
    }
    this.#invoker = invoker;
  }

  // The only way a language performs a protected operation. Refuses anything
  // admission did not allow, before any network call.
  async invoke(call: ProtectedCall): Promise<any> {
    const allowed = (this.#snapshot as any)?.allowed;
    if (!Array.isArray(allowed) || !allowed.includes(call.fn)) {
      throw new Error(`${call.fn} was not admitted for this invocation`);
    }
    if (!this.#invoker) {
      throw new Error("no protected-operation client is configured");
    }
    return this.#invoker(this, call);
  }

  // The policy snapshot is fetched once per compile and is immutable for the
  // rest of that compile.
  get snapshot(): unknown {
    return this.#snapshot;
  }

  setSnapshot(snapshot: unknown): void {
    if (this.#snapshot !== undefined) {
      throw new Error("ExecContext snapshot is already set for this invocation");
    }
    this.#snapshot = snapshot;
  }
}

// Keyed by the per-compile Checker/Transformer instance. A WeakMap (rather than
// a property) keeps the context off the visitor's own keys, so AST dispatch by
// node tag (`this[node.tag]`) can never reach it.
const contexts = new WeakMap<object, ExecContext>();

export function bindExecContext(visitor: object, ctx: ExecContext): void {
  if (contexts.has(visitor)) {
    throw new Error("ExecContext is already bound to this visitor");
  }
  contexts.set(visitor, ctx);
}

export function execContextOf(visitor: object): ExecContext | undefined {
  return contexts.get(visitor);
}
