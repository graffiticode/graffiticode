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

  next() {
    if (this.pos < this.string.length) {
      return this.string.charAt(this.pos++);
    }
  }

  backUp(n) {
    this.pos -= n;
  }
}
