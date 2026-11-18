// Builds evidence/hermetic-fallbacks.json (the #421 review's field-level
// shape) from verbatim jest output captured at the deployed commits
// (policy f6132821 scopes.spec + captures.spec, broker 58adb430 gcs.spec).
import { readFileSync, writeFileSync } from "node:fs";
import { verbatimProblem } from "../../../../scripts/lib/c5a-gate-checks.js";
const dir = new URL(".", import.meta.url).pathname;
const out = f => readFileSync(`${dir}${f}`, "utf8");
const POLICY = { service: "policy", commit: "f6132821c5a654c2bfd3fce10ca7b5a5e328bdc2" };
const BROKER = { service: "broker", commit: "58adb43055b4a8ed6fb2d9d9e750db291cea9bb8" };
const scopes = out("policy-f6132821-scopes.out");
const captures = out("policy-f6132821-captures.out");
const gcs = out("broker-58adb430-gcs.out");
const NO_PAUSE = "No approved interface pauses, holds or reorders execution inside a command: the gate can only start commands through api-c5a-gate, as the owner, a non-owner or anonymously, and read Policy's and Broker's records. Reserve, render, stage, bind, mint and Broker's authorize-and-publish run back to back inside one l0013r run (languages/l0013/crates/core/src/lib.rs:296-312, packages/broker/src/gcs.ts:240-283), and production Broker has no fault or hook interface (the beforeUpload hook exists only in the spec's fake storage).";
const evidence = {
  hermetic: {
    narrowed: {
      ...POLICY,
      test: "packages/policy/src/scopes.spec.ts › v3 execution (decisions 5 and 6) › refuses an owner's capture at authorize-execution once the item has changed owner",
      output: scopes, passed: true,
      uninducible: `Policy answers not-owner at authorize-execution only when the item still exists and is no longer the command's subject's (packages/policy/src/item-authority.ts:109-112, policy.ts:1460-1468). No approved interface changes an item's owner: the console's updateItem fields exclude it (graffiticode-app packages/console/src/utils/swr/fetchers.ts:543-575) and the owner is the item's path; deleting it answers item-not-found, making it public leaves it the owner's, and retargeting answers render-target-changed. Even an owner change couldn't be placed between reservation and authorize-execution: ${NO_PAUSE}`,
      result: { reason: "not-owner" },
    },
    conditional: {
      records: [{
        fields: ["attempts", "finalSequence", "newerSequence"], ...BROKER,
        test: "packages/broker/src/gcs.spec.ts › publishing (decision 8) › ends a 412 race on the newer capture: the older wins first, the newer retries under a fresh decision",
        output: gcs, passed: true,
        supporting: [{ ...POLICY, test: "packages/policy/src/scopes.spec.ts › v3 execution (decisions 5 and 6) › authorizes a capture's attempts as the registry allows them, each with its own decision", output: scopes, passed: true }],
        uninducible: `The race needs the older capture's upload to land between the newer's metadata read and its conditional upload inside Broker (packages/broker/src/gcs.ts:246-273), within one Policy authorize call. ${NO_PAUSE} Owner captures of the private item, which the public quota doesn't limit, can be started back to back, but nothing approved can hold either one at a step, so the interleaving can't be induced; a run that happened to observe it would decide live.`,
        resultBasis: "the test asserts B's attempts [[1, precondition-failed], [2, published]] with two distinct decision ids (Broker's receipts and its execute-step audit), B is sequence 6 and the object ends on captureSequence 6; the supporting Policy test shows each attempt gets its own decision. The decision ids here name the attempts the test asserts distinct; their values come from the spec's fake Policy.",
        result: { attempts: [{ decisionId: "attempt 1 (precondition-failed)" }, { decisionId: "attempt 2 (published)" }], newerSequence: 6, finalSequence: 6 },
      }],
    },
    reserveStageBind: {
      records: [
        {
          fields: ["repeatReserveSame", "repeatStageSame"], ...POLICY,
          test: "packages/policy/src/captures.spec.ts › reserve, stage and bind (decision 9) › run in order, each once: a repeat answers what is recorded",
          output: captures, passed: true,
          uninducible: `A repeated reserve or stage of one occurrence happens only when the same occurrence runs again after a crash or a takeover: l0013r reserves once and stages only an unstaged reservation (languages/l0013/crates/core/src/lib.rs:296-305), and the api answers a repeated idempotency key from the recorded command without running it. ${NO_PAUSE}`,
          result: { repeatReserveSame: true, repeatStageSame: true },
        },
        {
          fields: ["outOfOrderNewer", "outOfOrderFinal"], ...BROKER,
          test: "packages/broker/src/gcs.spec.ts › publishing (decision 8) › completes an older capture arriving after a newer one with its own result, writing nothing",
          output: gcs, passed: true,
          uninducible: `The older capture's publish must reach Broker after the newer's. ${NO_PAUSE} A run that happened to observe it would decide live.`,
          resultBasis: "the newer (captureSequence 6) is published, the older (5) then arrives, is observed newer-present and writes nothing; the published object is unchanged, still the newer's 6.",
          result: { outOfOrderNewer: 6, outOfOrderFinal: 6 },
        },
      ],
    },
  },
};
const check = (label, rec) => { const p = verbatimProblem(rec.test, rec.output); if (p) throw new Error(`${label}: ${p}`); };
check("narrowed", evidence.hermetic.narrowed);
for (const r of evidence.hermetic.conditional.records) { check("conditional", r); for (const s of r.supporting ?? []) check("conditional supporting", s); }
for (const r of evidence.hermetic.reserveStageBind.records) check("reserveStageBind", r);
writeFileSync(new URL("../../evidence/hermetic-fallbacks.json", import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
console.log("wrote evidence/hermetic-fallbacks.json; every record's output shows its test passing");
