import { Env } from "./env.js";
import { folder } from "./folder.js";
import { assertErr } from "./parse.js";

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

// Helper function not part of the class
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
      if (n.coord) {
        obj.coord = n.coord;
      }
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
  // console.log(
  //   "nodeToJSON()",
  //   "n=" + JSON.stringify(n, null, 2),
  //   "obj=" + JSON.stringify(obj, null, 2),
  // );
  return obj;
}

export class Ast {
  static push(ctx, node) {
    let nid;
    if (typeof node === "number") { // if already interned
      nid = node;
    } else {
      nid = Ast.intern(ctx, node);
    }
    ctx.state.nodeStack.push(nid);
  }

  static topNode(ctx) {
    const nodeStack = ctx.state.nodeStack;
    return nodeStack[nodeStack.length - 1];
  }

  static pop(ctx) {
    const nodeStack = ctx.state.nodeStack;
    return nodeStack.pop();
  }

  static peek(ctx, n) {
    if (n === undefined) {
      n = 0;
    }
    const nodeStack = ctx.state.nodeStack;
    return nodeStack[nodeStack.length - 1 - n];
  }

  static intern(ctx, n) {
    if (!n) {
      return 0;
    }
    const nodeMap = ctx.state.nodeMap;
    const nodePool = ctx.state.nodePool;
    const tag = n.tag;
    const count = n.elts.length;
    const eltsHash = n.elts.reduce((hash, elt, i) => {
      if (typeof elt === "object") {
        n.elts[i] = Ast.intern(ctx, elt);
      }
      return `${hash}#${n.elts[i]}`;
    }, "");
    const coordHash = n.coord && JSON.stringify(n.coord) || "";
    const key = `${tag}#${count}#${eltsHash}###${coordHash}`;
    let nid = nodeMap[key];
    if (nid === undefined) {
      nodePool.push({ tag, elts: n.elts, coord: n.coord });
      nid = nodePool.length - 1;
      nodeMap[key] = nid;
    }
    return nid;
  }

