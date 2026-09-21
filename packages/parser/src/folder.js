import assert from "assert";
import { Ast } from "./ast.js";
import { Env } from "./env.js";
import { assertErr } from "./parse.js";

// Helper to check if a value is a function
function isFunction(v) {
  return v instanceof Function;
}

export class Folder {
  static #nodePool;
  static #ctx;
  static #table;

  static {
    Folder.#table = {
      PROG: Folder.program,
      EXPRS: Folder.exprs,
      PAREN: Folder.parenExpr,
      IDENT: Folder.ident,
      BOOL: Folder.bool,
      NUM: Folder.num,
      STR: Folder.str,
      PARENS: Folder.unaryExpr,
      APPLY: Folder.apply,
      LAMBDA: Folder.lambda,
      MUL: Folder.mul,
      DIV: Folder.div,
      SUB: Folder.sub,
      TAG: Folder.tag,
      ADD: Folder.add,
      POW: Folder.pow,
      MOD: Folder.mod,
      CONCAT: Folder.concat,
      // "OR": orelse,
      // "AND": andalso,
      // "NE": ne,
      // "EQ": eq,
      // "LT": lt,
      // "GT": gt,
      // "LE": le,
      // "GE": ge,
      NEG: Folder.neg,
      LIST: Folder.list,
      BINDING: Folder.binding,
      OF: Folder.ofClause,
      // "CASE": caseExpr,
    };
  }

  static fold(cx, nid) {
    Folder.#ctx = cx;
    Folder.#nodePool = cx.state.nodePool;
    Folder.#visit(nid);
  }

  static #visit(nid) {
    const node = Folder.#nodePool[nid];
    if (!node) {
      return null;
    }

    if (node.tag === undefined) {
      return []; // clean up stubs;
    } else if (isFunction(Folder.#table[node.tag])) {
      // Have a primitive operation so apply it to construct a new node.
      const ret = Folder.#table[node.tag](node);
      return ret;
    }

    // If this node's tag has a callback, resolve it. For get-val-public the
    // resolved value is plaintext, so fold it to a string literal. For
    // get-val-private the resolved value is CIPHERTEXT — preserve the
    // GET_VAL_PRIVATE node (name in elts[0], ciphertext in elts[1]) so the
    // compiler decrypts it at compile time. Folding it to a bare string would
    // strip the node and leak the ciphertext into the program undecrypted.
    const callbacks = Folder.#ctx.state.callbacks;
    if (callbacks && callbacks[node.tag] && node.elts.length === 1) {
      const eltNode = Folder.#nodePool[node.elts[0]];
      if (eltNode && eltNode.tag === "STR") {
        const name = eltNode.elts[0];
        let resolved;
        try {
          resolved = callbacks[node.tag](name);
        } catch (err) {
          // A callback failure is a host problem — a missing signing key, an
          // unreachable credential store — not a syntax mistake in the program.
          // Report it as itself. Letting it escape lands in parse()'s catch-all,
          // which relabels any stray exception "Syntax Error" and points at the
          // end of the program, so a server misconfiguration reads as bad user
          // code.
          assertErr(
            Folder.#ctx,
            false,
            `${node.tag} "${name}": ${(err && err.message) || err}`,
            node.coord,
          );
        }
        if (node.tag === "GET_VAL_PRIVATE") {
          Ast.name(Folder.#ctx, node.tag, node.coord);
          Ast.string(Folder.#ctx, resolved, node.coord); // elts[1] = ciphertext
          Ast.string(Folder.#ctx, name, node.coord); // elts[0] = name
          Ast.expr(Folder.#ctx, 2, node.coord);
        } else {
          Ast.string(Folder.#ctx, resolved, node.coord);
        }
        return;
      }
    }

    Folder.#expr(node);
  }

  // BEGIN VISITOR METHODS

  static program(node) {
    Folder.#visit(node.elts[0]);
    Ast.program(Folder.#ctx);
  }

  static #pushNodeStack() {
    Folder.#ctx.state.nodeStackStack.push(Folder.#ctx.state.nodeStack);
    Folder.#ctx.state.nodeStack = [];
  }

  static #popNodeStack() {
    const stack = Folder.#ctx.state.nodeStack;
    Folder.#ctx.state.nodeStack = Folder.#ctx.state.nodeStackStack.pop().concat(stack);
  }

  static list(node) {
    Folder.#pushNodeStack();
    for (let i = node.elts.length - 1; i >= 0; i--) {
      Folder.#visit(node.elts[i]); // Keep original order.
    }
    Ast.list(Folder.#ctx, Folder.#ctx.state.nodeStack.length, null, true);
    Folder.#popNodeStack();
  }

  static exprs(node) {
    // Fold exprs in reverse order to get precedence right.
    for (let i = node.elts.length - 1; i >= 0; i--) {
      Folder.#visit(node.elts[i]); // Keep original order.
    }
    Folder.#ctx.state.exprc = node.elts.length;
  }

  static lambda(node) {
    // Fold initializers and apply args.
    const inits = Ast.node(Folder.#ctx, node.elts[3]).elts;
    inits.forEach((init, i) => {
      if (init) {
        // If we have an init then fold it and replace in inits list.
        Folder.fold(Folder.#ctx, Ast.intern(Folder.#ctx, init));
        inits[i] = Ast.pop(Folder.#ctx);
      }
    });
    // FIXME don't patch old node. construct a new one.
    node.elts[3] = Ast.intern(Folder.#ctx, { tag: "LIST", elts: inits });
    const fnId = Ast.intern(Folder.#ctx, node);
    const argc = Folder.#ctx.state.nodeStack.length;
    Ast.apply(Folder.#ctx, fnId, argc);
  }

  static apply(node) {
    for (let i = node.elts.length - 1; i >= 0; i--) {
      Folder.#visit(node.elts[i]);
    }
    Ast.applyLate(Folder.#ctx, node.elts.length);
  }

  static #expr(node) {
    // Construct an expression node for the compiler.
    Ast.name(Folder.#ctx, node.tag, node.coord);
    for (let i = node.elts.length - 1; i >= 0; i--) {
      Folder.#visit(node.elts[i]);
    }
    Ast.expr(Folder.#ctx, node.elts.length, node.coord);
  }

  static neg(node) {
    Folder.#visit(node.elts[0]);
    Ast.neg(Folder.#ctx);
  }

  static parenExpr(node) {
    Folder.#pushNodeStack();
    const builtin = Folder.#builtinRef(node.elts[0]);
    if (builtin) {
      // `(add)` names a built-in as a value. Built-ins have no LAMBDA node to
      // defer, so eta-expand to the lambda `<a b: add a b>` would produce.
      Ast.push(Folder.#ctx, Folder.#etaExpand(builtin));
    } else {
      Folder.#visit(node.elts[0]);
      // Folding the inner EXPRS pushes one node per expression. Parens only group, so
      // `(1 2)` must keep both inside the group: collapse them back into one EXPRS rather
      // than wrapping the first and spilling the rest outside it as `(1) 2`.
      const count = Folder.#ctx.state.nodeStack.length;
      if (count > 1) {
        Ast.exprs(Folder.#ctx, count, true);
      }
    }
    Ast.parenExpr(Folder.#ctx);
    Folder.#popNodeStack();
  }

  // The lexicon word for `nid` if it is a bare reference to a built-in function
  // that takes arguments, otherwise null.
  static #builtinRef(nid) {
    let node = Folder.#nodePool[nid];
    if (node?.tag === "EXPRS" && node.elts.length === 1) {
      node = Folder.#nodePool[node.elts[0]]; // `(add)` parses as PAREN(EXPRS(IDENT)).
    }
    if (node?.tag !== "IDENT") {
      return null;
    }
    const word = Env.findWord(Folder.#ctx, node.elts[0]);
    if (word?.cls !== "function" || word.nid) {
      return null;
    }
    const argc = word.arity !== undefined ? word.arity : word.length;
    return argc > 0 ? { name: word.name, argc } : null;
  }

  static #etaExpand({ name, argc }) {
    // Params are named by position (a, b, c, …). They are bound only in the
    // body, which references nothing else, so the names cannot capture.
    const param = i => ({ tag: "IDENT", elts: [String.fromCharCode(97 + i)] });
    const indexes = Array.from({ length: argc }, (_, i) => i);
    return {
      tag: "LAMBDA",
      elts: [
        { tag: "LIST", elts: indexes.map(param) },
        { tag: name, elts: indexes.map(param) },
        { tag: "LIST", elts: [] },
        { tag: "LIST", elts: indexes.map(() => 0) },
      ],
    };
  }

  static unaryExpr(node) {
    Folder.#visit(node.elts[0]);
    Ast.unaryExpr(Folder.#ctx, node.tag);
  }

  static add(node) {
    Folder.#visit(node.elts[0]);
    Folder.#visit(node.elts[1]);
    Ast.add(Folder.#ctx);
  }

  static sub(node) {
    Folder.#visit(node.elts[0]);
    Folder.#visit(node.elts[1]);
    Ast.sub(Folder.#ctx);
  }

  static mul(node) {
    Folder.#visit(node.elts[0]);
    Folder.#visit(node.elts[1]);
    Ast.mul(Folder.#ctx);
  }

  static div(node) {
    Folder.#visit(node.elts[0]);
    Folder.#visit(node.elts[1]);
    Ast.div(Folder.#ctx);
  }

  static pow(node) {
    Folder.#visit(node.elts[0]);
    Folder.#visit(node.elts[1]);
    Ast.pow(Folder.#ctx);
  }

  static concat(node) {
    Folder.#visit(node.elts[0]);
    Folder.#visit(node.elts[1]);
    Ast.concat(Folder.#ctx, 2);
  }

  static mod(node) {
    Folder.#visit(node.elts[0]);
    Folder.#visit(node.elts[1]);
    Ast.mod(Folder.#ctx);
  }

  static ident(node) {
    const ctx = Folder.#ctx;
    const name = node.elts[0];
    const word = Env.findWord(ctx, name);
    if (word) {
      if (word.cls === "val") {
        if (word.val) {
          Ast.string(ctx, word.val, node.coord); // strip quotes;
        } else if (word.nid) {
          let wrd;
          if ((wrd = Ast.node(ctx, word.nid)).tag === "LAMBDA") {
            const argc = wrd.elts[0].elts.length;
            Ast.apply(ctx, word.nid, argc);
          } else {
            Ast.push(ctx, word.nid);
          }
        } else if (word.name) {
          Ast.push(ctx, node);
        } else {
          // push the original node to be resolved later.
          Ast.push(ctx, node);
        }
      } else if (word.cls === "function") {
        const elts = [];
        const argc = word.arity !== undefined ? word.arity : word.length;
        for (let i = 0; i < argc; i++) {
          const elt = Ast.pop(ctx);
          assertErr(
            ctx,
            elt,
            `Too few arguments for ${word.name}. Expected ${argc}.`,
            node.coord
          );
          elts.push(elt);
        }
        if (word.nid) {
          Ast.foldApply(ctx, word, elts);
        } else {
          Ast.push(ctx, {
            tag: word.name,
            elts,
            coord: node.coord,
          });
          Folder.fold(ctx, Ast.pop(ctx));
        }
      } else {
        assert(false);
      }
    } else {
      assertErr(ctx, false, `Undefined reference '${name}'.`, node.coord);
    }
  }

  static num(node) {
    Ast.number(Folder.#ctx, node.elts[0], node.coord);
  }

  static str(node) {
    Ast.string(Folder.#ctx, node.elts[0], node.coord);
  }

  static bool(node) {
    Ast.bool(Folder.#ctx, node.elts[0]);
  }

  static tag(node) {
    Ast.push(Folder.#ctx, node);
  }

  // A record field. Without this, BINDING fell through to #expr, which pushes
  // the tag name onto the same stack the value then folds on: an unsaturated
  // value ate that name as an argument, and Ast.expr popped a value expression
  // in its place, yielding a node tagged "1" and a discarded RECORD.
  //
  // Fold the value on its own stack, as list/parenExpr do. Applications there
  // draw their arguments from the value alone, so one that is short reports it
  // ("Too few arguments ...") instead of reaching outside the field, and what
  // remains is exactly the field's expressions.
  // A case clause. The pattern is left UNFOLDED: its IDENTs are variables for the compiler
  // to bind, not references to resolve. The value is folded in a scope holding the
  // pattern's variables, as it was parsed -- parse-time scopes are gone by now.
  static ofClause(node) {
    const ctx = Folder.#ctx;
    const [patternNid, valueNid] = node.elts;
    Ast.name(ctx, node.tag, node.coord);
    Env.enterEnv(ctx, "case");
    for (const name of Folder.#patternVars(patternNid)) {
      Env.addWord(ctx, name, { cls: "val", name, nid: 0 });
    }
    Folder.#visit(valueNid);
    Env.exitEnv(ctx);
    Ast.push(ctx, patternNid);
    Ast.expr(ctx, 2, node.coord);
  }

  static #patternVars(nid, names = []) {
    const node = Folder.#nodePool[nid];
    switch (node?.tag) {
    case "IDENT":
      names.push(node.elts[0]);
      break;
    case "LIST":
    case "RECORD":
      node.elts.forEach(elt => Folder.#patternVars(elt, names));
      break;
    case "BINDING":
      Folder.#patternVars(node.elts[1], names);
      break;
    }
    return names;
  }

  static binding(node) {
    const ctx = Folder.#ctx;
    Folder.#visit(node.elts[0]); // key -- a TAG, STR or NUM; pushes one node
    Folder.#pushNodeStack();
    Folder.#visit(node.elts[1]); // value
    const key = Folder.#nodePool[node.elts[0]];
    assertErr(
      ctx,
      ctx.state.nodeStack.length === 1,
      "A record field value must be a single expression.",
      key && key.coord || node.coord,
    );
    Folder.#popNodeStack();
    Ast.binding(ctx);
  }
}

// Keep backward compatibility export
export const folder = {
  fold: Folder.fold
};
