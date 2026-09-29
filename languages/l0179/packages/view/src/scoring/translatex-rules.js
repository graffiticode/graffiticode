// SPDX-License-Identifier: MIT
/**
 * The rule sets translatex does NOT generate.
 *
 * `evalRules` used to live here too and no longer does: translatex 0.25.0
 * derives it — including `words` and `types.fn` — from the function registry, so
 * adding a function is one descriptor instead of four edits that have to agree.
 * See translatex-extensions.ts.
 *
 * `cellNameRules` is gone outright. It was for dependency extraction, which
 * stopped going through TransLaTeX when the rule set turned out to glue the
 * function name onto the first cell name (`=SUM(A1:A3)` -> ["SUMA1","A2","A3"],
 * losing A1). sheet/graph.js parses the references directly now.
 *
 * These two remain because they have no registry to be derived from: they are
 * presentation and comparison, not a vocabulary of functions.
 */

export const formatRules = {
  "rules": {
    "??": [
      "%1%2"
    ],
    "-\\type{number}": [
      {
        "%1": {
          "\\type{number}": "$fmt{isNegative:true}",
        },
      },
    ],
    "\\type{number}": [
      "$fmt{isNegative:false}"
    ],
    "?": [
      "%1"
    ]
  },
}

export const normalizeRules = {
  "types": {
    "cellName": [
      "\\type{variable}\\type{integer}"
    ],
    "cellRange": [
      "\\type{cellName}:\\type{cellName}"
    ],
    "fn": [
      "average",
      "if",
      "mul",
      "power",
      "round",
      "sum",
    ]
  },
  "rules": {
    "=\\type{cellName}": [
      "$cell"
    ],
    "=?": [
      {
        "%2": {
          "\\type{cellRange}": "%1:%2",
          "\\type{fn}(\\type{cellRange})": "$normalize",
          "?+?": "$normalize {\"acc\": [\"SUM\"]}",
          "?-?": "$normalize {\"acc\": [\"SUB\"]}",
          "?*?": "$normalize {\"acc\": [\"MUL\"]}",
          "?/?": "$normalize {\"acc\": [\"DIV\"]}",
          "?%": "$percent",
          "-?": "$minus"
        }
      }
    ],
    "\\type{cellRange}": [
      "$range"
    ],
    "\\type{cellName}": [
      "%1%2"
    ],
    "\\type{fn}(\\type{cellRange})": [
      "%1(%2)"
    ],
    "??": [
      "%1%2"
    ],
    "?": [
      "%1"
    ]
  },
}
