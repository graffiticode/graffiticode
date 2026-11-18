# C5a edge-cache check — procedure, revision 3 (P1, E1, E2 executed 2026-11-18; E3+ held)

**Revision 2** takes the owner's two corrections:
- A2 is now the View's own data URL, with its generation parameters.
- P1's 302 is recorded before any redirect is followed, and every private probe
  must answer `Cache-Control: no-store`.

## Why
- **Where the camera goes:** l0013r's camera renders the private item through
  Cloudflare-proxied production origins.
- **Where the grant travels:** in the `Graffiticode-Render-Grant` header, never in the
  URL. So a granted request and an anonymous one share a URL.
- **How the edge keys:** Cloudflare's cache rule on api `/task` and `/data` keys on
  URL and ignores credentials (`packages/api/src/routes/utils.js`).
- **What could go wrong:** a granted answer stored at the edge reaches anonymous
  callers; or an anonymous 404 stored earlier is served to the camera.

## Fixtures (created 2026-11-18, run `r381d64`)

| | Item | Owner | Public | Sheet task (`T`, `Tp`) |
|---|---|---|---|---|
| Private | `7vwaCAIyMNCJEzgIfyYY` | canary | no | `T = eyJ0YXNrSWRzIjpbIndGbW1LekNOYnNFcG1XdUJ2YU95Il19` |
| Public | `wbyfys3akpc4yEGFrnuu` | canary | yes | `Tp = eyJ0YXNrSWRzIjpbInZRQ0NtYjlMR01KalBJVTlXQjA4Il19` |

The production api serves L0179 under `COMPILE_GENERATION_L0179=interp-4`, read from
`api-rmwkxlbvy-b5fa92`. It is read again from the serving revision just before
execution.

## URLs

The camera requests `/form` with no `access_token`. The api answers it with a 302
(`no-store`) to `PUBLIC_URL_L0179/form?...&url=<data URL>`. The View then fetches
`<data URL>`, which carries the generation parameters (`routes/form.js`).

- **`A1 = https://api.graffiticode.org/form?id=<T>&lang=0179`:** the camera's first
  request.
- **`A2 = https://api.graffiticode.org/data?id=<T>&generations=%40L0179%3Dinterp-4`:**
  the View's data URL, encoded exactly as `URLSearchParams` writes it. An anonymous
  A1 for a private task can't redirect, so A2 isn't read from A1's answer.
  - It is checked against P1's `Location` (step 1): the same shape with `Tp`.
  - It is confirmed afterwards against the URL the camera actually requested (step 4).
- **`P1 = https://api.graffiticode.org/form?id=<Tp>&lang=0179`:** the public control.
  - `P1-loc` is P1's `Location`, the `l0179.graffiticode.org` View shell.
  - `P1-data` is the `url` parameter inside `P1-loc`.
- The resolver, `POST https://app.graffiticode.org/api/form/resolve`, is a POST that
  the edge doesn't cache. It isn't probed.

## Credentials
- **Every probe:** none. No `Authorization`, no cookie, no `access_token`, no grant
  header, and redirects off (`redirect: "manual"`).
- **Grant-bearing requests:** only the camera's, inside l0013r during the owner's
  capture, under the grant Policy issues. The operator never sees, mints or replays one.
- **The operator's own credentials** are used only to read the api's request logs in
  step 4.

## Recorded for every response, each kept separately
- the status and `Location`;
- the headers `cache-control`, `cf-cache-status`, `age`, `vary`, `expires`, `cf-ray`
  and `date`;
- the sha256 of the body, never the body itself.

## Order
1. **P1, before anything private.**
   - **`GET P1`, redirects off.** Expected: `302`, `Cache-Control: no-store`, and
     `cf-cache-status` not `HIT`. Record `Location`.
     - **Check:** its `url` is `https://api.graffiticode.org/data?id=<Tp>&generations=%40L0179%3Dinterp-4`.
     - **Stop if it differs:** A2 is then re-derived from that shape before going on.
   - **`GET P1-loc`, separately, twice.** Expected: 200. Edge caching is allowed here:
     it's a public View shell with no item data. Record it for the report only.
   - **`GET P1-data`, separately, twice.** Expected: 200 with
     `Cache-Control: public, max-age=31536000, immutable`, and `MISS` then `HIT`
     allowed. This is the control: it shows the rule does store a public `/data`.
2. **E1, priming, after the gate's baseline phase and before its captures phase.**
   - **`GET A1`, redirects off.** Expected: a refusal (4xx, no `Location`) with
     `Cache-Control: no-store`, and `cf-cache-status` `BYPASS` or `DYNAMIC` (or absent),
     with no `age`.
   - **`GET A2`.** Expected: `404` with `Cache-Control: no-store`, and `cf-cache-status`
     `BYPASS` or `DYNAMIC` (or absent), with no `age`.
   - **Stop if** either probe lacks `no-store`, or answers `HIT`, `MISS`, `EXPIRED`,
     `UPDATING` or `REVALIDATED`. The gate stays held, and the cause is reported.
3. **E2, repeat E1 at once.** Expected: the same status and body digest, `no-store`, and
   still not `HIT`.
4. **E3, the owner's private capture** (the gate's first command of the captures phase).
   - **Expected:** the command completes.
   - **Expected:** the gate bucket's object is the sheet's render ("C5a gate fixture:
     private (r381d64)"), not an error page. It is viewed and its sha256 recorded.
   - **Expected:** l0013r's logs for the command show no resolve error and no 4xx.
   - **Then, from the api's Cloud Run request logs for that window:** the `/form` and
     `/data` URLs requested for `id=<T>`.
     - The logged `/data` URL must equal A2 byte for byte.
     - **If it differs (rev 3):** this capture proves nothing about a cached anonymous
       404, since its actual URL was never primed. The difference is reported, and
       then:
       1. The corrected URL is primed (E1 and E2 against it).
       2. A fresh owner capture runs, with a new key.
       3. E4 runs against the corrected URL.
5. **E4, immediately after the first private publish (rev 3)**, not after the captures
   phase ends.
   - **How:** `edge-probe.mjs e4-watch` is started just before `--phase captures`. It
     polls `gs://graffiticode-c5a-gate/<private item>.png` every 2 s, read-only with the
     operator's credentials, and runs E4 the moment the object appears.
   - **Recorded:** the object's generation and creation time beside E4's times, to
     show E4 ran within 60 s.
   - **The probes:** `GET A1` (redirects off), then `GET A2`, twice each.
   - **Expected:** the same status and body digest as E1, `Cache-Control: no-store`, and
     `cf-cache-status` not `HIT`.
   - **A 200, or any body other than E1's,** is a leak or a stored granted answer: stop,
     purge A1 and A2, and report.

## Not observable from outside
The camera's granted A2 answer carries `Cache-Control: no-store`
(`packages/api/src/render-grant.js`), but it can't be probed without a grant. Its
evidence is the api spec at the deployed api commit, `3b6b4a50`, together with E4.
