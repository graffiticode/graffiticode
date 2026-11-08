/* eslint-disable camelcase -- Google ID token claims are snake_case */
// Recovery's sweep and its caller check (B5 slice 6, docs/b5-commands-plan.md §7).
import { buildSweep, buildSweepAuthorizer, parseSweepConfig } from "./sweep.js";
import { PolicyRefused } from "./policy-commands.js";

describe("buildSweep", () => {
  it("takes over each due command at the next generation and continues it", async () => {
    const leased = [];
    const ran = [];
    const policy = {
      due: async () => ({ commands: [{ commandId: "c:1", generation: 1 }, { commandId: "c:2", generation: 3 }] }),
      lease: async args => { leased.push(args); return { generation: args.generation + 1 }; },
    };
    const sweep = buildSweep({ policy, run: async args => { ran.push(args); return { status: "completed" }; }, worker: "w9", log: () => {} });
    expect(await sweep()).toEqual({ due: 2, taken: 2, skipped: 0, failed: 0 });
    expect(leased).toEqual([{ commandId: "c:1", worker: "w9", generation: 1, takeOver: true }, { commandId: "c:2", worker: "w9", generation: 3, takeOver: true }]);
    expect(ran).toEqual([{ commandId: "c:1", generation: 2 }, { commandId: "c:2", generation: 4 }]);
  });

  it("skips a command another worker took first, and keeps going past one whose run failed", async () => {
    const policy = {
      due: async () => ({ commands: [{ commandId: "c:1", generation: 1 }, { commandId: "c:2", generation: 1 }, { commandId: "c:3", generation: 1 }] }),
      lease: async ({ commandId, generation }) => {
        if (commandId === "c:1") throw new PolicyRefused("stale-generation");
        return { generation: generation + 1 };
      },
    };
    const run = async ({ commandId }) => {
      if (commandId === "c:2") throw new Error("a language service is down");
      return { status: "completed" };
    };
    expect(await buildSweep({ policy, run, worker: "w9", log: () => {} })()).toEqual({ due: 3, taken: 2, skipped: 1, failed: 1 });
  });
});

describe("the sweep route's caller", () => {
  const req = header => ({ get: name => (name === "authorization" ? header : undefined) });
  const verifyIdToken = async (token, audience) => {
    if (token === "bad" || audience !== "https://api/internal/commands/sweep") throw new Error("invalid");
    return { scheduler: { email: "sweeper@p.iam.gserviceaccount.com", email_verified: true }, other: { email: "x@p.iam.gserviceaccount.com", email_verified: true }, unverified: { email: "sweeper@p.iam.gserviceaccount.com", email_verified: false } }[token];
  };
  const authorized = buildSweepAuthorizer({ verifyIdToken, audience: "https://api/internal/commands/sweep", callers: ["sweeper@p.iam.gserviceaccount.com"] });

  it("is the scheduler's account, verified, for this audience", async () => {
    expect(await authorized(req("Bearer scheduler"))).toBe(true);
    expect(await authorized(req("Bearer other"))).toBe(false);
    expect(await authorized(req("Bearer unverified"))).toBe(false);
    expect(await authorized(req("Bearer bad"))).toBe(false);
    expect(await authorized(req(undefined))).toBe(false);
  });

  it("is configured by SWEEP_AUDIENCE and SWEEP_CALLERS, or not mounted", () => {
    expect(parseSweepConfig({})).toBeNull();
    expect(parseSweepConfig({ SWEEP_AUDIENCE: "a" })).toBeNull();
    expect(parseSweepConfig({ SWEEP_AUDIENCE: "a", SWEEP_CALLERS: "s@p, t@p" })).toEqual({ audience: "a", callers: ["s@p", "t@p"] });
  });
});
