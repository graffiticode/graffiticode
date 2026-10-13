# Amortization-schedule formulas are not currently supported

2026-09-16. Found by asking the generator (via MCP `create_item` → `update_item`) for a mortgage
calculator and then "a yearly amortization schedule". The calculator half works; every cell of the
schedule renders `#NAME!`. The item compiles with `errors: []`, so nothing in the pipeline noticed.

- Item: `29MkgtpvYXLKwwzZpAqQ` — https://app.graffiticode.org/form/29MkgtpvYXLKwwzZpAqQ
- Every probe below was run against `evalCell` (`packages/view/src/sheet/formula.ts`) at
  `origin/main` = `84dcf5c`, which includes POWER (`b3af1bc`) and translatex 0.25 comparisons
  (`b99fcac`). The deployed form agrees: B9's `POWER` payment shows `$2,022.62`, and the schedule
  shows `#NAME!`.
- Note: the local `~/work/graffiticode/l0179` checkout was 9 commits behind when this was written
  (no POWER, broken comparisons). Probing it gives a much worse picture than production.

## What the generator wrote

Inputs B1–B4 (price 400000, down 80000, rate 0.065, term 30), results B6–B11. These all work:

```
B6  =B1-B2
B7  =B3/12
B8  =B4*12
B9  =ROUND(B6*B7*POWER(1+B7,B8)/(POWER(1+B7,B8)-1),2)     → 2022.62  ✓
B10 =B9*B8                                               → 728143.20 ✓
B11 =B10-B6                                              → 408143.20 ✓
```

Schedule, header row 13, one row per year for rows 14–43. Year N is in column A:

```
B14 =IF(A14<=$B$4,$B$6,"")                        beginning balance (row 15+: =IF(A15<=$B$4,F14,""))
C14 =IF(A14<=$B$4,12*$B$9,"")                     payments this year
D14 =IF(A14<=$B$4,C14-E14,"")                     interest this year
E14 =IF(A14<=$B$4,B14-F14,"")                     principal this year
F14 =IF(A14<=$B$4,ROUND($B$6*POWER(1+$B$7,12*A14)-$B$9*((POWER(1+$B$7,12*A14)-1)/$B$7),2),"")
                                                  ending balance (closed-form remaining balance)
```

The formulas are correct spreadsheet math. Excel or Sheets would compute them.

## Why it fails, in order of impact

### 1. Absolute references (`$B$4`, `B$4`, `$B4`) are not supported

This is the one that turns every schedule cell into `#NAME!`.

| Formula   | Result   | Notes                                   |
|-----------|----------|-----------------------------------------|
| `=$B$6`   | `#NAME!` | error: `Undefined name: B` (misleading) |
| `=B$6`    | `#NAME!` | `Undefined name: B`                     |
| `=$B6`    | `"$B6"`  | **silent**: the literal text, type text |
| `=12*$B$9`| `#NAME!` | `Undefined name: B`                     |

Mechanism:
- The pre-evaluation name check in `evalCell` scans `/([A-Za-z][A-Za-z0-9_]*)/g`. In `$B$6` that
  yields the bare token `B`, which is neither a cell name (`^[A-Za-z]+[0-9]+$`) nor a function, so
  the cell is rejected as `#NAME!` before TransLaTeX ever sees it.
- The dependency parser `CELL_REF = /\b([A-Z]+[0-9]+).../` in `sheet/graph.ts` finds no reference in
  `$B$6`. Even if evaluation accepted the syntax, the cell would have **no edge** to B6 and would
  not recalculate when the input changes.
- `$B6` gets past the name check (it matches `B6`) but the parser does not understand `$`, so it
  evaluates to the literal string.

A generator writes `$` whenever it builds a table of rows that point back at shared inputs, which
is the normal shape of any schedule, projection or lookup table. Since a Graffiticode sheet
is authored cell by cell and never filled down, `$` means nothing here. Stripping it (`$B$4` → `B4`)
before both the name check and `CELL_REF` would be semantically exact.

