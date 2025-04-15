// Copyright 2021, ARTCOMPILER INC
/*
  Error handling
  -- every range points to a node
  -- multiple ranges can point to the same node
  -- errors are associated with ranges
  -- errors are determined by nodes in context

  -- parser returns an ast which might compile to a list of errors of the form
     {from, to, message, severity}
  -- compiler checkers report these errors in the err callback arg
*/

import { folder } from "./folder.js";
import { Ast } from "./ast.js";
import { Env } from "./env.js";
import { StringStream } from "./stringstream.js";

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
  return ctx.state.nextTokenCoord;
}

function getPos(ctx) {
  return ctx.scan.stream.pos;
}

export function assertErr(ctx, b, str, coord) {
  if (!b) {
    console.log(
      "assertErr()",
      "str=" + str,
    );
    Ast.error(ctx, str, coord);
    throw new Error(str);
  }
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
    data: { tk: 1, name: "DATA", cls: "function", length: 1, arity: 1 },
    json: { tk: 1, name: "JSON", cls: "function", length: 1, arity: 1 },
  };

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
      const to = getPos(ctx);
      const from = to - lexeme.length;
      assertErr(ctx, false, "Expecting " + tokenToLexeme(tk) +
                ", found " + tokenToLexeme(nextToken) + ".", { from, to });
      next(ctx); // Advance past error.
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
      const from = getPos(ctx);
      const t0 = new Date();
      tk = ctx.scan.start(ctx);
      const t1 = new Date();
      scanTime += (t1 - t0);
      ctx.state.nextToken = tk;
      const to = getPos(ctx);
      ctx.state.nextTokenCoord = { from, to };
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
    Ast.number(ctx, lexeme);
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
    if (match(ctx, TK_STR)) {
      eat(ctx, TK_STR);
      Ast.string(ctx, lexeme); // strip quotes;
      cc.cls = "string";
      return cc;
    } else if (match(ctx, TK_STRPREFIX)) {
      ctx.state.inStr++;
      eat(ctx, TK_STRPREFIX);
      startCounter(ctx);
      Ast.string(ctx, lexeme); // strip quotes;
      countCounter(ctx);
      const ret = function (ctx) {
        return strSuffix(ctx, function (ctx) {
          ctx.state.inStr--;
          eat(ctx, TK_STRSUFFIX);
          Ast.string(ctx, lexeme); // strip quotes;
          countCounter(ctx);
          Ast.list(ctx, ctx.state.exprc);
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
        Ast.string(ctx, lexeme); // strip quotes;
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
  function bindingName(ctx, cc) {
    if (match(ctx, TK_IDENT)) {
      eat(ctx, TK_IDENT);
      Ast.string(ctx, lexeme);
      cc.cls = "variable";
      return cc;
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
      Env.addWord(ctx, lexeme, {
        tk: TK_IDENT,
        cls: "val",
        name: lexeme,
        offset: ctx.state.paramc,
        nid: 0
      });
      Ast.name(ctx, lexeme);
      cc.cls = "val";
      return cc;
    }
  }
  function name(ctx, cc) {
    eat(ctx, TK_IDENT);
    const to = getPos(ctx);
    const from = to - lexeme.length;
    const coord = { from, to };
    const word = Env.findWord(ctx, lexeme);
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
      // Create a tag value.
      Ast.name(ctx, lexeme, coord);
    }
    // assert(cc, "name");
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
    return bindingName(ctx, function (ctx) {
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
      Env.enterEnv(ctx, "lambda");
      return params(ctx, TK_COLON, function (ctx) {
        eat(ctx, TK_COLON);
        const ret = function (ctx) {
          return exprsStart(ctx, TK_RIGHTANGLE, function (ctx) {
            eat(ctx, TK_RIGHTANGLE);
            const nid = Ast.pop(ctx); // save body node id for aliased code
            Ast.lambda(ctx, topEnv(ctx), nid);
            Env.exitEnv(ctx);
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
    eat(ctx, TK_LEFTBRACKET);
    startCounter(ctx);
    const ret = function (ctx) {
      return elements(ctx, function (ctx) {
        eat(ctx, TK_RIGHTBRACKET);
        Ast.list(ctx, ctx.state.exprc);
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
          let op = Env.findWord(ctx, lexeme).name;
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
    if (match(ctx, TK_IF)) {
      return ifExpr(ctx, cc);
    }
    return relationalExpr(ctx, cc);
  }

  function ifExpr(ctx, cc) {
    eat(ctx, TK_IF);
    const ret = function (ctx) {
      return exprsStart(ctx, TK_THEN, function (ctx) {
        eat(ctx, TK_THEN);
        return exprsStart(ctx, TK_ELSE, function (ctx) {
          eat(ctx, TK_ELSE);
          return expr(ctx, function (ctx) {
            Ast.ifExpr(ctx);
            cc.cls = "keyword";
            return cc;
          });
        });
      });
    };
    ret.cls = "keyword";
    return ret;
  }

  function caseExpr(ctx, cc) {
    eat(ctx, TK_CASE);
    const ret = function (ctx) {
      return exprsStart(ctx, TK_OF, function (ctx) {
        eat(ctx, TK_OF);
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
    return ofClause(ctx, function (ctx) {
      countCounter(ctx);
      if (!match(ctx, TK_END)) {
        return ofClauses(ctx, cc);
      }
      return cc(ctx);
    });
  }

  function ofClause(ctx, cc) {
    const ret = function (ctx) {
      return pattern(ctx, function (ctx) {
        eat(ctx, TK_COLON);
        const ret = function (ctx) {
          return expr(ctx, function (ctx) {
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
    if (match(ctx, TK_IDENT)) {
      return ident(ctx, cc);
    }
    if (match(ctx, TK_NUM)) {
      return number(ctx, cc);
    }
    if (match(ctx, TK_BOOL)) {
      return bool(ctx, cc);
    }
    return str(ctx, cc);
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
        folder.fold(ctx, nid); // Fold the exprs on top
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
          Env.addWord(ctx, name, {
            tk: TK_IDENT,
            cls: "function",
            length: 0,
            nid: 0,
            name
          });
          ctx.state.paramc = 0;
          Env.enterEnv(ctx, name); // FIXME need to link to outer env
          return params(ctx, TK_EQUAL, function (ctx) {
            const func = Env.findWord(ctx, topEnv(ctx).name);
            func.length = ctx.state.paramc;
            func.env = topEnv(ctx);
            eat(ctx, TK_EQUAL);
            const ret = function (ctx) {
              return exprsStart(ctx, TK_DOT, function (ctx) {
                const def = Env.findWord(ctx, topEnv(ctx).name);
                def.nid = Ast.peek(ctx); // save node id for aliased code
                Env.exitEnv(ctx);
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
           (c === " " || c === "\t" || c === "\n")) {
        stream.next();
      }
      if (cc && !stream.peek()) {
        assertErr(ctx, false, "Missing program terminator.", getCoord(ctx));
      }
    } catch (x) {
      // console.log("catch() x=" + x);
      if (x instanceof Error) {
        if (x.message === "comment") {
          cls = x;
        } else {
          console.log("catch() x=" + x.stack);
          // next(ctx);
          state.cc = null; // done for now.
          return Ast.poolToJSON(ctx);
          // cls = "error";
          // throw new Error(JSON.stringify(window.gcexports.errors, null, 2));
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

    // `abc` --> "abc"
    // `a${x}c` --> concat ["a", x, "b"]
    function string(ctx, c) {
      const quoteChar = c;
      ctx.state.quoteCharStack.push(c);
      lexeme += String.fromCharCode(c);
      c = nextCC();
      const inTemplateLiteral = quoteChar === CC_BACKTICK;
      if (inTemplateLiteral) {
        while (
          c !== quoteChar &&
          c !== 0 &&
          !(c === CC_DOLLAR && peekCC() === CC_LEFTBRACE)) {
          lexeme += String.fromCharCode(c);
          c = nextCC();
        }
      } else {
        while (c !== quoteChar && c !== 0) {
          lexeme += String.fromCharCode(c);
          c = nextCC();
        }
      }
      const coord = { from: getPos(ctx) - lexeme.length, to: getPos(ctx) };
      assertErr(ctx, c !== 0, `Unterminated string: ${lexeme}`, coord);
      if (quoteChar === CC_BACKTICK && c === CC_DOLLAR &&
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
      const inTemplateLiteral = quoteChar === CC_BACKTICK;
      if (inTemplateLiteral) {
        while (c !== quoteChar && c !== 0 &&
             !(c === CC_DOLLAR &&
               peekCC() === CC_LEFTBRACE)) {
          lexeme += String.fromCharCode(c);
          c = nextCC();
        }
      } else {
        while (c !== quoteChar && c !== 0) {
          lexeme += String.fromCharCode(c);
          c = nextCC();
        }
      }
      if (quoteChar === CC_BACKTICK && c === CC_DOLLAR &&
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
