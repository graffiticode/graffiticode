// SPDX-License-Identifier: MIT
/**
 * Fallback envelope for a question carrying no authored data, or data that will not parse:
 * an empty web in the compiled shape, so the Form renders its placeholder rather than throwing.
 */
export const defaultData = {
  interaction: {
    type: "concept-web",
    hub: { id: "hub", text: "" },
    nodes: [],
    edges: [],
    trays: {},
    cells: {},
  },
  validation: { points: 0, cells: {} },
};