### 2. String literals (`""`) are not supported

The "blank past the loan term" idiom is `IF(cond, value, "")`.

| Formula                | Result   | Notes                                    |
|------------------------|----------|------------------------------------------|
| `=""`                  | `#NAME!` | `Invalid character """ (34) in input.`   |
| `="abc"`               | `#NAME!` | same                                     |
| `=IF(A14<=B4,B6,"")`   | `#NAME!` | same, although the `IF`/`<=` part is fine |
| `=IF(A14<=B4,B6,0)`    | `320000` | ✓ works with a numeric else-branch       |

So with `$` fixed, every schedule cell would still fail on its `""`. There is no way to express
"show blank" from a formula today.

### 3. Comparisons work only as an `IF` condition

`<=` is fine inside `IF` on main. All of these are correct: `IF(A2<=A1,5,7)`→7,
`IF(A1<=A1,5,7)`→5, `IF(A2>=A1,5,7)`→5, `IF(A1>=A2,5,7)`→7,
`IF(A14<=B4,C14-E14,0)`→20695.91. (`<>` was always true; fixed, see item 7 under Fix.)

A bare comparison as a cell's value does not parse:

| Formula      | Result   | Notes                                                        |
|--------------|----------|--------------------------------------------------------------|
| `=A14<=B4`   | `#NAME!` | `Extra characters in input at position: 6 … prefix: "=B4"` |

