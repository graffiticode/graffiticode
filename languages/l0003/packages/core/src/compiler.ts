// SPDX-License-Identifier: MIT
/* Copyright (c) 2023, ARTCOMPILER INC */
//
// L0003 inherits L0000: its Checker/Transformer extend L0000's, adding handlers for the
// L0003 vocabulary (hello, image, theme, print) and overriding PROG. Unhandled tags fall
// through to L0000's base handlers via `super`/the shared Visitor dispatch.
import {
  Checker as BaseChecker,
  Transformer as BaseTransformer,
  Compiler,
} from "@graffiticode/l0000";

export class Checker extends BaseChecker {
  [key: string]: any;

  THEME(node, options, resume) {
    this.visit(node.elts[0], options, async (e0, v0) => {
      this.visit(node.elts[1], options, async (e1, v1) => {
        const node0 = this.nodePool[node.elts[0]];
        if ((v0.tag === "TAG" && v0.elts[0] === "DARK") || v0.elts[0] === "LIGHT") {
          const err = [];
          const val = node;
          resume(err, val);
        } else {
          const err = [
            {
              message: `Expecting a tag DARK or tag LIGHT. Got ${(v0.tag && "tag " + v0.elts[0]) || v0}.`,
              ...node0.coord,
            },
          ];
          const val = node;
          resume(err, val);
        }
      });
    });
  }

  HELLO(node, options, resume) {
    this.visit(node.elts[0], options, async (e0, v0) => {
      const err = [];
      const val = node;
      resume(err, val);
    });
  }

  // `id "name" body`: the identifier must be a string.
  ID(node, options, resume) {
    this.visit(node.elts[0], options, async (e0, v0) => {
      this.visit(node.elts[1], options, async (e1, v1) => {
        const node0 = this.nodePool[node.elts[0]];
        const err =
          node0?.tag === "STR"
            ? []
            : [{ message: `id: expecting a string, e.g. id "greeting" hello "world". Got ${node0?.tag ?? "nothing"}.`, ...node0?.coord }];
        resume(err, node);
      });
    });
  }
}

export class Transformer extends BaseTransformer {
  [key: string]: any;

  PRINT(node, options, resume) {
    this.visit(node.elts[0], options, (e0, v0) => {
      const err = e0;
      const val = {
        print: v0,
      };
      resume(err, val);
    });
  }

  HELLO(node, options, resume) {
    this.visit(node.elts[0], options, async (e0, v0) => {
      const data = options?.data || {};
      const err = [];
      const val = {
        ...data,
        hello: data.hello !== undefined ? data.hello : v0,
      };
      resume(err, val);
    });
  }

  IMAGE(node, options, resume) {
    this.visit(node.elts[0], options, async (e0, v0) => {
      const data = options?.data || {};
      const err = [];
      const val = {
        image: v0,
        ...data,
      };
      resume(err, val);
    });
  }

  THEME(node, options, resume) {
    this.visit(node.elts[0], options, async (e0, v0) => {
      this.visit(node.elts[1], options, async (e1, v1) => {
        const data = options?.data || {};
        // If the themed body is already a named record (e.g. { hello }), merge it so its
        // fields sit alongside `theme`. Otherwise (a scalar or list) wrap it under `value`
        // so it isn't lost next to `theme`.
        const isRecord = typeof v1 === "object" && v1 !== null && !Array.isArray(v1);
        const body = isRecord ? v1 : { value: v1 };
        resume([], {
          theme: v0?.tag.toLowerCase(),
          ...body,
          ...data,
        });
      });
    });
  }

  // `id "name" body` attaches an element identifier. Like THEME, a record body keeps its
  // fields alongside `id`; a scalar or list goes under `value` so it isn't lost. Before this
  // handler existed, `id` fell through and the program returned its raw parse node.
  ID(node, options, resume) {
    this.visit(node.elts[0], options, async (e0, v0) => {
      this.visit(node.elts[1], options, async (e1, v1) => {
        const data = options?.data || {};
        const isRecord = typeof v1 === "object" && v1 !== null && !Array.isArray(v1);
        const body = isRecord ? v1 : { value: v1 };
        resume([...(e0 || []), ...(e1 || [])], { id: v0, ...body, ...data });
      });
    });
  }

  PROG(node, options, resume) {
    this.visit(node.elts[0], options, async (e0, v0) => {
      const data = options?.data || {};
      const val = v0.pop();
      // No `_` wrapper: the program result IS the data (carried in the compile envelope's
      // `data` field). Records merge with any input data; scalars/lists pass through as-is.
      const isObject = typeof val === "object" && val !== null && !Array.isArray(val);
      resume(e0, isObject ? { ...val, ...data } : val);
    });
  }
}

export const compiler = new Compiler({
  langID: "0003",
  version: "v0.0.1",
  Checker,
  Transformer,
});
