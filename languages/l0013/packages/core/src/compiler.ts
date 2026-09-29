// SPDX-License-Identifier: MIT
/* Copyright (c) 2023, ARTCOMPILER INC */
//
// L0013 inherits L0000. A program is `snap <opts>..`, where <opts> is assembled by chaining
// arity-2 modifier functions (`item`, `crop`, `width`) onto a base record `{}`. Each modifier
// returns a PLAIN object with one field set; `snap` (arity 1) consumes the assembled options,
// resolves the task + language from the item id, renders that item's form view, crops it,
// uploads a PNG, and returns { url, item }.
//
// Why plain objects: a record literal evaluates (in L0000's Transformer) to a Record wrapper
// ({ _type, _entries: Map } with prefix-encoded keys), not a plain object — so we normalize it
// to a plain object with `toPlain` and merge each modifier's field on top.
import {
  Checker as BaseChecker,
  Transformer as BaseTransformer,
  Compiler,
} from "@graffiticode/l0000";
import { snap } from "./snap.js";

// Normalize an evaluated value to a plain object: decode L0000 Record wrappers (their keys are
// encoded "kind:name"), pass plain objects through (recursively), arrays map element-wise.
function toPlain(v: any): any {
  if (v && typeof v === "object" && v._type === "record" && v._entries instanceof Map) {
    const obj: any = {};
    for (const [encodedKey, value] of v._entries) {
      const i = encodedKey.indexOf(":");
      obj[i >= 0 ? encodedKey.slice(i + 1) : encodedKey] = toPlain(value);
    }
    return obj;
  }
  if (Array.isArray(v)) return v.map(toPlain);
  if (v && typeof v === "object" && v.tag === undefined) {
    const obj: any = {};
    for (const [k, val] of Object.entries(v)) obj[k] = toPlain(val);
    return obj;
  }
  return v;
}

const concatErr = (...es: any[]) => es.flat().filter(Boolean);

export class Checker extends BaseChecker {
  [key: string]: any;

  // The Checker only validates structure (visiting yields AST nodes, not values), so the
  // handlers just visit their children and accept; field validation happens in the Transformer.
  SNAP(node, options, resume) {
    this.visit(node.elts[0], options, (e0) => resume(concatErr(e0), node));
  }

  ITEM(node, options, resume) {
    this.visit(node.elts[0], options, (e0) => {
      this.visit(node.elts[1], options, (e1) => resume(concatErr(e0, e1), node));
    });
  }

  VIEWPORT(node, options, resume) {
    this.visit(node.elts[0], options, (e0) => {
      this.visit(node.elts[1], options, (e1) => resume(concatErr(e0, e1), node));
    });
  }

  SLICE(node, options, resume) {
    this.visit(node.elts[0], options, (e0) => {
      this.visit(node.elts[1], options, (e1) => resume(concatErr(e0, e1), node));
    });
  }

  ZOOM(node, options, resume) {
    this.visit(node.elts[0], options, (e0) => {
      this.visit(node.elts[1], options, (e1) => resume(concatErr(e0, e1), node));
    });
  }

  CROP(node, options, resume) {
    this.visit(node.elts[0], options, (e0) => {
      this.visit(node.elts[1], options, (e1) => resume(concatErr(e0, e1), node));
    });
  }

  WIDTH(node, options, resume) {
    this.visit(node.elts[0], options, (e0) => {
      this.visit(node.elts[1], options, (e1) => resume(concatErr(e0, e1), node));
    });
  }

  HEIGHT(node, options, resume) {
    this.visit(node.elts[0], options, (e0) => {
      this.visit(node.elts[1], options, (e1) => resume(concatErr(e0, e1), node));
    });
  }
}

export class Transformer extends BaseTransformer {
  [key: string]: any;

  // Modifiers: each merges its field onto the (normalized) rest record and returns a plain object.
  ITEM(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        resume(concatErr(e0, e1), { ...toPlain(v1), item: v0 });
      });
    });
  }

  VIEWPORT(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        resume(concatErr(e0, e1), { ...toPlain(v1), viewport: toPlain(v0) });
      });
    });
  }

  SLICE(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        resume(concatErr(e0, e1), { ...toPlain(v1), slice: v0 });
      });
    });
  }

  ZOOM(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        resume(concatErr(e0, e1), { ...toPlain(v1), zoom: v0 });
      });
    });
  }

  CROP(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        resume(concatErr(e0, e1), { ...toPlain(v1), crop: toPlain(v0) });
      });
    });
  }

  WIDTH(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        resume(concatErr(e0, e1), { ...toPlain(v1), width: v0 });
      });
    });
  }

  HEIGHT(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      this.visit(node.elts[1], options, (e1, v1) => {
        resume(concatErr(e0, e1), { ...toPlain(v1), height: v0 });
      });
    });
  }

  SNAP(node, options, resume) {
    this.visit(node.elts[0], options, async (e0, v0) => {
      const err = concatErr(e0);
      const coord = node.coord ?? {};
      const args = toPlain(v0);
      if (!args || typeof args !== "object" || !args.item) {
        err.push({ message: 'snap: missing required `item` — use `snap item "<id>" {}..`.', ...coord });
        resume(err, null);
        return;
      }
      try {
        // The api server forwards the request's access token via config (see api/compile.ts).
        const token = options?.config?.authToken || options?.config?.auth || "";
        const out = await snap({
          item: args.item,
          lang: args.lang,
          task: args.task,
          viewport: args.viewport,
          slice: args.slice,
          zoom: args.zoom,
          crop: args.crop,
          width: args.width,
          height: args.height,
          token,
        });
        resume(err, out);
      } catch (x: any) {
        err.push({ message: `snap failed: ${x?.message || String(x)}`, ...coord });
        resume(err, null);
      }
    });
  }
}

export const compiler = new Compiler({
  langID: "0013",
  version: "v0.0.1",
  Checker,
  Transformer,
});