(`=(A1<=A2)*5` → `5`, which happens to be right for A1=2, A2=3. I didn't dig into it further.)

Not needed for the schedule; recorded because a `#NAME!` from a parse error looks like a missing
function.

### 4. `^` is silently wrong (not used here, but the obvious fallback)

The instructions list `POWER`, and the generator used it. The natural alternative to `POWER` is
`^`, and it returns **wrong numbers with no error**:

| Formula       | Result                  | Expected   |
|---------------|-------------------------|------------|
| `=2^3`        | `2`                     | 8          |
| `=(1+B7)^B8`  | `1.00541666666666667`   | ≈ 6.99     |
| `=A1^A2`      | `"A1"` (text)           | 8          |

The exponent is dropped. A mortgage formula written with `^` would compile, render a plausible
dollar figure, and be wrong. That's worse than `#NAME!`.

### 5. No financial or common math functions

`evalRules.types.fn` is `average, if, mul, power, round, sum`. Each of these returns
`#NAME!`, `Undefined name: <FN>`:

- Financial: `PMT`, `IPMT`, `PPMT`, `FV`, `CUMIPMT` (and by extension `NPER`, `RATE`, `PV`, `CUMPRINC`)
- Math: `MAX`, `MIN`, `ABS`, `EXP`, `LN`

The closed-form balance above is the workaround the generator found, and it is correct
(`=ROUND(B6*POWER(1+B7,12*A14)-B9*((POWER(1+B7,12*A14)-1)/B7),2)` → `316423.25`, which matches an
iterated 12-payment schedule to the cent). A schedule that states principal/interest per period
naturally wants `IPMT`/`PPMT`, and a last row that shouldn't go negative wants `MAX(0, …)`.

### 6. Blank and error cells don't propagate (synthetic env; verify in the real grid)

With a leaf cell whose `val` is `""` (T1) or `"#NAME!"` (N1):

| Formula            | Result  | Excel         |
|--------------------|---------|---------------|
| `=T1*2`            | `2`     | 0             |
| `=T1+1`            | `1`     | 1             |
| `=N1*2`            | `2`     | `#NAME?`      |
| `=N1+1`            | `1`     | `#NAME?`      |
| `=IF(A1>A2,5,T1)`  | `"T1"`  | 0 / blank     |

A missing operand seems to fall back to the other operand. If that holds in the real recalculation
env, then once `""` is supported, a row past the term (`=C44-E44` over blank cells) would show
numbers instead of blanks, and a `#NAME!` upstream would be hidden downstream. In this item every
schedule cell has its own `$`, so the screenshot doesn't show propagation either way.

## Why nothing caught it

- **Compile is blind to formulas.** `text "=…"` is an opaque string to the compiler, so an item
  full of `#NAME!` compiles with `errors: []`. The console's repair loop only sees compile errors,
  so it had nothing to fix. `check-corpus.mjs` and `check-published.mjs` have the same hole: they
  compile, and they never evaluate.
- **The instructions only name what exists.** `packages/core/spec/instructions.md` says
  "Available in formulas: `SUM`, `AVERAGE`, `ROUND`, `POWER`, `IF`, and arithmetic." It says nothing
  about `$`, string literals, bare comparisons or `^`, and those are the syntax a model reaches for by
  default.

## Fix: support what the generator writes

Policy: when the generator writes a standard spreadsheet formula, the engine gains support for it.
We don't steer the generator away from it. What a model writes by default is also what a learner
types into a cell, so an instructions-side ban would fix only the generated half, and it would
fight the model's priors on every generation.

1. ~~`$` absolute references~~: **done** (uncommitted). `stripAbsoluteReferences` in
   `scoring/normalize.ts` runs before the name scan, `CELL_REF`, `prepareFormula` and
   formula-method scoring.
2. ~~String literals~~: **done** (uncommitted). `bindStringLiterals` in
   `translatex-extensions.ts` binds each literal to a synthetic reference, so `""` blanks the
   cell, `"Yes"`/`"No"` come through IF, and `=W1="hello"` compares as text. A non-numeric
   literal used in arithmetic (`=A1+"x"`) is `#VALUE!`. With both fixes, the mortgage item
   recalculates with 0 errors, and a 15-year term blanks rows 29–43.
3. ~~`^`~~: **done** (uncommitted). `prepareFormula` spells `a^b` as `POWER(a,b)`, left-associative
   with unary minus on the base, as in Excel (`2^3^2` = 64, `-2^2` = 4). The parser's own `^` is
   a LaTeX superscript (`2^10` → 20), so a rule for it would have been wrong.
4. Bare comparisons as a cell value (`=A14<=B4` → TRUE/FALSE).
5. Functions: ~~`MAX`, `MIN`, `ABS`~~ **done** (uncommitted); still missing `EXP`, `LN`, and the financial set `PMT`, `IPMT`, `PPMT`,
   `FV`, `PV`, `NPER`, `RATE`, `CUMIPMT`, `CUMPRINC`.
6. Propagate errors, and treat blank as 0 in arithmetic.
7. ~~`<>` is always true~~: **done** (uncommitted). `prepareFormula` spells it `!=` outside
   quoted text. Was: always true, on numbers and on text: `IF(A1<>A2,1,0)` is 1 when A1 = A2. `!=` works,
   and the comparison tests cover only `!=`. Found while testing strings. Same class as the
   comparison bug fixed in `b99fcac`.

Once each lands, add it to the "Available in formulas" line in `instructions.md`. That line
describes what the engine supports. It isn't where limits get enforced.

Detection (so the next gap is caught):
- Evaluate every formula cell of a compiled item (e.g. via `recalc`) and treat any `#NAME!` /
  `#CYCLE!` as a failure, in the console repair loop and in `check-corpus.mjs` /
  `check-published.mjs`. Compile-clean isn't evidence that a sheet works.

## Reproducing

```ts
import { evalCell } from "./packages/view/src/sheet/index.ts";
const leaf = (v) => ({ text: v, formula: v, val: v, type: "number" });
const cells = { A14: leaf("1"), B4: leaf("30"), B6: leaf("320000"),
                B7: leaf("0.00541666666666667"), B9: leaf("2022.62") };
for (const p of ["=$B$6", "=IF(A14<=B4,B6,\"\")", "=2^3", "=PMT(B7,360,-B6)"]) {
  const r = evalCell({ env: { cells: { ...cells, X: { text: p, formula: p } } }, name: "X" });
  console.log(p, "=>", r.val, r.error ?? "");
}
```

Run with `npx tsx` from the repo root on a checkout of `origin/main`.
