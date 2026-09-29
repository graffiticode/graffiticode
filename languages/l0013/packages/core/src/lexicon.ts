// SPDX-License-Identifier: MIT
// L0013's lexicon = L0000's base vocabulary + L0013's additions (child keys win on merge).
//
// A program is `snap <opts>..`, where <opts> is built by chaining arity-2 modifier functions
// onto a base record `{}`. Each modifier returns a plain object with one field set, so `snap`
// receives a plain options object (no Record-wrapper decoding needed):
//
//   snap item "item123" {}..                         → { item: "item123" }
//   snap width 240 item "item123" {}..               → { item: "item123", width: 240 }
//   snap slice "4:1" item "item123" {}..             → { item: "item123", slice: "4:1" }
//   snap zoom 0.5 slice "4:1" item "item123" {}..    → { item: "item123", slice: "4:1", zoom: 0.5 }
//   snap crop { x: 0 y: 0 width: 800 height: 600 } item "item123" {}..
//
// `snap` resolves the task id and language from the item id, renders that item's form view,
// crops it (default: trim to inked content; `slice "W:H"`: densest band at that aspect),
// uploads a PNG, and returns { image, url, item }.
import { lexicon as base } from "@graffiticode/l0000";

const additions = {
  snap: { tk: 1, name: "SNAP", cls: "function", length: 1, arity: 1 },
  item: { tk: 1, name: "ITEM", cls: "function", length: 2, arity: 2 },
  viewport: { tk: 1, name: "VIEWPORT", cls: "function", length: 2, arity: 2 },
  slice: { tk: 1, name: "SLICE", cls: "function", length: 2, arity: 2 },
  zoom: { tk: 1, name: "ZOOM", cls: "function", length: 2, arity: 2 },
  crop: { tk: 1, name: "CROP", cls: "function", length: 2, arity: 2 },
  width: { tk: 1, name: "WIDTH", cls: "function", length: 2, arity: 2 },
  height: { tk: 1, name: "HEIGHT", cls: "function", length: 2, arity: 2 },
};

export const lexicon = { ...base, ...additions };
