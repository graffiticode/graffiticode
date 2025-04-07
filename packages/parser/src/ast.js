import { env } from "./env.js";
import { folder } from "./fold.js";
import { assertErr } from "./parse.js";

export const Ast = (function () {
  const ASSERT = true;
  const assert = function (val, str) {
    if (!ASSERT) {
      return;
    }
    if (str === undefined) {
      str = "failed!";
    }
    if (!val) {
      throw new Error(str);
    }
  };

  const AstClass = function () { };

  AstClass.prototype = {
    intern,
    node,
    dump,
    dumpAll,
    poolToJSON,
    number,
    string,
    name,
    apply,
    fold,
    expr,
    binaryExpr,
    unaryExpr,
    parenExpr,
    prefixExpr,
    lambda,
    applyLate,
    letDef,
    ifExpr,
    caseExpr,
    ofClause,
    record,
    binding,
    exprs,
    program,
    pop,
    topNode,
    peek,
    push,
    mod,
    add,
    sub,
    //    mul,
    div,
    pow,
    concat,
    eq,
    ne,
    lt,
    gt,
    le,
    ge,
    neg,
    list,
    bool,
    nul,
    error,
  };

  return new AstClass();

  // private implementation

  function push(ctx, node) {
    let nid;
    if (typeof node === "number") { // if already interned
      nid = node;
    } else {
      nid = intern(ctx, node);
    }
    ctx.state.nodeStack.push(nid);
  }

  function topNode(ctx) {
    const nodeStack = ctx.state.nodeStack;
    return nodeStack[nodeStack.length - 1];
  }

  function pop(ctx) {
    const nodeStack = ctx.state.nodeStack;
    return nodeStack.pop();
  }

  function peek(ctx, n) {
    if (n === undefined) {
      n = 0;
    }
    const nodeStack = ctx.state.nodeStack;
    return nodeStack[nodeStack.length - 1 - n];
  }

  function intern(ctx, n) {
    if (!n) {
      return 0;
    }
    const nodeMap = ctx.state.nodeMap;
    const nodePool = ctx.state.nodePool;
    const tag = n.tag;
    let elts = "";
    const count = n.elts.length;
    for (let i = 0; i < count; i++) {
      if (typeof n.elts[i] === "object") {
        n.elts[i] = intern(ctx, n.elts[i]);
      }
      elts += n.elts[i];
    }
    const key = tag + count + elts;
    let nid = nodeMap[key];
    if (nid === undefined) {
      nodePool.push({ tag, elts: n.elts });
      nid = nodePool.length - 1;
      nodeMap[key] = nid;
      if (n.coord) {
        ctx.state.coords[nid] = n.coord;
      }
    }
    return nid;
  }

  function node(ctx, nid) {
    const n = ctx.state.nodePool[nid];
    if (!nid) {
      return null;
    } else if (!n) {
      return {};
    }
    const elts = [];
    switch (n.tag) {
      case "NULL":
        break;
      case "NUM":
      case "STR":
      case "IDENT":
      case "BOOL":
        elts[0] = n.elts[0];
        break;
      default:
        for (let i = 0; i < n.elts.length; i++) {
          elts[i] = node(ctx, n.elts[i]);
        }
        break;
    }
    return {
      tag: n.tag,
      elts,
    };
  }

  function dumpAll(ctx) {
    const nodePool = ctx.state.nodePool;
    let s = "\n{";
    for (let i = 1; i < nodePool.length; i++) {
      const n = nodePool[i];
      s = s + "\n  " + i + ": " + dump(n) + ",";
    }
    s += "\n  root: " + (nodePool.length - 1);
    s += "\n}\n";
    return s;
  }

  function poolToJSON(ctx) {
    const nodePool = ctx.state.nodePool;
    const obj = {};
    for (let i = 1; i < nodePool.length; i++) {
      const n = nodePool[i];
      obj[i] = nodeToJSON(n);
    }
    obj.root = (nodePool.length - 1);
    return obj;
  }

  function nodeToJSON(n) {
    let obj;
    if (typeof n === "object") {
      switch (n.tag) {
        case "num":
          obj = n.elts[0];
          break;
        case "str":
          obj = n.elts[0];
          break;
        default:
          obj = {};
          obj.tag = n.tag;
          obj.elts = [];
          for (let i = 0; i < n.elts.length; i++) {
            obj.elts[i] = nodeToJSON(n.elts[i]);
          }
          break;
      }
    } else if (typeof n === "string") {
      obj = n;
    } else {
      obj = n;
    }
    return obj;
  }

  function dump(n) {
    let s;
    if (typeof n === "object") {
      switch (n.tag) {
        case "num":
          s = n.elts[0];
          break;
        case "str":
          s = "\"" + n.elts[0] + "\"";
          break;
        default:
          if (!n.elts) {
            s += "<invalid>";
          } else {
            s = "{ tag: \"" + n.tag + "\", elts: [ ";
            for (let i = 0; i < n.elts.length; i++) {
              if (i > 0) {
                s += " , ";
              }
              s += dump(n.elts[i]);
            }
            s += " ] }";
          }
          break;
      }
    } else if (typeof n === "string") {
      s = "\"" + n + "\"";
    } else {
      s = n;
    }
    return s;
  }

  function fold(ctx, fn, args) {
    // Local defs:
    // -- put bindings in env
    // Three cases:
    // -- full application, all args are available at parse time
    // -- partial application, only some args are available at parse time
    // -- late application, args are available at compile time (not parse time)
    //        apply <[x y]: add x y> data..
    //    x: val 0 data
    //    y: val 1 data
    env.enterEnv(ctx, fn.name);
    if (fn.env) {
      const lexicon = fn.env.lexicon;
      const pattern = Ast.node(ctx, fn.env.pattern);
      let outerEnv = null;
      // let isListPattern;
      // setup inner environment record (lexicon)
      if (pattern && pattern.elts &&
          pattern.elts.length === 1 &&
          pattern.elts[0].tag === "LIST") {
        // For now we only support one pattern per param list.
        // isListPattern = true;
      }
      for (const id in lexicon) {
        // For each parameter, get its definition assign the value of the argument
        // used on the current function application.
        if (!id) continue;
        const word = JSON.parse(JSON.stringify(lexicon[id])); // poor man's copy.
        const index = args.length - word.offset - 1;
        // TODO we currently ignore list patterns
        // if (isListPattern) {
        //   // <[x y]: ...> foo..
        //   word.nid = Ast.intern(ctx, {
        //     tag: "VAL",
        //     elts: [{
        //       tag: "NUM",
        //       elts: [
        //         String(word.offset),
        //       ]}, {
        //         tag: "ARG",
        //         elts: [{
        //           tag: "NUM",
        //           elts: ["0"]
        //         }]
        //       }]
        //   });
        // } else
        if (index >= 0 && index < args.length) {
          word.nid = args[index];
        }
        if (index < 0) {
          // We've got an unbound variable or a variable with a default value,
          // so add it to the new variable list.
          // <x:x> => <x:x>
          // (<x y: add x y> 10) => <y: add 10 y>
          // (<y: let x = 10.. add x y>) => <y: add 10 y>
          if (!outerEnv) {
            outerEnv = {};
          }
          outerEnv[id] = word;
        }
        env.addWord(ctx, id, word);
      }
      folder.fold(ctx, fn.nid);
      if (outerEnv) {
        lambda(ctx, {
          lexicon: outerEnv,
          pattern // FIXME need to trim pattern if some args where applied.
        }, pop(ctx));
      }
    }
    env.exitEnv(ctx);
  }

  function applyLate(ctx, count) {
    // Ast.applyLate
    const elts = [];
    for (let i = count; i > 0; i--) {
      elts.push(pop(ctx));
    }
    push(ctx, {
      tag: "APPLY",
      elts
    });
  }

  function apply(ctx, fnId, argc) {
    // Construct function and apply available arguments.
    const fn = node(ctx, fnId);
    // if (fn.tag !== "LAMBDA") {
    //   // Construct an APPLY node for compiling later.
    //   return {
    //     tag: "APPLY",
    //     elts: [
    //       fnId,
    //     ]
    //   };
    // }
    // Construct a lexicon
    const lexicon = {};
    let paramc = 0;
    fn.elts[0].elts.forEach(function (n, i) {
      const name = n.elts[0];
      const nid = Ast.intern(ctx, fn.elts[3].elts[i]);
      lexicon[name] = {
        cls: "val",
        name,
        offset: i,
        nid
      };
      if (!nid) {
        // Parameters don't have nids.
        // assert that there are parameters after a binding without a nid.
        paramc++;
      }
    });
    const def = {
      name: "lambda",
      nid: Ast.intern(ctx, fn.elts[1]),
      env: {
        lexicon,
        pattern: Ast.intern(ctx, fn.elts[2])
      }
    };
    const elts = [];
    // While there are args on the stack, pop them.
    while (argc-- > 0 && paramc-- > 0) {
      const elt = pop(ctx);
      elts.unshift(elt); // Get the order right.
    }
    fold(ctx, def, elts);
  }

  // Node constructors

  function error(ctx, str, coord) {
    console.log(
      "error()",
      "str=" + str,
      "coord=" + JSON.stringify(coord),
    );
    const from = coord?.from !== undefined ? coord.from : -1;
    const to = coord?.to !== undefined ? coord.to : -1;
    number(ctx, to);
    number(ctx, from);
    string(ctx, str, coord);
    push(ctx, {
      tag: "ERROR",
      elts: [
        pop(ctx),
        pop(ctx),
        pop(ctx),
      ],
      coord
    });
  }

  function bool(ctx, val) {
    let b;
    if (val) {
      b = true;
    } else {
      b = false;
    }
    push(ctx, {
      tag: "BOOL",
      elts: [b]
    });
  }

  function nul(ctx) {
    push(ctx, {
      tag: "NULL",
      elts: []
    });
  }

  function number(ctx, num, coord) {
    assert(typeof num === "string" || typeof num === "number");
    push(ctx, {
      tag: "NUM",
      elts: [String(num)],
      coord
    });
  }

  function string(ctx, str, coord) {
    push(ctx, {
      tag: "STR",
      elts: [str],
      coord
    });
  }

  function name(ctx, name, coord) {
    push(ctx, {
      tag: "IDENT",
      elts: [name],
      coord
    });
  }

  function expr(ctx, argc) {
    // Ast.expr -- construct a expr node for the compiler.
    const elts = [];
    const pos = 1; // FIXME
    console.trace(
      "expr()",
      "argc=" + argc,
      "nodeStack=" + JSON.stringify(ctx.state.nodeStack, null, 2),
    );
    assertErr(ctx, argc <= ctx.state.nodeStack.length - 1, `Too few arguments. Expected ${argc} got ${ctx.state.nodeStack.length - 1}.`, {
      from: pos - 1, to: pos
    });
    while (argc--) {
      const elt = pop(ctx);
      elts.push(elt);
    }
    const nameId = pop(ctx);
    console.log(
      "expr()",
      "nameId=" + nameId,
    );
    assertErr(ctx, nameId, "Ill formed node.");
    const e = node(ctx, nameId).elts;
    assertErr(ctx, e && e.length > 0, "Ill formed node.");
    const name = e[0];
    push(ctx, {
      tag: name,
      elts,
    });
  }

  function parenExpr(ctx, coord) {
    // Ast.parenExpr
    const elts = [];
    const elt = pop(ctx);
    elts.push(elt);
    push(ctx, {
      tag: "PAREN",
      elts,
      coord
    });
  }

  function list(ctx, count, coord, reverse) {
    // Ast.list
    const elts = [];
    for (let i = count; i > 0; i--) {
      const elt = pop(ctx);
      if (elt !== undefined) {
        elts.push(elt);
      }
    }
    push(ctx, {
      tag: "LIST",
      elts: reverse ? elts : elts.reverse(),
      coord
    });
  }

  function binaryExpr(ctx, name) {
    const elts = [];
    // args are in the order produced by the parser
    elts.push(pop(ctx));
    elts.push(pop(ctx));
    push(ctx, {
      tag: name,
      elts: elts.reverse()
    });
  }
  function unaryExpr(ctx, name) {
    const elts = [];
    elts.push(pop(ctx));
    push(ctx, {
      tag: name,
      elts
    });
  }

  function prefixExpr(ctx, name) {
    const elts = [];
    elts.push(pop(ctx));
    push(ctx, {
      tag: name,
      elts
    });
  }

  function neg(ctx) {
    const v1 = +node(ctx, pop(ctx)).elts[0];
    number(ctx, -1 * v1);
  }

  function add(ctx, coord) {
    const n2 = node(ctx, pop(ctx));
    const n1 = node(ctx, pop(ctx));
    const v2 = n2.elts[0];
    const v1 = n1.elts[0];
    if (n1.tag !== "NUM" || n2.tag !== "NUM") {
      push(ctx, {
        tag: "ADD",
        elts: [n1, n2],
        coord
      });
    } else {
      number(ctx, +v1 + +v2);
    }
  }

  function sub(ctx) {
    const n2 = node(ctx, pop(ctx));
    const n1 = node(ctx, pop(ctx));
    const v2 = n2.elts[0];
    const v1 = n1.elts[0];
    if (n1.tag !== "NUM" || n2.tag !== "NUM") {
      push(ctx, { tag: "SUB", elts: [n1, n2] });
    } else {
      number(ctx, +v1 - +v2);
    }
  }

  // function mul(ctx) {
  //   let n2 = node(ctx, pop(ctx));
  //   let n1 = node(ctx, pop(ctx));
  //   const v2 = n2.elts[0];
  //   const v1 = n1.elts[0];
  //   if (n1.tag === undefined) {
  //     n1 = n1.elts[0];
  //   }
  //   if (n2.tag === undefined) {
  //     n2 = n2.elts[0];
  //   }
  //   if (n1.tag !== "NUM" || n2.tag !== "NUM") {
  //     push(ctx, { tag: "MUL", elts: [n2, n1] });
  //   } else {
  //     number(ctx, +v1 * +v2);
  //   }
  // }

  function div(ctx) {
    const n2 = node(ctx, pop(ctx));
    const n1 = node(ctx, pop(ctx));
    const v2 = n2.elts[0];
    const v1 = n1.elts[0];
    if (n1.tag !== "NUM" || n2.tag !== "NUM") {
      push(ctx, { tag: "DIV", elts: [n1, n2] });
    } else {
      number(ctx, +v1 / +v2);
    }
  }

  function mod(ctx) {
    const n2 = node(ctx, pop(ctx));
    const n1 = node(ctx, pop(ctx));
    const v1 = n1.elts[0];
    const v2 = n2.elts[0];
    if (n1.tag !== "NUM" || n2.tag !== "NUM") {
      push(ctx, { tag: "MOD", elts: [n1, n2] });
    } else {
      number(ctx, +v1 % +v2);
    }
  }

  function pow(ctx) {
    const n2 = node(ctx, pop(ctx));
    const n1 = node(ctx, pop(ctx));
    const v2 = n2.elts[0];
    const v1 = n1.elts[0];
    if (n1.tag !== "NUM" || n2.tag !== "NUM") {
      push(ctx, { tag: "POW", elts: [n1, n2] });
    } else {
      number(ctx, Math.pow(+v1, +v2));
    }
  }

  function concat(ctx) {
    const n1 = node(ctx, pop(ctx));
    push(ctx, {
      tag: "CONCAT",
      elts: [n1]
    });
  }

  function eq(ctx) {
    const v2 = node(ctx, pop(ctx)).elts[0];
    const v1 = node(ctx, pop(ctx)).elts[0];
    bool(ctx, v1 === v2);
  }

  function ne(ctx) {
    const v2 = +node(ctx, pop(ctx)).elts[0];
    const v1 = +node(ctx, pop(ctx)).elts[0];
    bool(ctx, v1 !== v2);
  }

  function lt(ctx) {
    const v2 = +node(ctx, pop(ctx)).elts[0];
    const v1 = +node(ctx, pop(ctx)).elts[0];
    bool(ctx, v1 < v2);
  }

  function gt(ctx) {
    const v2 = +node(ctx, pop(ctx)).elts[0];
    const v1 = +node(ctx, pop(ctx)).elts[0];
    bool(ctx, v1 > v2);
  }

  function le(ctx) {
    const v2 = +node(ctx, pop(ctx)).elts[0];
    const v1 = +node(ctx, pop(ctx)).elts[0];
    bool(ctx, v1 <= v2);
  }
  function ge(ctx) {
    const v2 = +node(ctx, pop(ctx)).elts[0];
    const v1 = +node(ctx, pop(ctx)).elts[0];
    bool(ctx, v1 >= v2);
  }
  function ifExpr(ctx) {
    const elts = [];
    elts.push(pop(ctx)); // if
    elts.push(pop(ctx)); // then
    elts.push(pop(ctx)); // else
    push(ctx, { tag: "IF", elts: elts.reverse() });
  }
  function caseExpr(ctx, n) {
    const elts = [];
    elts.push(pop(ctx)); // val
    for (let i = n; i > 0; i--) {
      elts.push(pop(ctx)); // of
    }
    push(ctx, { tag: "CASE", elts: elts.reverse() });
  }
  function ofClause(ctx) {
    const elts = [];
    elts.push(pop(ctx));
    elts.push(pop(ctx));
    push(ctx, { tag: "OF", elts: elts.reverse() });
  }

  function record(ctx) {
    // Ast.record
    const count = ctx.state.exprc;
    const elts = [];
    for (let i = count; i > 0; i--) {
      const elt = pop(ctx);
      if (elt !== undefined) {
        elts.push(elt);
      }
    }
    push(ctx, {
      tag: "RECORD",
      elts
    });
  }

  function binding(ctx) {
    // Ast.binding
    const elts = [];
    elts.push(pop(ctx));
    elts.push(pop(ctx));
    push(ctx, {
      tag: "BINDING",
      elts: elts.reverse()
    });
  }

  function lambda(ctx, env, nid) {
    // Ast.lambda
    const names = [];
    const nids = [];
    for (const id in env.lexicon) {
      const word = env.lexicon[id];
      names.push({
        tag: "IDENT",
        elts: [word.name],
      });
      nids.push(word.nid || 0);
    }
    const pattern = env.pattern;
    push(ctx, {
      tag: "LAMBDA",
      elts: [{
        tag: "LIST",
        elts: names
      }, nid, {
        tag: "LIST",
        elts: pattern
      }, {
        tag: "LIST",
        elts: nids
      }]
    });
  }

  function exprs(ctx, count, inReverse) {
    // Ast.exprs
    let elts = [];
    assert(ctx.state.nodeStack.length >= count);
    if (inReverse) {
      for (let i = count; i > 0; i--) {
        const elt = pop(ctx);
        elts.push(elt); // Reverse order.
      }
    } else {
      for (let i = count; i > 0; i--) {
        const elt = pop(ctx);
        elts.push(elt); // Reverse order.
      }
      elts = elts.reverse();
    }
    push(ctx, {
      tag: "EXPRS",
      elts
    });
  }

  function letDef(ctx) {
    // Clean up stack and produce initializer.
    pop(ctx); // body
    pop(ctx); // name
    for (let i = 0; i < ctx.state.paramc; i++) {
      pop(ctx); // params
    }
    ctx.state.exprc--; // don't count as expr.
  }

  function program(ctx) {
    const elts = [];
    elts.push(pop(ctx));
    push(ctx, {
      tag: "PROG",
      elts
    });
  }
})();
