// SPDX-License-Identifier: MIT
/**
 * Derived option ids, in one place.
 *
 * `choice` and `inline-choice` both hand out ids to options the author did not name, and the
 * spec tells authors the same thing about both — "derived as A, B, C…". Written twice they
 * agreed for the first twenty-six options and disagreed after that, which is exactly the kind
 * of divergence a shared rule exists to prevent.
 *
 * Its own module rather than the compiler's, so a DOM-free module can use it without importing
 * the compiler and the AST behind it.
 */

/** A, B, ... Z, AA, AB, ... — enough labels for any option list, in a familiar order. */
export function optionLabel(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}
