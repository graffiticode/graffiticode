export const TASK1_ID = "WmHjCp";
export const TASK1 = {
  lang: "1",
  code: {
    1: { tag: "STR", elts: ["hello, world!"] },
    2: { tag: "EXPRS", elts: [1] },
    3: { tag: "PROG", elts: [2] },
    root: 3
  }
};

export const TASK1_WITH_SRC = {
  lang: "1",
  code: "\"hello, world!\".."
};

export const TASK1_WITH_STRING_DATA = {
  lang: "1",
  code: "hello, world!"
};

export const TASK1_WITH_DATA = {
  lang: "0",
  code: "hello, world!"
};

export const DATA1 = "hello, world!";

export const TASK2_ID = "M4HrIp";
export const TASK2 = {
  lang: "1",
  code: {
    1: { tag: "STR", elts: ["goodbye, world!"] },
    2: { tag: "EXPRS", elts: [1] },
    3: { tag: "PROG", elts: [2] },
    root: 3
  }
};
export const DATA2 = "goodbye, world!";

export const CODE_AS_DATA = { a: 1 };
export const TASK_WITH_CODE_AS_DATA = { lang: "1", code: CODE_AS_DATA };
