export class StringStream {
  constructor(string, tabSize = 8) {
    this.pos = 0;
    this.start = 0;
    this.string = string;
    this.tabSize = tabSize;
  }

  eol() {
    return this.pos >= this.string.length;
  }

  sol() {
    return this.pos === 0;
  }

  peek() {
    return this.string.charAt(this.pos) || undefined;
  }

  next() {
    if (this.pos < this.string.length) {
      return this.string.charAt(this.pos++);
    }
  }

  eat(match) {
    const ch = this.string.charAt(this.pos);
    let ok;

    if (typeof match === "string") {
      ok = ch === match;
    } else if (match instanceof RegExp) {
      ok = match.test(ch);
    } else {
      ok = match(ch);
    }

    if (ok) {
      ++this.pos;
      return ch;
    }
  }

  eatWhile(match) {
    const start = this.pos;
    while (this.eat(match));
    return this.pos > start;
  }

  eatSpace() {
    const start = this.pos;
    while (/[\s\u00a0]/.test(this.string.charAt(this.pos))) {
      ++this.pos;
    }
    return this.pos > start;
  }

  skipToEnd() {
    this.pos = this.string.length;
  }

  skipTo(ch) {
    const found = this.string.indexOf(ch, this.pos);
    if (found > -1) {
      this.pos = found;
      return true;
    }
  }

  backUp(n) {
    this.pos -= n;
  }

  match(pattern, consume = true, caseInsensitive = false) {
    if (typeof pattern === "string") {
      const cased = str => (caseInsensitive ? str.toLowerCase() : str);
      if (cased(this.string).indexOf(cased(pattern), this.pos) === this.pos) {
        if (consume) this.pos += pattern.length;
        return true;
      }
      return false;
    } else {
      const match = this.string.slice(this.pos).match(pattern);
      if (!match || match.index !== 0) return null;
      if (consume) this.pos += match[0].length;
      return match;
    }
  }

  current() {
    return this.string.slice(this.start, this.pos);
  }
}
