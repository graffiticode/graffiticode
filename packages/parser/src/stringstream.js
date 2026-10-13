export class StringStream {
  constructor(string, tabSize = 2) {
    this.pos = 0;
    this.start = 0;
    this.string = string;
    this.tabSize = tabSize;
  }

  peek() {
    return this.string.charAt(this.pos) || undefined;
  }

  // The char `n` past the next one; peekAt(0) is peek().
  peekAt(n) {
    return this.string.charAt(this.pos + n) || undefined;
  }

  next() {
    if (this.pos < this.string.length) {
      return this.string.charAt(this.pos++);
    }
  }

  backUp(n) {
    this.pos -= n;
  }
}
