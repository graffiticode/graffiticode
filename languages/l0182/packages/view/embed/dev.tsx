// SPDX-License-Identifier: MIT
/**
 * Dev-only fixture page: the renderer's states, side by side, with no API behind them.
 *
 * `index.html` mounts the shared View, which wants a task `id` and an API to fetch it from —
 * fine for the deployed /form, useless for looking at the component. This renders `Survey`
 * against fixed models instead, so every state that is awkward to reach by hand is one page
 * away. Vite builds only `index.html`, so this is not part of the embed bundle.
 *
 * Run: npm run -w packages/view dev, then open /dev.html
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { Survey } from "../src";
import "../src/index.css";

const options = [
  { id: "a3", text: "protect voting rights" },
  { id: "b7", text: "universal healthcare system" },
  { id: "c1", text: "affordable housing" },
  { id: "d9", text: "mitigate climate change" },
  { id: "e4", text: "clean air and water" },
];

const survey = {
  id: "civic-priorities",
  sessionId: "7gMeEzUYkHqm3PDRrI8i",
  instance: "civic-priorities-7",
  title: "Civic Priorities",
  options,
  minChoices: 1,
  maxChoices: 3,
};

const labels = (names: string[]) => names.map((label, i) => ({ value: i + 1, label }));
const range = (min: number, max: number, low?: string, high?: string) =>
  Array.from({ length: max - min + 1 }, (_, i) => ({
    value: min + i,
    ...(i === 0 && low ? { label: low } : {}),
    ...(i === max - min && high ? { label: high } : {}),
  }));

const agree = {
  name: "agree",
  points: labels([
    "Strongly disagree",
    "Disagree",
    "Neither agree nor disagree",
    "Agree",
    "Strongly agree",
  ]),
  optOut: "Not applicable",
};

const rating = {
  id: "course-feedback",
  sessionId: "7gMeEzUYkHqm3PDRrI8i",
  instance: "course-feedback-1",
  style: "rating",
  title: "Course Feedback",
  instructions:
    "Tell us how far you agree with each statement, then how easy the portal was and how likely you are to recommend the course.",
  items: [
    { id: "goals", text: "The course met its stated goals", scale: agree, required: true },
    {
      id: "labs",
      text: "The lab sessions helped me apply what I learned",
      scale: agree,
      required: true,
    },
    {
      id: "portal",
      text: "Using the course portal was",
      scale: { name: "ease", points: range(1, 7) },
      required: true,
      anchors: ["very difficult", "very easy"],
    },
    {
      id: "overall",
      text: "The course overall",
      scale: { name: "stars-5", points: range(1, 5), display: "stars" },
      required: true,
    },
    {
      id: "recommend",
      text: "How likely are you to recommend this course to a colleague?",
      scale: { name: "nps", points: range(0, 10, "Not at all likely", "Extremely likely") },
      required: false,
    },
  ],
  comment: { prompt: "Is there anything else you would like to tell the instructors?" },
};

const CASES: Array<[string, any, any[]]> = [
  ["Awaiting a response", { survey }, []],
  [
    "A full response",
    { survey, response: { choices: ["c1", "a3", "e4"], writeIn: "make public transit free" } },
    [],
  ],
  [
    "A contributed option and nothing chosen",
    { survey, response: { choices: [], writeIn: "ranked-choice voting" } },
    [],
  ],
  ["An id naming nothing in the set", { survey, response: { choices: ["c1", "gone"] } }, []],
  ["Rating: awaiting a response", { survey: rating }, []],
  [
    "Rating: a full response",
    {
      survey: rating,
      response: {
        ratings: [
          { item: "goals", value: 4 },
          { item: "labs", optOut: true },
          { item: "portal", value: 6 },
          { item: "overall", value: 4 },
          { item: "recommend", value: 9 },
        ],
        comment: "More worked examples before each lab would help.",
      },
    },
    [],
  ],
  [
    "Rating: optional item skipped, no comment, one rating off its scale",
    {
      survey: rating,
      response: {
        ratings: [
          { item: "goals", value: 2 },
          { item: "labs", value: 5 },
          { item: "portal", value: 12 },
          { item: "overall", value: 2 },
        ],
      },
    },
    [],
  ],
  [
    "A compile error",
    {},
    [
      {
        message: 'survey: needs `id`, the survey being taken, e.g. survey [id "civic-priorities"].',
      },
    ],
  ],
  ["Nothing compiled", {}, []],
];

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16 }}>
        {CASES.map(([label, data, errors]) => (
          <section key={label}>
            <h2
              style={{
                font: "600 12px system-ui",
                textTransform: "uppercase",
                color: "#71717a",
                margin: "24px 0 0",
              }}
            >
              {label}
            </h2>
            <div style={{ border: "1px solid #e4e4e7", borderRadius: 8 }}>
              <Survey state={{ data, errors, apply: () => {} }} />
            </div>
          </section>
        ))}
      </div>
    </React.StrictMode>,
  );
}
