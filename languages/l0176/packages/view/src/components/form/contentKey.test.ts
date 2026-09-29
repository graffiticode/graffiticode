// SPDX-License-Identifier: MIT
// Verifies the init guard's decision function: the key must stay stable when the
// host re-signs the same assessment (new signature/ids) so Learnosity is not
// re-initialized (which throws "triggerBufferedEvents"), and must change when the
// actual content changes so a genuinely different assessment does re-init.
import { describe, test, expect } from "vitest";
import { contentKey } from "./contentKey";

// Two independent /compile responses for the SAME questions program. Only the
// signing envelope differs (signature / id / session_id / user_id / timestamp);
// the questions array (reference-derived, from the stable lrn-id) is identical.
const signA = {
  consumer_key: "K", user_id: "u-aaaa", timestamp: "20260720-1806",
  signature: "$02$aaaa", id: "id-aaaa", name: "Test",
  questions: [{ type: "mcq", reference: "artcompiler-mcq-t-0", data: { type: "mcq", stimulus: "2+2?" } }],
  session_id: "sess-aaaa",
};
const signB = {
  consumer_key: "K", user_id: "u-bbbb", timestamp: "20260720-1810",
  signature: "$02$bbbb", id: "id-bbbb", name: "Test",
  questions: [{ type: "mcq", reference: "artcompiler-mcq-t-0", data: { type: "mcq", stimulus: "2+2?" } }],
  session_id: "sess-bbbb",
};

describe("contentKey", () => {
  test("is stable across re-signs of the same questions assessment", () => {
    expect(contentKey("questions", signA)).toBe(contentKey("questions", signB));
  });

  test("changes when the question content is edited (same reference)", () => {
    // An edit keeps the reference (same lrn-id + index) but changes the stimulus;
    // the key must still change so the edited assessment re-initializes.
    const edited = {
      ...signB,
      questions: [{ type: "mcq", reference: "artcompiler-mcq-t-0", data: { type: "mcq", stimulus: "3+3?" } }],
    };
    expect(contentKey("questions", edited)).not.toBe(contentKey("questions", signA));
  });

  test("changes when the type flips (questions preview -> items save)", () => {
    const itemsReq = {
      security: { signature: "$02$cccc", user_id: "u-cccc" },
      request: { reference: "graffiticode-item-1", questions: [{ response_id: "artcompiler-mcq-item-1-0" }] },
    };
    expect(contentKey("items", itemsReq)).not.toBe(contentKey("questions", signA));
  });

  test("is stable across re-signs of an items request (envelope-only change)", () => {
    const itemsA = {
      security: { signature: "$02$1111", user_id: "u-1111" },
      request: { reference: "graffiticode-item-1", questions: [{ response_id: "artcompiler-mcq-item-1-0" }] },
    };
    const itemsB = {
      security: { signature: "$02$2222", user_id: "u-2222" },
      request: { reference: "graffiticode-item-1", questions: [{ response_id: "artcompiler-mcq-item-1-0" }] },
    };
    expect(contentKey("items", itemsA)).toBe(contentKey("items", itemsB));
  });
});
