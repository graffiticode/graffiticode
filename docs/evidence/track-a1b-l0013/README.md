# Track A1b: L0013 switch evidence (2026-11-02)

L0013's conformance corpus excludes a successful `snap`, so its evidence is captures of real
items. `l0013r` first failed closed without an isolated bucket (PR #242), then wrote to
`gs://graffiticode-l0013-evidence` (PR #243; IAM review Step 16) while `paired-captures.py` took
the same public items on production `l0013` (TypeScript, writing production thumbnails, as any
snap does; the owner allowed testing in production) and `l0013r`, and compared them
(greyscale mean absolute difference, share of pixels off by more than 32/255).

Findings, in order:
- **Fonts.** `l0013r`'s image carried Liberation and Noto; TypeScript's carries GNU FreeFont. The
  View's UI text rendered in another face and the content-aware crop shifted. Fixed (PR #245):
  `wI9f…` went from 0.23% to identical.
- **Switched languages' forms.** Captures of items in switched languages failed on **both**
  services (`ERR_PROXY_CONNECTION_FAILED`): `/form` redirected to `lNNNNr` run.app hosts, which
  Chrome's PAC and L0013's egress allowlist don't reach. Fixed by routing every switched language
  through its own domain (option C, PR #246, api `rmvzmzysd-1ab92d`).
- **After both fixes** (`paired-captures-after-domains.txt`): `hz2…` 0.03%, `mGp…` 0.09%,
  `wI9f…` 0.0%, same sizes; `j6dq…` 0.02% (`paired-captures-after-fonts.txt`). `gcq5…` differs
  only by its deck's random first card. `I4mY…` (an L0179 spreadsheet): **TypeScript captured a
  blank page** (photographed before the sheet rendered) and wrote it to production; Rust captured
  the sheet. That thumbnail is re-snapped through Rust after the switch.
- Private items are refused without an owner token on both, as before.

The switch: `l0013r` writes `graffiticode.appspot.com` (`l0013r-run` already had access),
`l0013.graffiticode.org` maps to `l0013r`, and the api routes `BASE_URL_L0013` to the domain with
`COMPILE_GENERATION_L0013=rust-1`. Rollback: `BASE_URL_L0013` → `l0013`'s run.app URL (it stays
deployed, still on the production bucket).
