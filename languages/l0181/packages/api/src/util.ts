// SPDX-License-Identifier: MIT
export function isNonEmptyString(str: unknown): str is string {
  return typeof str === "string" && str.length > 0;
}

export function isNonNullObject(obj: unknown): boolean {
  return typeof obj === "object" && obj !== null;
}
