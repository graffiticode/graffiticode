# Annotation: `cleanup.log`'s soft-deleted count

`cleanup.log` is kept exactly as recorded. Its line "soft-deleted in thumbnails: 8" is a miscount: **the correct count is 3 soft-deleted generations.**

- **The cause:** the 8 came from `gcloud storage ls --soft-deleted --recursive gs://graffiticode-thumbnails/ | wc -l`. That listing prints prefix headers and blank lines as well as objects. Here it printed 3 object lines, 3 headers (`gs://graffiticode-thumbnails/:`, `…/c5b-probe/:`, `…/c5b-probe/r11190108/:`) and 2 blank lines.
- **The raw inventory,** read again at the time in `soft-deleted-inventory-at.txt`:
  - `soft-deleted-inventory.txt` (`ls --soft-deleted --recursive --long`) ends `TOTAL: 3 objects, 81 bytes`;
  - `soft-deleted-inventory.json` (`--json`) lists exactly three `cloud_object` entries.

| Object | Generation | Soft-deleted | Hard-delete | Why |
|---|---|---|---|---|
| `c5b-probe/r11190108/a.png` | `1795050625767789` | 2026-11-19T01:10:26.198Z | 2026-11-26T01:10:26.198Z | `a-create`'s object, replaced by `a-overwrite` |
| `c5b-probe/r11190108/a.png` | `1795050626078509` | 2026-11-19T01:13:53.636Z | 2026-11-26T01:13:53.636Z | `a-overwrite`'s object, removed by the operator's cleanup |
| `c5b-probe/r11190108/b.png` | `1795050626300479` | 2026-11-19T01:10:26.530Z | 2026-11-26T01:10:26.530Z | `b-create`'s object, removed by `b-delete` |

The owner's independent read-only inventory confirmed the same three generations. `after-cleanup.json` already lists them.