  static node(ctx, nid) {
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
          elts[i] = Ast.node(ctx, n.elts[i]);
        }
        break;
    }
    return {
      tag: n.tag,
      elts,
    };
  }

  static dumpAll(ctx) {
    const nodePool = ctx.state.nodePool;
    let s = "\n{";
    for (let i = 1; i < nodePool.length; i++) {
      const n = nodePool[i];
      s = s + "\n  " + i + ": " + Ast.dump(n) + ",";
    }
    s += "\n  root: " + (nodePool.length - 1);
    s += "\n}\n";
    return s;
  }

  static poolToJSON(ctx) {
    const nodePool = ctx.state.nodePool;
    const obj = {};
    for (let i = 1; i < nodePool.length; i++) {
      const n = nodePool[i];
      obj[i] = nodeToJSON(n);
    }
    obj.root = (nodePool.length - 1);
    return obj;
  }

  static dump(n) {
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
              s += Ast.dump(n.elts[i]);
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

  static foldApply(ctx, fn, args) {
    // Local defs:
    // -- put bindings in env
    // Three cases:
    // -- full application, all args are available at parse time
    // -- partial application, only some args are available at parse time
    // -- late application, args are available at compile time (not parse time)
    //        apply <[x y]: add x y> data..
    //    x: val 0 data
    //    y: val 1 data
    Env.enterEnv(ctx, fn.name);
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
        Env.addWord(ctx, id, word);
      }
      folder.fold(ctx, fn.nid);
      if (outerEnv) {
        Ast.lambda(ctx, {
          lexicon: outerEnv,
          pattern // FIXME need to trim pattern if some args where applied.
        }, Ast.pop(ctx));
      }
    }
    Env.exitEnv(ctx);
  }

  static applyLate(ctx, count) {
    // Ast.applyLate
    const elts = [];
    for (let i = count; i > 0; i--) {
      elts.push(Ast.pop(ctx));
    }
    Ast.push(ctx, {
      tag: "APPLY",
      elts
    });
  }

  static apply(ctx, fnId, argc) {
    // Construct function and apply available arguments.
    const fn = Ast.node(ctx, fnId);
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
      const elt = Ast.pop(ctx);
      elts.unshift(elt); // Get the order right.
    }
    Ast.foldApply(ctx, def, elts);
  }

  // Node constructors

  static error(ctx, str, coord) {
    console.log(
      "error()",
      "str=" + str,
      "coord=" + JSON.stringify(coord),
    );
    const from = coord?.from !== undefined ? coord.from : -1;
    const to = coord?.to !== undefined ? coord.to : -1;
    Ast.number(ctx, to);
    Ast.number(ctx, from);
    Ast.string(ctx, str, coord);
    Ast.push(ctx, {
      tag: "ERROR",
      elts: [
        Ast.pop(ctx),
        Ast.pop(ctx),
        Ast.pop(ctx),
      ],
      coord
    });
  }

  static bool(ctx, val) {
    let b;
    if (val) {
      b = true;
    } else {
      b = false;
    }
    Ast.push(ctx, {
      tag: "BOOL",
      elts: [b]
    });
  }

  static nul(ctx) {
    Ast.push(ctx, {
      tag: "NULL",
      elts: []
    });
  }

  static number(ctx, num, coord) {
    assert(typeof num === "string" || typeof num === "number");
    Ast.push(ctx, {
      tag: "NUM",
      elts: [String(num)],
      coord
    });
  }

  static string(ctx, str, coord) {
    Ast.push(ctx, {
      tag: "STR",
      elts: [str],
      coord
    });
  }

  static name(ctx, name, coord) {
    console.trace(
      "Ast.name()",
      "name=" + name,
      "coord=" + JSON.stringify(coord),
    );
    Ast.push(ctx, {
      tag: "IDENT",
      elts: [name],
      coord
    });
  }

  static expr(ctx, argc, coord) {
    // Ast.expr -- construct a expr node for the compiler.
    const elts = [];
    const pos = 1; // FIXME
    assertErr(ctx, argc <= ctx.state.nodeStack.length - 1, `Too few arguments. Expected ${argc} got ${ctx.state.nodeStack.length - 1}.`, {
      from: pos - 1, to: pos
    });
    while (argc--) {
      const elt = Ast.pop(ctx);
      elts.push(elt);
    }
    const nameId = Ast.pop(ctx);
    assertErr(ctx, nameId, "Ill formed node.");
    const e = Ast.node(ctx, nameId).elts;
    assertErr(ctx, e && e.length > 0, "Ill formed node.");
    const name = e[0];
    Ast.push(ctx, {
      tag: name,
      elts,
      coord,
    });
  }

  static parenExpr(ctx, coord) {
    // Ast.parenExpr
    const elts = [];
    const elt = Ast.pop(ctx);
    elts.push(elt);
    Ast.push(ctx, {
      tag: "PAREN",
      elts,
      coord
    });
  }

  static list(ctx, count, coord, reverse) {
    // Ast.list
    const elts = [];
    for (let i = count; i > 0; i--) {
      const elt = Ast.pop(ctx);
      if (elt !== undefined) {
        elts.push(elt);
      }
    }
    Ast.push(ctx, {
      tag: "LIST",
      elts: reverse ? elts : elts.reverse(),
      coord
    });
  }

  static binaryExpr(ctx, name) {
    const elts = [];
    // args are in the order produced by the parser
    elts.push(Ast.pop(ctx));
    elts.push(Ast.pop(ctx));
    Ast.push(ctx, {
      tag: name,
      elts: elts.reverse()
    });
  }

  static unaryExpr(ctx, name) {
    const elts = [];
    elts.push(Ast.pop(ctx));
    Ast.push(ctx, {
      tag: name,
      elts
    });
  }

  static prefixExpr(ctx, name) {
    const elts = [];
    elts.push(Ast.pop(ctx));
    Ast.push(ctx, {
      tag: name,
      elts
    });
  }

  static neg(ctx) {
    const v1 = +Ast.node(ctx, Ast.pop(ctx)).elts[0];
    Ast.number(ctx, -1 * v1);
  }

  static add(ctx, coord) {
    const n2 = Ast.node(ctx, Ast.pop(ctx));
    const n1 = Ast.node(ctx, Ast.pop(ctx));
    const v2 = n2.elts[0];
    const v1 = n1.elts[0];
    if (n1.tag !== "NUM" || n2.tag !== "NUM") {
      Ast.push(ctx, {
        tag: "ADD",
        elts: [n1, n2],
        coord
      });
    } else {
      Ast.number(ctx, +v1 + +v2);
    }
  }

  static sub(ctx) {
    const n2 = Ast.node(ctx, Ast.pop(ctx));
    const n1 = Ast.node(ctx, Ast.pop(ctx));
    const v2 = n2.elts[0];
    const v1 = n1.elts[0];
    if (n1.tag !== "NUM" || n2.tag !== "NUM") {
      Ast.push(ctx, { tag: "SUB", elts: [n1, n2] });
    } else {
      Ast.number(ctx, +v1 - +v2);
    }
  }

  // static mul(ctx) {
  //   let n2 = Ast.node(ctx, Ast.pop(ctx));
  //   let n1 = Ast.node(ctx, Ast.pop(ctx));
  //   const v2 = n2.elts[0];
  //   const v1 = n1.elts[0];
  //   if (n1.tag === undefined) {
  //     n1 = n1.elts[0];
  //   }
  //   if (n2.tag === undefined) {
  //     n2 = n2.elts[0];
  //   }
  //   if (n1.tag !== "NUM" || n2.tag !== "NUM") {
  //     Ast.push(ctx, { tag: "MUL", elts: [n2, n1] });
  //   } else {
  //     Ast.number(ctx, +v1 * +v2);
  //   }
  // }

  static div(ctx) {
    const n2 = Ast.node(ctx, Ast.pop(ctx));
    const n1 = Ast.node(ctx, Ast.pop(ctx));
    const v2 = n2.elts[0];
    const v1 = n1.elts[0];
    if (n1.tag !== "NUM" || n2.tag !== "NUM") {
      Ast.push(ctx, { tag: "DIV", elts: [n1, n2] });
    } else {
      Ast.number(ctx, +v1 / +v2);
    }
  }

  static mod(ctx) {
    const n2 = Ast.node(ctx, Ast.pop(ctx));
    const n1 = Ast.node(ctx, Ast.pop(ctx));
    const v1 = n1.elts[0];
    const v2 = n2.elts[0];
    if (n1.tag !== "NUM" || n2.tag !== "NUM") {
      Ast.push(ctx, { tag: "MOD", elts: [n1, n2] });
    } else {
      Ast.number(ctx, +v1 % +v2);
    }
  }

  static pow(ctx) {
    const n2 = Ast.node(ctx, Ast.pop(ctx));
    const n1 = Ast.node(ctx, Ast.pop(ctx));
    const v2 = n2.elts[0];
    const v1 = n1.elts[0];
    if (n1.tag !== "NUM" || n2.tag !== "NUM") {
      Ast.push(ctx, { tag: "POW", elts: [n1, n2] });
    } else {
      Ast.number(ctx, Math.pow(+v1, +v2));
    }
  }

  static concat(ctx) {
    const n1 = Ast.node(ctx, Ast.pop(ctx));
    Ast.push(ctx, {
      tag: "CONCAT",
      elts: [n1]
    });
  }

  static eq(ctx) {
    const v2 = Ast.node(ctx, Ast.pop(ctx)).elts[0];
    const v1 = Ast.node(ctx, Ast.pop(ctx)).elts[0];
    Ast.bool(ctx, v1 === v2);
  }

  static ne(ctx) {
    const v2 = +Ast.node(ctx, Ast.pop(ctx)).elts[0];
    const v1 = +Ast.node(ctx, Ast.pop(ctx)).elts[0];
    Ast.bool(ctx, v1 !== v2);
  }

  static lt(ctx) {
    const v2 = +Ast.node(ctx, Ast.pop(ctx)).elts[0];
    const v1 = +Ast.node(ctx, Ast.pop(ctx)).elts[0];
    Ast.bool(ctx, v1 < v2);
  }

  static gt(ctx) {
    const v2 = +Ast.node(ctx, Ast.pop(ctx)).elts[0];
    const v1 = +Ast.node(ctx, Ast.pop(ctx)).elts[0];
    Ast.bool(ctx, v1 > v2);
  }

  static le(ctx) {
    const v2 = +Ast.node(ctx, Ast.pop(ctx)).elts[0];
    const v1 = +Ast.node(ctx, Ast.pop(ctx)).elts[0];
    Ast.bool(ctx, v1 <= v2);
  }

  static ge(ctx) {
    const v2 = +Ast.node(ctx, Ast.pop(ctx)).elts[0];
    const v1 = +Ast.node(ctx, Ast.pop(ctx)).elts[0];
    Ast.bool(ctx, v1 >= v2);
  }

  static ifExpr(ctx) {
    const elts = [];
    elts.push(Ast.pop(ctx)); // if
    elts.push(Ast.pop(ctx)); // then
    elts.push(Ast.pop(ctx)); // else
    Ast.push(ctx, { tag: "IF", elts: elts.reverse() });
  }

  static caseExpr(ctx, n) {
    const elts = [];
    elts.push(Ast.pop(ctx)); // val
    for (let i = n; i > 0; i--) {
      elts.push(Ast.pop(ctx)); // of
    }
    Ast.push(ctx, { tag: "CASE", elts: elts.reverse() });
  }

  static ofClause(ctx) {
    const elts = [];
    elts.push(Ast.pop(ctx));
    elts.push(Ast.pop(ctx));
    Ast.push(ctx, { tag: "OF", elts: elts.reverse() });
  }

  static record(ctx) {
    // Ast.record
    const count = ctx.state.exprc;
    const elts = [];
    for (let i = count; i > 0; i--) {
      const elt = Ast.pop(ctx);
      if (elt !== undefined) {
        elts.push(elt);
      }
    }
    Ast.push(ctx, {
      tag: "RECORD",
      elts
    });
  }

  static binding(ctx) {
    // Ast.binding
    const elts = [];
    elts.push(Ast.pop(ctx));
    elts.push(Ast.pop(ctx));
    Ast.push(ctx, {
      tag: "BINDING",
      elts: elts.reverse()
    });
  }

  static lambda(ctx, env, nid) {
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
    Ast.push(ctx, {
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

  static exprs(ctx, count, inReverse) {
    let elts = [];
    assert(ctx.state.nodeStack.length >= count, `exprs() need ${count} args, got ${ctx.state.nodeStack.length}`);
    if (inReverse) {
      for (let i = count; i > 0; i--) {
        const elt = Ast.pop(ctx);
        elts.push(elt); // Reverse order.
      }
    } else {
      for (let i = count; i > 0; i--) {
        const elt = Ast.pop(ctx);
        elts.push(elt); // Reverse order.
      }
      elts = elts.reverse();
    }
    Ast.push(ctx, {
      tag: "EXPRS",
      elts
    });
  }

  static letDef(ctx) {
    // Clean up stack and produce initializer.
    Ast.pop(ctx); // body
    Ast.pop(ctx); // name
    for (let i = 0; i < ctx.state.paramc; i++) {
      Ast.pop(ctx); // params
    }
    ctx.state.exprc--; // don't count as expr.
  }

  static program(ctx) {
    const elts = [];
    elts.push(Ast.pop(ctx));
    Ast.push(ctx, {
      tag: "PROG",
      elts
    });
  }
}
