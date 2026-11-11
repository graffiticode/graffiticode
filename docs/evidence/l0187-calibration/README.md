# L0187 `FIGJAM_V1` calibration, 2026-10-30

L0187 measures text and sizes marks itself (design §6, §9), so its profile has to agree with
what FigJam draws. These measurements were taken in a scratch FigJam file (“L0187 calibration
(scratch)”, in the owner's Artcompiler drafts) through the Plugin API (`use_figma`). Each node was
created as the Graffiticode plugin creates it, then read back or screenshotted. The resulting
values live in `languages/l0187/crates/core/src/profile.rs`. The tests in `measure.rs` and
`size.rs` pin them.

## Font

- FigJam sticky, shape and text sublayers are **Inter Medium** (`variationSettings {wght: 500}`).
- FigJam's text-node widths are **Inter 3.19 Medium**'s shaped advances, rounded up. This held
  for every probe.

| Probe | FigJam | Inter 3.19, rounded up | Inter 4.1 |
| --- | --- | --- | --- |
| 16 “Hello world” | 86 | 86 (85.82) | 86.33 |
| 40 “Workshop agenda” | 347 | 347 (346.22) | 348.38 |
| 24 “Pairing helped us resolve the integration issues” | 542 | 542 (541.40) | 541.31 |
| 16 “AVATAR Wavy” | 107 | 107 (106.31) | 107.82 |
| 14 “Sprint retrospective” | 133 | 133 (132.74) | 132.20 |
| 96 “Huge” | 244 | 244 (243.95) | 245.11 |
| 24 “Launch 🚀 day” | 169 | 169 (168.39 with 🚀 at 1.25 em) | — |

- Inter 4.1's optical sizes made the fit worse. L0187 embeds `Inter-Medium.otf` from the Inter
  3.19 release (SIL OFL 1.1).
- Emoji: 🚀 at 24px is 30px wide, so the profile uses **1.25 em**. Emoji widths are reported as
  modeled, not native.
- Wrapping: at a fixed width, FigJam broke every probe exactly where L0187's greedy UAX #14 wrap
  breaks it. Probes: 24px at 200, 16px at 120, and a 24px sticky.

## Line heights

- **Text node (AUTO):** each line is `round(1.21 × size)` pixels: 14→17, 16→19, 24→29, 40→48,
  96→116. A k-line node is exactly k times that.
- **Sticky and shape sublayers:** `PERCENT 150`.

## Stickies

- The width is fixed: 240 square, or 416 when `isWideWidth` is set. The plugin cannot resize a
  sticky.
- A sticky grows taller to fit its text. Its height is
  `max(240, 48 + size × (1.5 × lines + 0.5))`.
  - This is exact at 16px (8, 10 and 14 lines) and 24px (6, 8 and 10 lines).
  - At 40px FigJam drew 304 where the model gives 308. The model may run taller than FigJam, never
    shorter.
- The text wraps at width − 32:
  - square: a 206.7-wide word fits, a 211.5-wide one wraps;
  - wide: 381.x fits, 383.7 wraps.
  - The profile pads 17 per side.

## Shapes

- The default shape is 176×176, with a 4px stroke and 16px text.
- A shape at the default size grows taller to fit its text. A **resized** shape does not: its
  text is truncated with an ellipsis. So the compiler's size must hold the text.
- The text area is not a fixed share of the width. The profile's bounds sit under every observed
  “held on one line” width; widths are in the table below.
- Heights:
  - the default SQUARE grows as `36 × lines + 32` at 24px, so the text height is h − 32;
  - the DIAMOND grows as `72 × lines + 88`, so its text height is (h − 88) / 2;
  - a 320×440 DIAMOND showed five of six lines.

Each cell is the widest word held on one line ↔ the narrowest that wrapped, at 24px:

| Kind | 176×176 | 300×300 | 480×280 | Profile rule |
| --- | --- | --- | --- | --- |
| SQUARE, ROUNDED_RECTANGLE | 145.4 ↔ 147.5 | 239.8 ↔ 251.7 | ≥ 423.8 | w − 0.205 × min(w, h) |
| ELLIPSE | 112 ↔ 128 | 215.2 ↔ 227.2 | 343.4 ↔ 351.7 | 0.715 w |
| DIAMOND | — | 143.4 ↔ 155.5 | 231.4 ↔ 239.8 | 0.475 w |
| PARALLELOGRAM_RIGHT | — | 155.5 ↔ 167.8 | ≥ 263.3 | 0.515 w |
| PREDEFINED_PROCESS | 96 ↔ 105 | 203.6 ↔ 215.2 | ≥ 383.7 | 0.88 w − 61 |
| DOCUMENT_SINGLE, ENG_DATABASE | — | 263.3 ↔ 275.3 | ≥ 443.7 | w − 37 |

Screenshots: `diamond-300.png` (diamonds at 300×300 with probe words of rising width) and
`square-480x280.png`.

## Verification of compiled marks

Marks compiled by L0187 were drawn at their compiled sizes:

- **Stickies and textboxes** (`compiled-marks.png`): every native size equals the model. This
  covers square and wide stickies, including a wide sticky grown to 312, and textboxes at 24px and
  40px, including emoji.
- **Shapes** (`compiled-shapes.png`): one long text in each of the eight kinds, at the size L0187
  chose.
  - Nothing is truncated.
  - SQUARE, ROUNDED_RECTANGLE, ELLIPSE, PARALLELOGRAM_RIGHT, DOCUMENT_SINGLE and ENG_DATABASE
    break their lines exactly where L0187 does.
  - DIAMOND and PREDEFINED_PROCESS break in different places, because their modeled areas are
    deliberately narrower. Native text fit for shapes stays an **unverified** check in the report
    (design §8).

## Connectors

L0187 draws every connector as straight legs between fixed points: the side magnets and
compiler-placed waypoints. The plugin already draws a waypoint route this way, one FigJam
connector per leg. Compiled routes for `flow-return`, `parallel-three` and `self-loop-parallel`
were drawn this way, with straight legs between the emitted magnets and waypoints, and each leg's
bounding box was read back:

- Every leg is a straight, zero-thickness segment between exactly the emitted points. For example,
  `valid-save`'s middle leg runs from 583,200 to 583,88, and its label box is centred on that leg.
- A leg attached to a mark starts or ends **8px off the mark's edge**. For example, from Valid's
  right magnet at x=506 the leg began at 514; into Save's left magnet at 660 it ended at 652. The
  router models this as `route::ENDPOINT_GAP` when it places a label on a leg that touches a mark.

## Phase 7: native fidelity (2026-10-30)

Thirteen compiled boards were drawn into the scratch file with the figma-plugin's own positioned
drawing code (graffiticode/figma-plugin#3, plugin data shimmed, since `use_figma` cannot set it):
flow-return (the spec's processing flow), agenda, retro, name-collision, self-loop-parallel,
parallel-three, sticky-grows, all-properties, thick-strokes, duplicate-page-names (week-2),
repair-loop, auto-mixed and cross-section-flow (the "L0187 fidelity: …" sections at x ≥ 9960).
Each native node's bounding box was read back and compared with the compiled board:

- **Marks and sections:** every sticky, shape, textbox and section is exactly at its compiled box,
  including FigJam's own growth. The wide sticky grew to 416×312, textboxes wrapped natively at
  their compiled width to exactly the compiled height (48, 29, 58 for two lines, 232 for two lines
  at 96px), and section members are in their absolute places.
- **Connectors:** every leg runs between the emitted magnets and waypoints, with the 8px endpoint
  gap; self-loops, caps on the outer ends, and parallel connectors labelled on distinct legs all
  draw as the preview shows them.
- **Labels:** FigJam puts the label exactly at its leg's midpoint, which is what the compiler
  models, but its box was larger than modeled: 41 high at 16px where the compiler assumed 29, and
  77 at 40px where it assumed 60. A direct probe (free-point straight legs, `Yes`, a two-line
  label, `Wide label text`, `Retry`, at 16/24/40/64px with 4 and 8px strokes) found that FigJam
  sets labels in Inter Medium at 150% line height with −1.1% letter spacing, in a box:
  - `lines × 1.5 × size + 13 + stroke` high, exact in every case;
  - `text + pad + stroke` wide, with pad 13 at 16px, 21.5–23.5 at 24, 38.5 at 40 and 64 at 64.

  `profile::label` now models exactly that height, and a width padded by a full em, measured
  without the letter spacing, so the modeled box is never narrower than FigJam's (it is at most
  3px wider). The preview draws labels at 150%. Eight test boards re-routed for the larger labels;
  all are still accepted.

## Not calibrated

- The section title band: FigJam draws a section's name as editor chrome that the Plugin API
  cannot read back and screenshots do not render. It stays a modeled reservation (L0186).
- Text-area heights for ELLIPSE, DOCUMENT_SINGLE and ENG_DATABASE beyond L0186's modeled insets.
- Shape text at sizes other than 24px.

With the font calibration and the phase 7 comparison done, `FIGJAM_V1` is **frozen**: any geometry
change from now on needs a new profile tag.

## `FIGJAM_V2`: Chinese and Japanese text, 2026-11-11

`FIGJAM_V1` rejects text Inter has no glyph for, so an L0187 board in Chinese could not compile
(the generator then translated it into English to get a board). These probes were run in a
scratch FigJam file (“L0187 CJK probe (scratch)”, Artcompiler drafts) through the Plugin API,
with text set in Inter Medium as the plugin sets it. The text node still reports Inter Medium;
FigJam draws the CJK characters from a fallback font (Noto Sans SC/TC/JP/KR are in the file's
font list; which one draws them was not read back, and it does not affect the metrics).

- **The fallback loads lazily.** The first nodes created in a fresh file were laid out before
  the fallback font loaded, at 65/64 em a character. Read again later, the same nodes (and fresh
  ones) are exactly 1 em. Only the settled values below are used.
- **Widths: 1 em a character.** Auto-width text nodes, width as FigJam reports it:

| Probe | Size | FigJam | Model (Inter + 1 em per CJK), rounded up |
| --- | --- | --- | --- |
| 业 | 16, 24, 40, 64, 96 | 16, 24, 40, 64, 96 | same |
| 业务读写 | 16, 24, 40 | 64, 96, 160 | same |
| 一二三四五六七八九十 | 16, 24 | 160, 240 | same |
| ，。：？ | 16 | 64 | 64 |
| 、「」【】《》 | 16 | 112 | 112 |
| ひらがなカタカナ | 16 | 128 | 128 |
| ＡＰＩ１２３ | 16 | 96 | 96 |
| 鑫龘𠀀, 業務資料庫 | 16 | 48, 80 | 48, 80 |
| 镜像迁移头与对应业务库版本一致？ | 16 | 256 | 256 |
| 旧业务 API | 16 | 78 | 78 (48 + 29.98) |
| 前端请求 → 本机 API :7291 | 16 | 196 | 196 (96 + 99.30) |

- **Not one em, so still unsupported:** Hangul (한국어데이터: 14.83px a character at 16px,
  proportional) and half-width katakana (ｱｲｳｴｵ: 8px, half an em).
- **Line heights are unchanged:** fixed-width nodes of 4 lines at 16px are 76 (4 × 19), of 6 lines
  at 24px are 174 (6 × 29), as `profile::text_line` gives.
- **Wrapping is UAX #14, greedy, as for Latin text.** Screenshots of fixed-width nodes: FigJam
  breaks between any two ideographs, never starts a line with closing punctuation (at width 130,
  `业务数据各自存放，…` breaks before `放` so that `放，` stay together), and holds a line exactly
  as wide as the box. Mixed text breaks at spaces and between ideographs
  (`旧业务 API 与 / Worker 共用连 / 接` at 120).
- **Whole board.** Every sticky and shape of the `cjk-databases` test program, drawn at its
  compiled size, held its text with nothing truncated; stickies wrapped exactly at the compiled
  lines, and shapes (whose modeled text area sits inside FigJam's) never needed more room.

`measure.rs` pins these values (`cjk_widths_match_figjam`, `cjk_wraps_where_figjam_does`).
Every text `FIGJAM_V1` accepts measures the same under `FIGJAM_V2`, and all 76 earlier test
boards compile byte-identically; V1 boards are unchanged.
