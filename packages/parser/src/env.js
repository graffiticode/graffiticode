// env

function topEnv(ctx) {
  return ctx.state.env[ctx.state.env.length - 1];
}

export class Env {
  static findWord(ctx, lexeme) {
    const env = ctx.state.env;
    for (let i = env.length - 1; i >= 0; i--) {
      const word = env[i].lexicon[lexeme];
      if (word) {
        return word;
      }
    }
    return null;
  }

  static addWord(ctx, lexeme, entry) {
    topEnv(ctx).lexicon[lexeme] = entry;
    return null;
  }

  static addPattern(ctx, pattern) {
    topEnv(ctx).pattern.push(pattern);
  }

  static enterEnv(ctx, name) {
    // recursion guard
    if (ctx.state.env.length > 380) {
      console.trace(
        "enterEnv()",
        "name=" + name,
      );
      // return;  // just stop recursing
      throw new Error("runaway recursion");
    }
    topEnv(ctx).paramc = ctx.state.paramc;
    ctx.state.env.push({
      name,
      lexicon: {},
      pattern: []
    });
  }

  static exitEnv(ctx) {
    ctx.state.env.pop();
    ctx.state.paramc = topEnv(ctx).paramc;
  }
}
