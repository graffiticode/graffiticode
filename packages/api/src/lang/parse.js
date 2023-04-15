// Copyright 2021, ARTCOMPILER INC

let CodeMirror;
if (typeof CodeMirror === "undefined") {
  CodeMirror = {
    Pos: function () {
      return {};
    }
  };
}

let window;
if (typeof window === "undefined") {
  window = {};
  window = {
    gcexports: {
      coords: {},
      errors: []
    },
    isSynthetic: true
  };
}

function assert(b, str) {
  if (!b) throw str;
}

// ast module

const Ast = (function () {
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
    //    mul: mul,
    div,
    pow,
    concat,
    orelse,
    andalso,
    eq,
    ne,
    lt,
    gt,
    le,
    ge,
    neg,
    list,
    bool,
    nul
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
      coord: getCoord(ctx)
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
    const obj = { };
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

  function number(ctx, str, coord) {
    assert(typeof str === "string" || typeof str === "number");
    push(ctx, {
      tag: "NUM",
      elts: [String(str)],
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
    while (argc--) {
      const elt = pop(ctx);
      elts.push(elt);
    }
    const nameId = pop(ctx);
    assert(nameId, "Ill formed node.");
    const e = node(ctx, nameId).elts;
    assert(e && e.length > 0, "Ill formed node.");
    const name = e[0];
    push(ctx, {
      tag: name,
      elts,
      coord: getCoord(ctx)
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

  function orelse(ctx) {
    // const v2 = +node(ctx, pop(ctx)).elts[0];
    // const v1 = +node(ctx, pop(ctx)).elts[0];
    throw new Error("not implemented");
  }

  function andalso(ctx) {
    // const v2 = +node(ctx, pop(ctx)).elts[0];
    // const v1 = +node(ctx, pop(ctx)).elts[0];
    throw new Error("not implemented");
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
  function caseExpr(ctx, n) {
    const elts = [];
    for (let i = n; i > 0; i--) {
      elts.push(pop(ctx)); // of
    }
    elts.push(pop(ctx)); // exprs
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
        coord: getCoord(ctx)
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

// The following code for StreamString was copied from CodeMirror.

const StringStream = (function () {
  // The character stream used by a mode's parser.
  function StringStream(string, tabSize) {
    this.pos = this.start = 0;
    this.string = string;
    this.tabSize = tabSize || 8;
  }

  StringStream.prototype = {
    eol: function () { return this.pos >= this.string.length; },
    sol: function () { return this.pos === 0; },
    peek: function () { return this.string.charAt(this.pos) || undefined; },
    next: function () {
      if (this.pos < this.string.length) { return this.string.charAt(this.pos++); }
    },
    eat: function (match) {
      const ch = this.string.charAt(this.pos);
      let ok;
      if (typeof match === "string") {
        ok = ch === match;
      } else {
        ok = ch && (match.test ? match.test(ch) : match(ch));
      }
      if (ok) { ++this.pos; return ch; }
    },
    eatWhile: function (match) {
      const start = this.pos;
      while (this.eat(match));
      return this.pos > start;
    },
    eatSpace: function () {
      const start = this.pos;
      while (/[\s\u00a0]/.test(this.string.charAt(this.pos))) ++this.pos;
      return this.pos > start;
    },
    skipToEnd: function () { this.pos = this.string.length; },
    skipTo: function (ch) {
      const found = this.string.indexOf(ch, this.pos);
      if (found > -1) { this.pos = found; return true; }
    },
    backUp: function (n) { this.pos -= n; },
    match: function (pattern, consume, caseInsensitive) {
      if (typeof pattern === "string") {
        const cased = function (str) { return caseInsensitive ? str.toLowerCase() : str; };
        if (cased(this.string).indexOf(cased(pattern), this.pos) === this.pos) {
          if (consume !== false) this.pos += pattern.length;
          return true;
        }
      } else {
        const match = this.string.slice(this.pos).match(pattern);
        if (match && match.index > 0) return null;
        if (match && consume !== false) this.pos += match[0].length;
        return match;
      }
    },
    current: function () { return this.string.slice(this.start, this.pos); }
  };

  return StringStream;
})();

// env

const env = (function () {
  return {
    findWord,
    addWord,
    enterEnv,
    exitEnv,
    addPattern
  };

  // private functions

  function findWord(ctx, lexeme) {
    const env = ctx.state.env;
    for (let i = env.length - 1; i >= 0; i--) {
      const word = env[i].lexicon[lexeme];
      if (word) {
        return word;
      }
    }
    return null;
  }

  function addWord(ctx, lexeme, entry) {
    window.gcexports.topEnv(ctx).lexicon[lexeme] = entry;
    return null;
  }

  function addPattern(ctx, pattern) {
    window.gcexports.topEnv(ctx).pattern.push(pattern);
  }

  function enterEnv(ctx, name) {
    // recursion guard
    if (ctx.state.env.length > 380) {
      // return;  // just stop recursing
      throw new Error("runaway recursion");
    }
    window.gcexports.topEnv(ctx).paramc = ctx.state.paramc;
    ctx.state.env.push({
      name,
      lexicon: {},
      pattern: []
    });
  }

  function exitEnv(ctx) {
    ctx.state.env.pop();
    ctx.state.paramc = window.gcexports.topEnv(ctx).paramc;
  }
})();

let scanTime = 0;
let scanCount = 0;
window.gcexports.scanTime = function () {
  return scanTime;
};
window.gcexports.scanCount = function () {
  return scanCount;
};

let parseTime = 0;

window.gcexports.parseTime = function () {
  return parseTime;
};

let parseCount = 0;
window.gcexports.parseCount = function () {
  return parseCount;
};

function getCoord(ctx) {
  const ln = ctx.scan.stream.lineOracle && ctx.scan.stream.lineOracle.line || 0;
  return {
    from: CodeMirror.Pos(ln, ctx.scan.stream.start),
    to: CodeMirror.Pos(ln, ctx.scan.stream.pos)
  };
}

export const parse = (function () {
  function assert(b, str) {
    if (!b) {
      throw new Error(str);
    }
  }

  const keywords = window.gcexports.keywords = {
    let: { tk: 0x12, cls: "keyword" },
    if: { tk: 0x05, cls: "keyword" },
    then: { tk: 0x06, cls: "keyword" },
    else: { tk: 0x07, cls: "keyword" },
    case: { tk: 0x0F, cls: "keyword" },
    of: { tk: 0x10, cls: "keyword" },
    end: { tk: 0x11, cls: "keyword", length: 0 },
    true: { tk: 0x14, cls: "val", length: 0 },
    false: { tk: 0x14, cls: "val", length: 0 },
    null: { tk: 0x15, cls: "val", length: 0 },
    val: { tk: 1, name: "VAL", cls: "function", length: 2, arity: 2 },
    key: { tk: 1, name: "KEY", cls: "function", length: 2, arity: 2 },
    len: { tk: 1, name: "LEN", cls: "function", length: 1, arity: 1 },
    concat: { tk: 1, name: "CONCAT", cls: "function", length: 1, arity: 1 },
    add: { tk: 1, name: "ADD", cls: "function", length: 2, arity: 2 },
    mul: { tk: 1, name: "MUL", cls: "function", length: 2, arity: 2 },
    pow: { tk: 1, name: "POW", cls: "function", length: 2, arity: 2 },
    style: { tk: 1, name: "STYLE", cls: "function", length: 2, arity: 2 },
    map: { tk: 1, name: "MAP", cls: "function", length: 2, arity: 2 },
    apply: { tk: 1, name: "APPLY", cls: "function", length: 2, arity: 2 },
    in: { tk: 1, name: "IN", cls: "function", length: 0, arity: 0 },
    arg: { tk: 1, name: "ARG", cls: "function", length: 1, arity: 1 },
    data: { tk: 1, name: "DATA", cls: "function", length: 1, arity: 1 }
  };

  function addError(ctx, str) {
    const ln = ctx.scan.stream.lineOracle && ctx.scan.stream.lineOracle.line || 0;
    window.gcexports.errors.push({
      from: CodeMirror.Pos(ln, ctx.scan.stream.start),
      to: CodeMirror.Pos(ln, ctx.scan.stream.pos),
      message: str,
      severity: "error"
    });
  }

  const CC_DOUBLEQUOTE = 0x22;
  const CC_DOLLAR = 0x24;
  const CC_SINGLEQUOTE = 0x27;
  const CC_BACKTICK = 0x60;
  const CC_LEFTBRACE = 0x7B;
  // const CC_RIGHTBRACE = 0x7D;

  const TK_IDENT = 0x01;
  const TK_NUM = 0x02;
  const TK_STR = 0x03;
  const TK_EQUAL = 0x04;
  const TK_IF = 0x05;
  const TK_THEN = 0x06;
  const TK_ELSE = 0x07;
  const TK_RETURN = 0x08;
  const TK_IS = 0x09;
  const TK_POSTOP = 0x0A;
  const TK_PREOP = 0x0B;
  const TK_FUN = 0x0C;
  const TK_VAL = 0x0D;
  const TK_BINOP = 0x0E;
  const TK_CASE = 0x0F;
  const TK_OF = 0x10;
  const TK_END = 0x11;
  const TK_LET = 0x12;
  const TK_OR = 0x13;
  const TK_BOOL = 0x14;
  const TK_NULL = 0x15;
  // const TK_IN = 0x16;

  const TK_LEFTPAREN = 0xA1;
  const TK_RIGHTPAREN = 0xA2;
  const TK_LEFTBRACKET = 0xA3;
  const TK_RIGHTBRACKET = 0xA4;
  const TK_LEFTBRACE = 0xA5;
  const TK_RIGHTBRACE = 0xA6;
  const TK_PLUS = 0xA7;
  const TK_MINUS = 0xA8;
  const TK_DOT = 0xA9;
  const TK_COLON = 0xAA;
  const TK_COMMA = 0xAB;
  const TK_BACKQUOTE = 0xAC;
  const TK_COMMENT = 0xAD;
  const TK_LEFTANGLE = 0xAE;
  const TK_RIGHTANGLE = 0xAF;
  // const TK_DOUBLELEFTBRACE = 0xB0;
  // const TK_DOUBLERIGHTBRACE = 0xB1;
  const TK_STRPREFIX = 0xB2;
  const TK_STRMIDDLE = 0xB3;
  const TK_STRSUFFIX = 0xB4;

  function tokenToLexeme(tk) {
    switch (tk) {
      case TK_EQUAL: return "a '=' symbol";
      case TK_IF: return "the 'if' keyword";
      case TK_THEN: return "the 'then' keyword";
      case TK_ELSE: return "the 'else' keyword";
      case TK_RETURN: return "the 'return' keyword";
      case TK_IS: return "the 'is' keyword";
      case TK_FUN: return "the 'fun' keyword";
      case TK_VAL: return "the 'val' keyword";
      case TK_CASE: return "the 'case' keyword";
      case TK_OF: return "the 'of' keyword";
      case TK_END: return "the 'end' keyword";
      case TK_LET: return "the 'let' keyword";
      case TK_OR: return "the 'or' keyword";
      case TK_POSTOP:
      case TK_PREOP:
      case TK_BINOP:
        return "an operator";
      case TK_LEFTPAREN: return "a '('";
      case TK_RIGHTPAREN: return "a ')'";
      case TK_LEFTBRACKET: return "a '['";
      case TK_RIGHTBRACKET: return "a ']'";
      case TK_LEFTBRACE: return "a '{'";
      case TK_RIGHTBRACE: return "a '}'";
      case TK_LEFTANGLE: return "a '<'";
      case TK_RIGHTANGLE: return "a '>'";
      case TK_PLUS: return "a '+'";
      case TK_MINUS: return "a '-'";
      case TK_DOT: return "a '.'";
      case TK_COLON: return "a ':'";
      case TK_COMMA: return "a ','";
      case TK_BACKQUOTE: return "a '`'";
      case TK_COMMENT: return "a comment";
      case 0: return "the end of the program";
    }
    return "an expression";
  }

  function eat(ctx, tk) {
    const nextToken = next(ctx);
    if (nextToken !== tk) {
      throw new Error("Expecting " + tokenToLexeme(tk) +
                      ", found " + tokenToLexeme(nextToken) + ".");
    }
  }

  function match(ctx, tk) {
    if (peek(ctx) === tk) {
      return true;
    } else {
      return false;
    }
  }

  function next(ctx) {
    const tk = peek(ctx);
    ctx.state.nextToken = -1;
    scanCount++;
    return tk;
  }

  function peek(ctx) {
    let tk;
    const nextToken = ctx.state.nextToken;
    if (nextToken < 0) {
      const t0 = new Date();
      tk = ctx.scan.start(ctx);
      const t1 = new Date();
      scanTime += (t1 - t0);
      ctx.state.nextToken = tk;
    } else {
      tk = nextToken;
    }
    return tk;
  }

  // Parsing functions -- each parsing function consumes a single token and
  // returns a continuation function for parsing the rest of the string.

  function nul(ctx, cc) {
    eat(ctx, TK_NULL);
    cc.cls = "number";
    Ast.nul(ctx);
    return cc;
  }

  function bool(ctx, cc) {
    eat(ctx, TK_BOOL);
    cc.cls = "number";
    Ast.bool(ctx, lexeme === "true");
    return cc;
  }

  function number(ctx, cc) {
    eat(ctx, TK_NUM);
    cc.cls = "number";
    Ast.number(ctx, lexeme, getCoord(ctx));
    return cc;
  }

  /*
  Str :
    STR
    STRPREFIX StrSuffix

  StrSuffix :
    Expr STRMIDDLE StrSuffix
    Expr STRSUFFIX
  */

  function str(ctx, cc) {
    let coord;
    if (match(ctx, TK_STR)) {
      eat(ctx, TK_STR);
      coord = getCoord(ctx);
      Ast.string(ctx, lexeme, coord); // strip quotes;
      cc.cls = "string";
      return cc;
    } else if (match(ctx, TK_STRPREFIX)) {
      ctx.state.inStr++;
      eat(ctx, TK_STRPREFIX);
      startCounter(ctx);
      coord = getCoord(ctx);
      Ast.string(ctx, lexeme, coord); // strip quotes;
      countCounter(ctx);
      const ret = function (ctx) {
        return strSuffix(ctx, function (ctx) {
          ctx.state.inStr--;
          eat(ctx, TK_STRSUFFIX);
          const coord = getCoord(ctx);
          Ast.string(ctx, lexeme, coord); // strip quotes;
          countCounter(ctx);
          Ast.list(ctx, ctx.state.exprc, getCoord(ctx));
          stopCounter(ctx);
          Ast.concat(ctx);
          cc.cls = "string";
          return cc;
        });
      };
      ret.cls = "string";
      return ret;
    }
    assert(false);
  }
  function strSuffix(ctx, resume) {
    if (match(ctx, TK_STRSUFFIX)) {
      // We have a STRSUFFIX so we are done.
      return resume;
    }
    return strPart(ctx, function (ctx) {
      let ret;
      if (match(ctx, TK_STRMIDDLE)) {
        // Not done yet.
        eat(ctx, TK_STRMIDDLE);
        const coord = getCoord(ctx);
        Ast.string(ctx, lexeme, coord); // strip quotes;
        countCounter(ctx);
        ret = function (ctx) {
          return strSuffix(ctx, resume);
        };
        ret.cls = "string";
        return ret;
      }
      ret = function (ctx) {
        return strSuffix(ctx, resume);
      };
      ret.cls = "string";
      return ret;
    });
  }
  function strPart(ctx, resume) {
    return expr(ctx, function (ctx) {
      countCounter(ctx);
      return resume(ctx);
    });
  }
  function ident(ctx, cc) {
    eat(ctx, TK_IDENT);
    Ast.name(ctx, lexeme, getCoord(ctx));
    cc.cls = "variable";
    return cc;
  }
  function identOrString(ctx, cc) {
    if (match(ctx, TK_IDENT)) {
      return ident(ctx, cc);
    }
    if (match(ctx, TK_NUM)) {
      return number(ctx, cc);
    }
    return str(ctx, cc);
  }
  function defList(ctx, cc) {
    eat(ctx, TK_LEFTBRACKET);
    const ret = (ctx) => {
      return params(ctx, TK_RIGHTBRACKET, (ctx) => {
        eat(ctx, TK_RIGHTBRACKET);
        Ast.list(ctx, ctx.state.paramc, null, true);
        ctx.state.paramc = 1;
        return cc;
      });
    };
    ret.cls = "punc";
    return ret;
  }
  function defName(ctx, cc) {
    if (match(ctx, TK_LEFTBRACKET)) {
      return defList(ctx, cc);
    } else {
      eat(ctx, TK_IDENT);
      env.addWord(ctx, lexeme, {
        tk: TK_IDENT,
        cls: "val",
        name: lexeme,
        offset: ctx.state.paramc,
        nid: 0
      });
      Ast.name(ctx, lexeme, getCoord(ctx));
      cc.cls = "val";
      return cc;
    }
  }
  function name(ctx, cc) {
    eat(ctx, TK_IDENT);
    const coord = getCoord(ctx);
    const word = env.findWord(ctx, lexeme);
    if (word) {
      cc.cls = word.cls;
      if (word.cls === "number" && word.val) {
        Ast.number(ctx, word.val, coord);
      } else if (word.cls === "string" && word.val) {
        Ast.string(ctx, word.val, coord);
      } else {
        if (word.nid) {
          Ast.push(ctx, word.nid);
        } else {
          Ast.name(ctx, lexeme, coord);
        }
      }
    } else {
      cc.cls = "comment";
      addError(ctx, "Name '" + lexeme + "' not found.");
    }
    assert(cc, "name");
    return cc;
  }
  function record(ctx, cc) {
    // Parse record
    eat(ctx, TK_LEFTBRACE);
    startCounter(ctx);
    const ret = function (ctx) {
      return bindings(ctx, function (ctx) {
        eat(ctx, TK_RIGHTBRACE);
        Ast.record(ctx);
        stopCounter(ctx);
        cc.cls = "punc";
        return cc;
      });
    };
    ret.cls = "punc";
    return ret;
  }
  function bindings(ctx, cc) {
    if (match(ctx, TK_RIGHTBRACE)) {
      return cc;
    }
    return binding(ctx, function (ctx) {
      if (match(ctx, TK_COMMA)) {
        eat(ctx, TK_COMMA);
        Ast.binding(ctx);
        const ret = function (ctx) {
          return bindings(ctx, cc);
        };
        ret.cls = "punc";
        return ret;
      }
      return function (ctx) {
        Ast.binding(ctx);
        return bindings(ctx, cc);
      };
    });
  }
  function binding(ctx, cc) {
    return identOrString(ctx, function (ctx) {
      eat(ctx, TK_COLON);
      const ret = function (ctx) {
        countCounter(ctx);
        return expr(ctx, cc);
      };
      ret.cls = "punc";
      return ret;
    });
  }
  function lambda(ctx, cc) {
    eat(ctx, TK_LEFTANGLE);
    const ret = function (ctx) {
      ctx.state.paramc = 0;
      env.enterEnv(ctx, "lambda");
      return params(ctx, TK_COLON, function (ctx) {
        eat(ctx, TK_COLON);
        const ret = function (ctx) {
          return exprsStart(ctx, TK_RIGHTANGLE, function (ctx) {
            eat(ctx, TK_RIGHTANGLE);
            const nid = Ast.pop(ctx); // save body node id for aliased code
            Ast.lambda(ctx, topEnv(ctx), nid);
            env.exitEnv(ctx);
            return cc;
          });
        };
        ret.cls = "punc";
        return ret;
      });
    };
    return ret;
  }
  function parenExpr(ctx, cc) {
    const coord = getCoord(ctx);
    eat(ctx, TK_LEFTPAREN);
    const ret = function (ctx) {
      return exprsStart(ctx, TK_RIGHTPAREN, function (ctx) {
        eat(ctx, TK_RIGHTPAREN);
        coord.to = getCoord(ctx).to;
        Ast.parenExpr(ctx, coord);
        cc.cls = "punc";
        return cc;
      });
    };
    ret.cls = "punc";
    return ret;
  }
  function list(ctx, cc) {
    const coord = getCoord(ctx);
    eat(ctx, TK_LEFTBRACKET);
    startCounter(ctx);
    const ret = function (ctx) {
      return elements(ctx, function (ctx) {
        eat(ctx, TK_RIGHTBRACKET);
        coord.to = getCoord(ctx).to;
        Ast.list(ctx, ctx.state.exprc, coord);
        stopCounter(ctx);
        cc.cls = "punc";
        return cc;
      });
    };
    ret.cls = "punc";
    return ret;
  }
  function elements(ctx, cc) {
    if (match(ctx, TK_RIGHTBRACKET)) {
      return cc;
    }
    return element(ctx, function (ctx) {
      if (match(ctx, TK_COMMA)) {
        eat(ctx, TK_COMMA);
        const ret = function (ctx) {
          return elements(ctx, cc);
        };
        ret.cls = "punc";
        return ret;
      }
      return function (ctx) {
        return elements(ctx, cc);
      };
    });
  }
  function element(ctx, cc) {
    return expr(ctx, function (ctx) {
      countCounter(ctx);
      return cc(ctx);
    });
  }
  function primaryExpr(ctx, cc) {
    if (match(ctx, TK_NUM)) {
      return number(ctx, cc);
    } else if (match(ctx, TK_STR) || match(ctx, TK_STRPREFIX)) {
      return str(ctx, cc);
    } else if (match(ctx, TK_BOOL)) {
      return bool(ctx, cc);
    } else if (match(ctx, TK_NULL)) {
      return nul(ctx, cc);
    } else if (match(ctx, TK_LEFTBRACE)) {
      return record(ctx, cc);
    } else if (match(ctx, TK_LEFTPAREN)) {
      return parenExpr(ctx, cc);
    } else if (match(ctx, TK_LEFTBRACKET)) {
      return list(ctx, cc);
    } else if (match(ctx, TK_LEFTANGLE)) {
      return lambda(ctx, cc);
    }
    return name(ctx, cc);
  }
  function postfixExpr(ctx, cc) {
    return primaryExpr(ctx, function (ctx) {
      if (match(ctx, TK_POSTOP)) {
        eat(ctx, TK_POSTOP);
        cc.cls = "operator";
        Ast.postfixExpr(ctx, lexeme);
        return cc;
      }
      return cc(ctx);
    });
  }

  function prefixExpr(ctx, cc) {
    if (match(ctx, TK_MINUS)) {
      eat(ctx, TK_MINUS);
      const ret = function (ctx) {
        return postfixExpr(ctx, function (ctx) {
          Ast.prefixExpr(ctx, "NEG");
          return cc;
        });
      };
      ret.cls = "number"; // use number because of convention
      return ret;
    }
    return postfixExpr(ctx, cc);
  }

  function getPrecedence(op) {
    return {
      "": 0,
      OR: 1,
      AND: 2,
      EQ: 3,
      NE: 3,
      LT: 4,
      GT: 4,
      LE: 4,
      GE: 4,
      CONCAT: 5,
      ADD: 5,
      SUB: 5,
      MUL: 6,
      DIV: 6,
      MOD: 6,
      POW: 7
    }[op];
  }

  function binaryExpr(ctx, prevOp, cc) {
    return prefixExpr(ctx, function (ctx) {
      if (match(ctx, TK_BINOP)) {
        eat(ctx, TK_BINOP);
        const ret = function (ctx) {
          let op = env.findWord(ctx, lexeme).name;
          if (getPrecedence(prevOp) < getPrecedence(op)) {
            return binaryExpr(ctx, op, function (ctx, prevOp) {
              // This continuation's purpose is to construct a right recursive
              // binary expression node. If the previous node is a binary node
              // with equal or higher precedence, then we get here from the left
              // recursive branch below and there is no way to know the current
              // operator unless it gets passed as an argument, which is what
              // prevOp is for.
              if (prevOp !== undefined) {
                op = prevOp;
              }
              Ast.binaryExpr(ctx, op);
              return cc(ctx);
            });
          } else {
            Ast.binaryExpr(ctx, prevOp);
            return binaryExpr(ctx, op, function (ctx, prevOp) {
              if (prevOp !== undefined) {
                op = prevOp;
              }
              return cc(ctx, op);
            });
          }
        };
        ret.cls = "operator";
        return ret;
      }
      return cc(ctx);
    });
  }

  function relationalExpr(ctx, cc) {
    return binaryExpr(ctx, "", function (ctx) {
      return cc(ctx);
    });
  }

  function condExpr(ctx, cc) {
    if (match(ctx, TK_CASE)) {
      return caseExpr(ctx, cc);
    }
    return relationalExpr(ctx, cc);
  }

  function caseExpr(ctx, cc) {
    eat(ctx, TK_CASE);
    const ret = function (ctx) {
      return expr(ctx, function (ctx) {
        startCounter(ctx);
        return ofClauses(ctx, function (ctx) {
          Ast.caseExpr(ctx, ctx.state.exprc);
          stopCounter(ctx);
          eat(ctx, TK_END);
          cc.cls = "keyword";
          return cc;
        });
      });
    };
    ret.cls = "keyword";
    return ret;
  }

  function ofClauses(ctx, cc) {
    if (match(ctx, TK_OF)) {
      return ofClause(ctx, function (ctx) {
        countCounter(ctx);
        if (match(ctx, TK_OF)) {
          return ofClauses(ctx, cc);
        }
        return cc(ctx);
      });
    }
    return cc(ctx);
  }

  function ofClause(ctx, cc) {
    eat(ctx, TK_OF);
    const ret = function (ctx) {
      return pattern(ctx, function (ctx) {
        eat(ctx, TK_COLON);
        const ret = function (ctx) {
          return exprsStart(ctx, TK_OF, function (ctx) {
            Ast.ofClause(ctx);
            return cc(ctx);
          });
        };
        ret.cls = "punc";
        return ret;
      });
    };
    ret.cls = "keyword";
    return ret;
  }

  function pattern(ctx, cc) {
    // FIXME only matches idents and literals for now
    return identOrString(ctx, cc);
  }

  // function thenClause(ctx, cc) {
  //   eat(ctx, TK_THEN);
  //   const ret = function (ctx) {
  //     return exprsStart(ctx, TK_ELSE, function (ctx) {
  //       if (match(ctx, TK_ELSE)) {
  //         return elseClause(ctx, cc);
  //       } else {
  //         return cc(ctx);
  //       }
  //     });
  //   };
  //   ret.cls = "keyword";
  //   return ret;
  // }

  // function elseClause(ctx, cc) {
  //   eat(ctx, TK_ELSE);
  //   const ret = function (ctx) {
  //     return exprsStart(ctx, TK_END, cc);
  //   };
  //   ret.cls = "keyword";
  //   return ret;
  // }

  function expr(ctx, cc) {
    let ret;
    if (match(ctx, TK_LET)) {
      ret = letDef(ctx, cc);
    } else {
      ret = condExpr(ctx, cc);
    }
    return ret;
  }

  function emptyInput(ctx) {
    return peek(ctx) === 0;
  }

  function emptyExpr(ctx) {
    return emptyInput(ctx) ||
      match(ctx, TK_THEN) ||
      match(ctx, TK_ELSE) ||
      match(ctx, TK_OR) ||
      match(ctx, TK_END) ||
      match(ctx, TK_DOT);
  }

  function countCounter(ctx) {
    ctx.state.exprc++;
  }

  function startCounter(ctx) {
    ctx.state.exprcStack.push(ctx.state.exprc);
    ctx.state.exprc = 0;
  }

  function stopCounter(ctx) {
    ctx.state.exprc = ctx.state.exprcStack.pop();
  }

  function exprsStart(ctx, brk, cc) {
    startCounter(ctx);
    return exprs(ctx, brk, cc);
  }

  function exprsFinish(ctx, cc) {
    Ast.exprs(ctx, ctx.state.exprc);
    stopCounter(ctx);
    return cc(ctx);
  }

  function exprs(ctx, brk, cc) {
    if (match(ctx, TK_DOT)) { // second dot
      eat(ctx, TK_DOT);
      const ret = function (ctx) {
        return exprsFinish(ctx, cc);
      };
      ret.cls = "punc";
      return ret;
    }
    return expr(ctx, function (ctx) {
      countCounter(ctx);
      let ret;
      if (match(ctx, TK_DOT)) {
        eat(ctx, TK_DOT);
        ret = function (ctx) {
          if (emptyInput(ctx) || emptyExpr(ctx)) {
            return exprsFinish(ctx, cc);
          }
          return exprs(ctx, brk, cc);
        };
        ret.cls = "punc";
        return ret;
      } else if (match(ctx, brk)) {
        ret = function (ctx) {
          return exprsFinish(ctx, cc);
        };
        ret.cls = "punc";
        return ret;
      } else {
        if (emptyInput(ctx) || emptyExpr(ctx)) {
          return exprsFinish(ctx, cc);
        }
        return exprs(ctx, brk, cc);
      }
    });
  }

  function program(ctx, cc) {
    return exprsStart(ctx, TK_DOT, function (ctx) {
      let nid;
      while (Ast.peek(ctx) !== nid) {
        nid = Ast.pop(ctx);
        folder.fold(ctx, nid); // fold the exprs on top
      }
      Ast.exprs(ctx, ctx.state.nodeStack.length, true);
      Ast.program(ctx);
      assert(cc === null, "internal error, expecting null continuation");
      return cc;
    });
  }

  window.gcexports.program = program;

  /*

    fn = { head, body }

   */

  function letDef(ctx, cc) {
    if (match(ctx, TK_LET)) {
      eat(ctx, TK_LET);
      const ret = function (ctx) {
        const ret = defName(ctx, function (ctx) {
          const name = Ast.node(ctx, Ast.pop(ctx)).elts[0];
          // nid=0 means def not finished yet
          env.addWord(ctx, name, {
            tk: TK_IDENT,
            cls: "function",
            length: 0,
            nid: 0,
            name
          });
          ctx.state.paramc = 0;
          env.enterEnv(ctx, name); // FIXME need to link to outer env
          return params(ctx, TK_EQUAL, function (ctx) {
            const func = env.findWord(ctx, topEnv(ctx).name);
            func.length = ctx.state.paramc;
            func.env = topEnv(ctx);
            eat(ctx, TK_EQUAL);
            const ret = function (ctx) {
              return exprsStart(ctx, TK_DOT, function (ctx) {
                const def = env.findWord(ctx, topEnv(ctx).name);
                def.nid = Ast.peek(ctx); // save node id for aliased code
                env.exitEnv(ctx);
                Ast.letDef(ctx); // Clean up stack
                return cc;
              });
            };
            ret.cls = "punc";
            return ret;
          });
        });
        ret.cls = "def";
        return ret;
      };
      ret.cls = "keyword";
      return ret;
    }
    return name(ctx, cc);
  }

  // TODO add argument for specifying the break token.
  // e.g. TK_EQUAL | TK_VERTICALBAR
  // params(ctx, brk, cc) {..}
  function params(ctx, brk, cc) {
    if (match(ctx, brk)) {
      return cc;
    }
    const ret = function (ctx) {
      const ret = defName(ctx, (ctx) => {
        Ast.pop(ctx); // Throw away name.
        ctx.state.paramc++;
        return params(ctx, brk, cc);
      });
      ret.cls = "param";
      return ret;
    };
    ret.cls = "param";
    return ret;
  }

  function topEnv(ctx) {
    return ctx.state.env[ctx.state.env.length - 1];
  }

  window.gcexports.topEnv = topEnv;
  window.gcexports.firstTime = true;
  function parse(stream, state) {
    const ctx = {
      scan: scanner(stream, state.env[0].lexicon),
      state
    };
    let cls;
    let t0;
    try {
      let c;
      while ((c = stream.peek()) && (c === " " || c === "\t")) {
        stream.next();
      }
      // if this is a blank line, treat it as a comment
      if (stream.peek() === undefined) {
        throw new Error("comment");
      }
      // call the continuation and store the next continuation
      if (state.cc === null) {
        next(ctx);
        return "comment";
      }
      t0 = new Date();
      const cc = state.cc = state.cc(ctx, null);
      if (cc) {
        cls = cc.cls;
      }
      if (cc === null) {
        // FIXME make all paths go through a resume function.
        if (state.errors.length > 0) {
          throw new Error(state.errors);
        } else {
          return Ast.poolToJSON(ctx);
        }
      }
      while ((c = stream.peek()) &&
           (c === " " || c === "\t")) {
        stream.next();
      }
    } catch (x) {
      // console.log("catch() x=" + x);
      if (x instanceof Error) {
        if (x.message === "comment") {
          cls = x;
        } else {
          next(ctx);
          addError(ctx, x.message);
          state.cc = null; // done for now.
          cls = "error";
          throw new Error(window.gcexports.errors);
        }
      } else {
        // throw x
        next(ctx);
        cls = "error";
        console.log(x.stack);
      }
    }
    const t1 = new Date();
    parseCount++;
    parseTime += t1 - t0;
    window.gcexports.coords = state.coords;
    return cls;
  }

  let lexeme = "";

  function scanner(stream, globalLexicon) {
    return {
      start,
      stream,
      lexeme: function () {
        return lexeme;
      }
    };

    // begin private functions

    function peekCC() {
      return stream.peek() && stream.peek().charCodeAt(0) || 0;
    }

    function nextCC() {
      return stream.peek() && stream.next().charCodeAt(0) || 0;
    }

    function start(ctx) {
      let c;
      lexeme = "";
      while (stream.peek() !== undefined) {
        switch ((c = stream.next().charCodeAt(0))) {
          case 32: // space
          case 9: // tab
          case 10: // new line
          case 13: // carriage return
            c = " ";
            continue;
          case 46: // dot
            if (isNumeric(stream.peek())) {
              return number(c);
            }
            lexeme += String.fromCharCode(c);
            return TK_DOT;
          case 44: // comma
            lexeme += String.fromCharCode(c);
            return TK_COMMA;
          case 58: // colon
            lexeme += String.fromCharCode(c);
            return TK_COLON;
          case 61: // equal
            lexeme += String.fromCharCode(c);
            return TK_EQUAL;
          case 40: // left paren
            lexeme += String.fromCharCode(c);
            return TK_LEFTPAREN;
          case 41: // right paren
            lexeme += String.fromCharCode(c);
            return TK_RIGHTPAREN;
          case 45: // dash
            lexeme += String.fromCharCode(c);
            return TK_MINUS;
          case 60: // left angle
            lexeme += String.fromCharCode(c);
            return TK_LEFTANGLE;
          case 62: // right angle
            lexeme += String.fromCharCode(c);
            return TK_RIGHTANGLE;
          case 91: // left bracket
            lexeme += String.fromCharCode(c);
            return TK_LEFTBRACKET;
          case 93: // right bracket
            lexeme += String.fromCharCode(c);
            return TK_RIGHTBRACKET;
          case 123: // left brace
            lexeme += String.fromCharCode(c);
            return TK_LEFTBRACE;
          case 125: // right brace
            lexeme += String.fromCharCode(c);
            if (ctx.state.inStr) {
              return stringSuffix(ctx);
            }
            return TK_RIGHTBRACE;
          case CC_DOUBLEQUOTE:
          case CC_SINGLEQUOTE:
          case CC_BACKTICK:
            return string(ctx, c);
          case 96: // backquote
          case 47: // slash
          case 92: // backslash
          case 33: // !
          case 124: // |
            comment(c);
            throw new Error("comment");
          case 94: // caret
          case 42: // asterisk
            lexeme += String.fromCharCode(c);
            return c; // char code is the token id
          default:
            if ((c >= "A".charCodeAt(0) && c <= "Z".charCodeAt(0)) ||
              (c >= "a".charCodeAt(0) && c <= "z".charCodeAt(0)) ||
              (c === "_".charCodeAt(0))) {
              return ident(c);
            } else if (isNumeric(c) || c === ".".charCodeAt(0) && isNumeric(stream.peek())) {
            // lex += String.fromCharCode(c);
            // c = src.charCodeAt(curIndex++);
            // return TK_NUM;
              return number(c);
            } else {
              return 0;
            }
        }
      }

      return 0;
    }

    function isNumeric(c) {
      if (typeof c === "string") {
        c = c.charCodeAt(0);
      }
      return c >= "0".charCodeAt(0) && c <= "9".charCodeAt(0);
    }

    function number(c) {
      // 123, 1.23, .123
      while (isNumeric(c) || c === ".".charCodeAt(0) && isNumeric(stream.peek())) {
        lexeme += String.fromCharCode(c);
        const s = stream.next();
        c = s ? s.charCodeAt(0) : 0;
      }
      if (c) {
        stream.backUp(1);
      } // otherwise, we are at the end of stream
      return TK_NUM;
    }

    // "abc" --> "abc"
    // "a${x}c" --> concat ["a", x, "b"]
    function string(ctx, c) {
      const quoteChar = c;
      ctx.state.quoteCharStack.push(c);
      lexeme += String.fromCharCode(c);
      c = nextCC();
      // const inTemplateLiteral = quoteChar === CC_BACKTICK;
      // while (c !== quoteChar && c !== 0 && (inTemplateLiteral || !(c === CC_DOLLAR && peekCC() === CC_LEFTBRACE))) {
      while (c !== quoteChar && c !== 0) {
        lexeme += String.fromCharCode(c);
        c = nextCC();
      }
      if (c === CC_DOLLAR &&
          peekCC() === CC_LEFTBRACE) {
        nextCC(); // Eat CC_LEFTBRACE
        lexeme = lexeme.substring(1); // Strip off punct.
        return TK_STRPREFIX;
      } else if (c) {
        lexeme = lexeme.substring(1); // Strip off leading quote.
        return TK_STR;
      } else {
        return 0;
      }
    }

    function stringSuffix(ctx) {
      let c;
      const quoteCharStack = ctx.state.quoteCharStack;
      const quoteChar = quoteCharStack[quoteCharStack.length - 1];
      c = nextCC();
      while (c !== quoteChar && c !== 0 &&
             !(c === CC_DOLLAR &&
               peekCC() === CC_LEFTBRACE)) {
        lexeme += String.fromCharCode(c);
        c = nextCC();
      }
      if (c === CC_DOLLAR &&
          peekCC() === CC_LEFTBRACE) {
        nextCC(); // Eat brace.
        lexeme = lexeme.substring(1); // Strip off leading brace and trailing brace.
        return TK_STRMIDDLE;
      } else if (c) {
        quoteCharStack.pop();
        lexeme = lexeme.substring(1); // Strip off leading braces.
        return TK_STRSUFFIX;
      } else {
        return 0;
      }
    }

    function comment(c) {
      const quoteChar = c;
      let s = stream.next();
      c = (s && s.charCodeAt(0)) || 0;

      while (c !== quoteChar && c !== 10 && c !== 13 && c !== 0) {
        s = stream.next();
        c = (s && s.charCodeAt(0)) || 0;
      }

      return TK_COMMENT;
    }

    function ident(c) {
      while ((c >= "A".charCodeAt(0) && c <= "Z".charCodeAt(0)) ||
           (c >= "a".charCodeAt(0) && c <= "z".charCodeAt(0)) ||
           (c === "-".charCodeAt(0)) ||
           (c === "@".charCodeAt(0)) ||
           (c === "+".charCodeAt(0)) ||
           (c === "#".charCodeAt(0)) ||
           (c === "_".charCodeAt(0)) ||
           (c === "~".charCodeAt(0)) ||
           (c >= "0".charCodeAt(0) && c <= "9".charCodeAt(0))) {
        lexeme += String.fromCharCode(c);
        c = stream.peek() ? stream.next().charCodeAt(0) : 0;
      }

      if (c) {
        stream.backUp(1);
      } // otherwise, we are at the end of stream

      let tk = TK_IDENT;
      if (keywords[lexeme]) {
        tk = keywords[lexeme].tk;
      } else if (globalLexicon[lexeme]) {
        tk = globalLexicon[lexeme].tk;
      }
      return tk;
    }
  }

  const parser = {
    token: function (stream, state) {
      return parse(stream, state);
    },

    parse,
    program,
    StringStream
  };

  window.gcexports.parse = parser.parse;
  if (window.isSynthetic) {
    // Export in node.
    //    exports.parse = window.gcexports.parse;
    //    exports.StringStream = window.gcexports.StringStream;
    //    exports.program = program;
  }

  return parser;
})(); // end parser

let foldTime = 0;

window.gcexports.foldTime = function () {
  return foldTime;
};

const folder = (function () {
  const table = {
    PROG: program,
    EXPRS: exprs,
    PAREN: parenExpr,
    IDENT: ident,
    BOOL: bool,
    NUM: num,
    STR: str,
    PARENS: unaryExpr,
    APPLY: apply,
    LAMBDA: lambda,
    // "MUL": mul,
    // "DIV": div,
    // "SUB": sub,
    ADD: add,
    POW: pow,
    MOD: mod,
    CONCAT: concat,
    // "OR": orelse,
    // "AND": andalso,
    // "NE": ne,
    // "EQ": eq,
    // "LT": lt,
    // "GT": gt,
    // "LE": le,
    // "GE": ge,
    NEG: neg,
    LIST: list
    // "CASE": caseExpr,
    // "OF": ofClause,
  };

  let nodePool;
  let ctx;

  function fold(cx, nid) {
    ctx = cx;
    nodePool = ctx.state.nodePool;
    const t0 = new Date();
    visit(nid);
    const t1 = new Date();
    foldTime += (t1 - t0);
  }

  function visit(nid) {
    const node = nodePool[nid];
    if (node === null) {
      return null;
    }
    if (node.tag === undefined) {
      return []; // clean up stubs;
    } else if (isFunction(table[node.tag])) {
      // Have a primitive operation so apply it to construct a new node.
      const ret = table[node.tag](node);
      return ret;
    }
    expr(node);
  }

  function isFunction(v) {
    return v instanceof Function;
  }

  // BEGIN VISITOR METHODS

  function program(node) {
    visit(node.elts[0]);
    Ast.program(ctx);
  }

  function pushNodeStack(ctx) {
    ctx.state.nodeStackStack.push(ctx.state.nodeStack);
    ctx.state.nodeStack = [];
  }
  function popNodeStack(ctx) {
    const stack = ctx.state.nodeStack;
    ctx.state.nodeStack = ctx.state.nodeStackStack.pop().concat(stack);
  }

  function list(node) {
    // Fold list
    // for (var i = 0; i < node.elts.length; i++) {
    //   visit(node.elts[i]);
    // }
    pushNodeStack(ctx);
    for (let i = node.elts.length - 1; i >= 0; i--) {
      visit(node.elts[i]); // Keep original order.
    }
    Ast.list(ctx, ctx.state.nodeStack.length, null, true);
    popNodeStack(ctx);
  }

  function exprs(node) {
    // Fold exprs in reverse order to get precedence right.
    for (let i = node.elts.length - 1; i >= 0; i--) {
      visit(node.elts[i]); // Keep original order.
    }
    ctx.state.exprc = node.elts.length;
  }

  function lambda(node) {
    // Fold initializers and apply args.
    const inits = Ast.node(ctx, node.elts[3]).elts;
    inits.forEach((init, i) => {
      if (init) {
        // If we have an init then fold it and replace in inits list.
        folder.fold(ctx, Ast.intern(ctx, init));
        inits[i] = Ast.pop(ctx);
      }
    });
    // FIXME don't patch old node. construct a new one.
    node.elts[3] = Ast.intern(ctx, { tag: "LIST", elts: inits });
    const fnId = Ast.intern(ctx, node);
    const argc = ctx.state.nodeStack.length;
    Ast.apply(ctx, fnId, argc);
  }

  function apply(node) {
    for (let i = node.elts.length - 1; i >= 0; i--) {
      visit(node.elts[i]);
    }
    Ast.applyLate(ctx, node.elts.length);
  }

  function expr(node) {
    // Construct an expression node for the compiler.
    Ast.name(ctx, node.tag, getCoord(ctx));
    for (let i = node.elts.length - 1; i >= 0; i--) {
      visit(node.elts[i]);
    }
    Ast.expr(ctx, node.elts.length);
  }

  function neg(node) {
    visit(node.elts[0]);
    Ast.neg(ctx);
  }

  function parenExpr(node) {
    pushNodeStack(ctx);
    visit(node.elts[0]);
    Ast.parenExpr(ctx);
    popNodeStack(ctx);
  }

  function unaryExpr(node) {
    visit(node.elts[0]);
    Ast.unaryExpr(ctx, node.tag);
  }

  function add(node) {
    visit(node.elts[0]);
    visit(node.elts[1]);
    Ast.add(ctx);
  }

  function pow(node) {
    visit(node.elts[0]);
    visit(node.elts[1]);
    Ast.pow(ctx);
  }

  function concat(node) {
    visit(node.elts[0]);
    Ast.concat(ctx);
  }

  function mod(node) {
    visit(node.elts[0]);
    visit(node.elts[1]);
    Ast.mod(ctx);
  }

  function ident(node) {
    const name = node.elts[0];
    const word = env.findWord(ctx, name);
    if (word) {
      if (word.cls === "val") {
        if (word.val) {
          Ast.push(ctx, word.val);
          visit(Ast.pop(ctx)); // reduce the val expr
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
        const coord = getCoord(ctx);
        const elts = [];
        for (let i = 0; i < word.length; i++) {
          const elt = Ast.pop(ctx);
          elts.push(elt);
        }
        if (word.nid) {
          Ast.fold(ctx, word, elts);
        } else {
          Ast.push(ctx, {
            tag: word.name,
            elts,
            coord
          });
          folder.fold(ctx, Ast.pop(ctx));
        }
      } else {
        assert(false);
      }
    } else {
      // assert(false, "unresolved ident "+name);
      Ast.push(ctx, node);
    }
  }

  function num(node) {
    Ast.number(ctx, node.elts[0]);
  }

  function str(node) {
    Ast.string(ctx, node.elts[0]);
  }

  function bool(node) {
    Ast.bool(ctx, node.elts[0]);
  }

  return {
    fold
  };
}());
