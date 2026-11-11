// SPDX-License-Identifier: MIT
/** What kind of content an authored string is. Kept free of React and KaTeX, for pure modules. */

/** A text that is nothing but a URL is an image. */
export function isImageUrl(text: string): boolean {
  return /^https?:\/\/\S+$/.test(text.trim()) || text.trim().startsWith("data:image/");
}
