# B6 repair drive: command repair and materialization, live (2026-11-14/15)

The drive of `docs/b6-command-repair-plan.md` slice 5 ("The drive, in detail"), run with `scripts/b6-drive.js` from `main`. Each phase's own checks are in `drive-state.json` (`runs`, with every check's detail). The extracts under `extracts/` are the call-line, Broker audit, proxy and l0185r records the checks used, plus the reads I made by hand where a condition went beyond the drive's own checks.

**Verdict: passed.** `report` (run `bed54b`) passed 4 of 4:
- every mandatory phase's latest run passed;
- every scenario was exercised, with its evidence and minimum cases;
- **13 distinct completed repairs**, each published as its original invocation's artifact, where at least 10 were required;
- no write was repeated, with complete dispatch evidence for **60 operation ids**.

Two phases needed a fix to the drive before passing, both merged before the run they judge (below). No service, Policy or api change was needed.

## Where it ran

The canary account (`995cc0bc…`) wrote through its Learnosity sandbox connection only (`conn-686c62bc…`), in canary window `canary-window-b6`. The window is the operator's time-limited OpenIdTokenCreator grant on `api-run` and `console-run@graffiticode-app`, which expires 2026-11-17T08:00Z (IAM review, Step 24).

| Service | Release | What it is |
| --- | --- | --- |
| `api-drive` | `api-drive-rmwgzyoy6-72e9c0` | the api from `edf39b71`, with `REPAIR_L0176=on`, generation `b6-drive-1` and `BASE_URL_L0176` = l0176r-drive. It has no sweeper; production's api sweeps its commands. |
| `l0176r-drive` | `l0176r-drive-rmwgzicgi-ac4468` | approved; its preflight reports `replay: 1`. `BROKER_URL` = broker-faults, on `compilers-l0176` behind the egress proxy. |
| `broker-faults` | `broker-faults-rmwgz4tyc-7434cd` | the Broker, with `BROKER_FAULT_PRINCIPALS` = the canary uid. Private: invokable by `l0176r-run` and `deploy-smoke` only. |

