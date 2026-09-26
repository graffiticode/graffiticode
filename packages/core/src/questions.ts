// SPDX-License-Identifier: MIT
// Ported from L0158 packages/api/src/questions.js.
import { v4 as uuid } from "uuid";

const replaceVariableRefs = (str: string) => {
  // Replace {{...}} with {{var:...}} for template variables,
  // but skip {{response}} which is a Learnosity cloze placeholder.
  return str.replace(/\{\{(?!response\}\})/g, "{{var:");
};

const isNonNullNonEmptyObject = (obj: any) => (
  typeof obj === "object" &&
    obj !== null &&
    Object.keys(obj).length > 0
);

const fixVariableRefs = (obj: any) => (
  Object.keys(obj).reduce((obj: any, key) => {
    const val = obj[key];
    if (typeof obj[key] === "string") {
      obj[key] = replaceVariableRefs(val);
    } else if (isNonNullNonEmptyObject(val)) {
      obj[key] = fixVariableRefs(val);
    }
    return obj;
  }, obj)
);

// Builds the render activity and the plan a save would write; never writes
// (the write happens only in the broker).
export const buildCreateQuestions = () => async (data: any, { id }: any = {}) => {
  // Inherit a dynamic-data table from the first question whose data carries
  // one (typically an embedded L0179 custom question whose data includes
  // templateVariablesRecords). Items have one shared table in Learnosity's
  // model; first-wins matches the common single-widget-per-item case.
  let templateVariablesRecords;
  for (const q of data) {
    const records = q?.data?.templateVariablesRecords;
    if (Array.isArray(records) && records.length > 0) {
      templateVariablesRecords = records;
      break;
    }
  }
  const batchId = id || "0";
  const questions = data.map((question: any, index: number) => {
    const reference = `artcompiler-${question.type}-${batchId}-${index}`;
    const data = fixVariableRefs(question);
    return {
      type: question.type,
      reference,
      data,
    };
  });
  const questionRefs = questions.map((question: any) => question.reference);
  // Two shapes, and they are not interchangeable. The item bank takes records —
  // {type, reference, data} — which is what `questions` above holds and what the
  // Data API write posts. Rendering goes through the Questions API with the
  // question data inline and keyed by `response_id`; handed a record array it
  // rejects the activity outright ("the question object at index 0 is missing
  // the response_id attribute") and nothing renders at all. `items.ts` builds
  // both for the same reason; this path used to build only the first.
  const inlineQuestions = questions.map((q: any) => ({
    response_id: q.reference,
    type: q.type,
    ...q.data,
  }));
  const questionsData: any = {
    "id": uuid(),
    "name": "Test",
    questions: inlineQuestions,
    session_id: uuid(),
  };
  return {
    activity: {
      type: "questions",
      data: questionsData,
      templateVariablesRecords,
      questionRefs,
    },
    savePlan: { questionRecords: questions, itemRecords: [] },
  };
};

export const buildInitQuestions = ({
  sdk,
  key,
  secret,
  domain,
}: any) => async ({ data }: any, { key: optKey, secret: optSecret }: any = {}) => {
  // Construct a questions api request.
  const user_id = uuid();
  const consumer = {
    consumer_key: optKey ?? key,
    domain,
    user_id,
  };
  const signedRequest = sdk.init(
    "questions",
    consumer,
    optSecret ?? secret,
    data,
  );
  return signedRequest;
};
