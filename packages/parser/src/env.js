// env

export const env = (function () {
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
      console.trace(
        "enterEnv()",
        "name=" + name,
      );
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