- **Proxy:** config `d7f974b7…` on template `egress-proxy-647de380be30`; `verify-rollout.js` reported `ok` on both VMs. It gained `broker-faults-sja7fatcta-uc.a.run.app` for `compilers-l0176`, and one L0185 open exception: `storage.googleapis.com`, GET at exactly `/graffiticode-b6-drive/source.json`. The production canary passed 36 of 36 after the rollout (`canary-kkvgc`).
- **Source:** `gs://graffiticode-b6-drive/source.json`, public, `no-store`, holding `{"label": <tag>}` (#391).

**Faults.** Each fault was set with `gcloud run services update … --update-env-vars` (or `--remove-env-vars`), which creates an unnamed revision, followed by `update-traffic --to-latest`: the release revision keeps its tag, so traffic would otherwise have stayed on it. Each serving revision's environment was checked before its phase ran. The production `broker` and `api` never carried a fault variable.

| Revision | Fault | Phases |
| --- | --- | --- |
| `broker-faults-00003-b2f` | `BROKER_FAULTS=fail-write` | originals-fail |
| `broker-faults-00004-4tz` | `BROKER_FAULTS=drop-outcome` | originals-drop |
| `broker-faults-00005-q7d` | none | every later phase |
| `api-drive-00003-sbw` | `API_COMMAND_FAULTS=exit-after-output` | boundary |
| `api-drive-00004-5wd` | none | source-change, retries, report |

## Results

| Run | Phase | Result |
| --- | --- | --- |
| `da5eca` | checks | failed: the L0185 → L0176 program compiled with an empty `lrn-id`. A single-key `{"tag": …}` object is read by the kernel as a tag value, not a record. Fixed by #391 (`{"label": …}`). |
| `0a8004` | checks | passed 17 of 17 (from #391's branch; writes nothing). |
| `c48a46` | originals-fail | passed. 9 originals, all `failed`, every outcome a provider rejection: failed-only (one, two, map of 3; two each), the exclusion original, and two L0176 → L0176 stacks whose lower save fails (resume). Each recorded and admitted with replay. |
| `0b6634` | originals-drop | passed. Originals 9–14, all `uncertain` with no result: head lost (9, 10), lower lost (11, 12), source change over the source at `b6drive-0b6634-old` (13, 14). |
| `48eb93` | originals-narrow | passed. Originals 15 and 16 (2-element maps) narrowed to `init` after the first write's final outcome: A completed, B failed. Original 17 (10-element map) narrowed after the first claim: one occurrence `partial`, nine `failed`. The connection's owner permissions were `null` (unrestricted) before and read back `null` after. |
| `bb520f` | probes | passed. Selecting a completed (15), a partial (17) and an uncertain (9) occurrence was refused 409 `not-eligible`; the uncertain command with no selection 409 `nothing-to-repair`. Ledger and Broker claims unchanged, and no Broker entry in the window. |
| `fdf900` | repairs | passed 19 of 19. 10 repairs, all completed and published as the original's artifact, each failed-only and partly repair selecting exactly its failed occurrences. |
| `68c1e1` | exclusion | the race: 8 concurrent repairs of the exclusion original. Its check failed, though the exclusion held: the api answers 200 once it has allocated a repair, and the 7 losers were refused at admission. Fixed by #392, which judges from the records. |
| `78794b`, `6cfc0c` | exclusion | `--rejudge 68c1e1`, passed 3 of 3, from #392's branch and from `main`: one repair admitted (`x6`), the other 7 refused `occurrence-claimed`, one ledger entry held by `x6`, one write; `x6`'s key answers the same repair. No Broker entry during either re-judge. |
| `e25a28` | reconcile | passed 7 of 7. Originals 9–14 through Policy's `/v1/receipts/reconcile` as the console: each `applied`, final, from evidence, and recorded `completed` in the ledger (source `reconciliation`) with its output. |
| `2a8901` | dropped | passed 5 of 5. 9 and 10 materialized `published: "current"`; 11 and 12 repaired with an empty selection, the lower stage rebuilt by replay and the head run. |
| `e6391d` | boundary | passed 2 of 2. Two L0185 → L0176 commands; api-drive exited after L0185's output was recorded, the source was changed, and the production sweeper finished each from the recorded output. |
| `e0fbfe` | source-change | passed 3 of 3. Originals 13 and 14 materialized after the source changed, from the recorded L0185 output. |
| `a04b53` | retries | passed 14 of 14. All 13 counted repairs, re-sent by their own keys, answered their own completed records. |
| `bed54b` | report | passed 4 of 4. |

## What I checked beyond the drive's checks

The owner's review of each phase set conditions some of which the drive doesn't check itself. Each was read by hand; the outputs are in `extracts/`.

- **Partly completed (15, 16): A keeps its reference and has no new dispatch** (`partly-artifact-references.json`). Broker derives a reference as `gc-<first 16 hex of sha256(opid)>-<sent reference>`, with `opid` = `<invocationId>/<stage>/<occurrenceId>`. The extract is a read-back of each artifact through api-drive, with A's and B's occurrence ids, the original and repair invocation ids, each operation's expected prefix and the references matching it. Each artifact holds exactly two references: A's under the original's operation, B's under the repair's, none unmatched, and neither A under the repair's prefix nor B under the original's. Both were sent as `…-0` (one save per map element), so only the prefix tells them apart. In Broker's audit, A has one claim and its dispatches under the original's operation id only, and nothing under the repair's.
- **Exclusion: one ledger winner and one write** (`manual-exclusion-records.txt`). The ledger's one entry is `claim: "admission"`, held by `x6`. The 7 losers are `phase: "allocated"` with `admissionRefusal: occurrence-claimed`, no stages, no receipts and no audit entries. `x6` made one Broker `execute`, with `items` and `questions` dispatched once each. The losers' refusal record keeps only the reason; the ledger's `repairId` names the winner, which the owner accepted as sufficient (#392).
- **Reconcile: the originals stay `uncertain`** (`manual-dropped-status-before-reconcile.txt`, `manual-dropped-status-after.txt`). Before and after, each of 9–14 is `uncertain` with result `unavailable`, its outcome `uncertain` and its counts unchanged. Only the ledger says `completed`. Broker logged no execute or dispatch in the reconcile window, only its six `reconcile` entries.
- **Dropped: no provider dispatch for 9 and 10, one head write each for 11 and 12.** In the phase window Broker has exactly two `write-items` executes, each under a lower-lost repair's `s0`, each step once, and nothing under any `s1`. The only other entries are two `sign-questions-preview` signings at `init`, the drive's read-back of the artifact through the connection.
- **Boundary: production-sweeper recovery, the old label, no L0185 call after the crash, one write** (`manual-boundary-pinned-and-saved.jsonl`, `api-call-lines.json`). The production api (`api-rmwfmheue-b24633`) logged `resuming at s0, from s1's recorded output`, `call start s0` and `recovered at generation 2, completed` for both. The pinned `s0` input equals the recorded L0185 output, whose label is the old tag, and the saved reference was sent under it. l0185r has one `/interpret` per case, before the crash. Each command made one Broker `write-items`.
- **Retries: no new claim or dispatch.** No Broker execute or execute-step entry, and no api call line, from the first retry to two minutes after the last.

## Corrected proxy counts

The drive's `proxyFetches` matched `textPayload`, but the proxy logs structured entries (`cos_containers`, `jsonPayload.host` and `.path`), so it found nothing and the boundary runs recorded `proxyFetches: 0`. No verdict used it. This PR fixes the query. The corrected counts, from `proxy-source-fetches.json`, are one fetch per L0185 run, each allowed and 200 `via_upstream`:

| At (UTC) | Run | Case |
| --- | --- | --- |
| 00:16:25, 00:16:25 | `0b6634` | originals 13 and 14 |
| 01:18:56 | `e6391d` | boundary 0, before its crash |
| 01:20:45 | `e6391d` | boundary 1, before its crash |

None during recovery or `source-change`: each l0185r request in `l0185r-interpret-requests.json` (00:16:19, 00:16:24, 01:18:56, 01:20:38) is one of these.

## Writes

Every `write-items` execute in the drive's window (`broker-audit.json`, the canary connection, 2026-11-15 00:00–01:45 UTC) is under a drive invocation: 49 executes, all through broker-faults.

| | Executes |
| --- | --- |
| repairs, completed | 21: failed-only 12, partly 2, resume 4 (lower and head), exclusion 1, lower-lost 2 |
| originals, failed | 17: the fail-write originals' 15, and B of 15 and 16 |
| originals, completed | 2: A of 15 and 16 |
| originals, partial | 1: original 17's cut write |
| originals, uncertain | 6: originals 9–14 |
| boundary, completed | 2 |

**The production canary overlapped.** The scheduled production canary `canary-chk8r` (`23 */6 * * *`) ran 00:23:06–00:26:23 through the production api and Broker on the same connection. Its entries are separated into `broker-audit-production-canary.json`: two saves, previews, its denied `CANARY_AUTHOR` check and a receipt replay. `originals-narrow` narrowed the connection between 00:24:08 and 00:24:50. None of the canary's Broker operations fall in that window (its writes were at 00:23:38–48, its next entry at 00:26:05), and the canary job succeeded.

## Extracts

| File | What |
| --- | --- |
| `drive-state.json` | the drive's state: every original, repair, probe, materialization, boundary case, retry, run and check |
| `extracts/broker-audit.json` | Broker's `security_audit` entries on the canary connection in the drive's window, the production canary's removed |
| `extracts/broker-audit-production-canary.json` | the production canary's entries in that window |
| `extracts/api-call-lines.json` | the api's and api-drive's lines for every drive command |
| `extracts/l0185r-interpret-requests.json` | l0185r's `/interpret` requests in the window |
| `extracts/proxy-source-fetches.json` | the proxy's requests for the source object |
| `extracts/partly-artifact-references.json` | the read-back of originals 15 and 16's artifacts, each saved reference attributed to its operation (read 2026-11-15T01:49Z, after the drive; Broker logged no entry for it) |
| `extracts/manual-*` | the hand reads above |
