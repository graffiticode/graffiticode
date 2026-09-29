/*
 * Copyright 2013 Art Compiler LLC — Licensed under the Apache License, Version 2.0.
 *
 * ASSERTS AND MESSAGES
 *
 * We use the 'assert()' function to trap invalid states. External messages are
 * distinguished from internal messages by a numeric prefix that indicates the error
 * code (e.g. `assert(false, "1001: Invalid user input.")`). External messages live in
 * the global `messages` table and are read via `message(code)`:
 *
 *     messages[1001] = "Invalid user input.";
 *     assert(x != y, message(1001));
 *
 * Each module claims a non-overlapping range of codes via `reserveCodeRange(first, last,
 * name)` to avoid conflicts. A client can override a library message by reassigning
 * `messages[code]` after the library loads (also useful for localization).
 */

export const messages: Record<number, string> = {};
const reservedCodes: { first: number; last: number; name: string }[] = [];
const ASSERT = true;

export const assert: (val: unknown, str?: string) => void = !ASSERT
  ? function () {}
  : function (val: unknown, str?: string) {
      if (str === void 0) {
        str = "failed!";
      }
      if (!val) {
        throw new Error(str);
      }
    };

export const message = function (errorCode: number, args: unknown[] = []): string {
  let str = messages[errorCode];
  if (str && args) {
    args.forEach(function (arg, i) {
      str = str.replace("%" + (i + 1), String(arg));
    });
  }
  return errorCode + ": " + str;
};

export const reserveCodeRange = function (first: number, last: number, moduleName: string): void {
  assert(first <= last, "Invalid code range");
  const noConflict = reservedCodes.every(function (range) {
    return last < range.first || first > range.last;
  });
  assert(noConflict, "Conflicting request for error code range");
  reservedCodes.push({ first, last, name: moduleName });
};
