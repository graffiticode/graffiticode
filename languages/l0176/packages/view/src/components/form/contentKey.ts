// SPDX-License-Identifier: MIT
// A content key that is stable across re-signs of the same assessment. The host
// (@graffiticode/l0000-view) fetches POST /compile through SWR with
// revalidateOnFocus, and each compile returns a freshly *signed* request (new
// signature / session_id / user_id / timestamp every call). That gives the
// `request` a new object identity on every window focus or reconnect even though
// the assessment is unchanged. Learnosity's Questions/Items API cannot be
// re-initialized on already-mounted DOM: a second init corrupts its internal
// state and throws "Cannot read properties of undefined (reading
// 'triggerBufferedEvents')". The volatile signing fields (signature, id,
// session_id, user_id, timestamp, meta) are all top-level siblings of the
// `questions` array, which itself carries no per-sign fields, so keying init on
// the questions content (plus type and any item reference) is stable across
// re-signs yet still changes when the assessment is genuinely edited. That lets
// the Form init Learnosity once per logical assessment. The request it is given
// is the one rendered: for an activity the Form resolved and signed itself
// (Form.tsx, resolve-then-sign), that request's questions are the RESOLVED
// ones, so the key follows the resolved content, not the {{var:X}} template.
export function contentKey(type: string | undefined, request: any): string {
  const questions = request?.questions ?? request?.request?.questions ?? [];
  const itemRef = request?.request?.reference ?? null;
  return JSON.stringify([type ?? null, questions, itemRef]);
}
