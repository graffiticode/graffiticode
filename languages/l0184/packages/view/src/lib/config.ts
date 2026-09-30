// SPDX-License-Identifier: MIT
/**
 * What decides whether a chart instance is touched on recompile.
 *
 * Every compile produces new objects, so identity says nothing: two configs are the same when
 * their stable serializations are. The RENDER config (`option` plus formatting descriptors) is
 * replaced with `notMerge` when it changes; the INIT config (theme, renderer, locale) can only
 * change by recreating the instance. Size and name are neither: a size change resizes, a name
 * change only relabels the tab — both keep the chart's zoom and legend selections.
 */

/** JSON with object keys sorted, so key order never reads as a change. */
export function stableStringify(v: any): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => v[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export const renderKey = (option: any, formats?: any): string => stableStringify({ option, formats: formats ?? null });

export const initKey = (theme: string, renderer: string, locale: string): string => `${theme}|${renderer}|${locale}`;
