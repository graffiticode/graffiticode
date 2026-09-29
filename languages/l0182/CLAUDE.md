# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## What this is

L0182 is a Graffiticode dialect for **taking surveys**. A program names the survey being taken
and — once something has answered — carries the response to it. A survey has one of two
**styles**, declared by its data:

- **ranked-choice** — a set of options; the response is `choices` in priority order plus at most
  one `write-in` that was not in the set.
- **rating** — a list of items, each on a scale (Likert agreement/frequency/importance/
  satisfaction/likelihood presets, NPS, stars, labelled or numeric custom scales, semantic
  differentials, opt-outs); the response is `ratings [[item … rating …] …]` plus an optional
  `comment` where the survey asks for one.

Three commitments the rest of the design follows from:

- **The flow is not in the language.** L0182 describes no screens, steps, ordering, navigation
  or submission, and there is no player anywhere in this repo. Anything that would reintroduce
  a survey-taking flow here is the wrong direction; that belongs to a different language or a
  different client reading this record.
- **The survey is not in the language either.** A program says `id "civic-priorities"` and nothing
  else about it: the options or items, the scales, the title, the instructions and the bounds are
  read from the back end by the compiler (`src/source.ts`). There is no word for any of them, and
  adding one would hand the survey to whoever takes it. The client does not see the survey until the first turn
  instantiates it.
- **The code is the interface.** A person writes the response in the console's editor; an agent
  writes it through `update_item`. They are the same client, so both produce the identical
  record and there is nothing to keep in parity. The view only renders it.

This repo previously held a survey proxy, an in-memory mock backend, an adaptive sampler and a
five-screen React player. All of it is gone — see "What was deleted, and why it is not coming
back" before proposing anything that resembles it.

## Commands

```bash
npm run build      # core → build-static → api → view → view:embed → assemble
npm run dev        # API on :50182 (expects Firestore emulator :8080, local auth :4100)
npm run start      # the built API server
npm test           # core + api + view suites
npm run lint       # ESLint over the monorepo (npm run lint:fix to write)
npm run format     # Prettier over the monorepo (printWidth 100, double quotes)
npm run publish    # core AND view to npm — both are published packages
npm run gcp:build  # submits cloudbuild.yaml, the path that carries the deploy rules
npm run gcp:deploy # Cloud Run as l0182, us-central1 — but read "Deploying" first
npm run gcp:logs   # Cloud Run logs for l0182

npm run -w packages/view dev   # the renderer on Vite alone; /dev.html is the fixture page
```

Node 22 (`.nvmrc`, and `engines` refuses lower), npm workspaces.

`packages/core/data/` holds the surveys themselves, beside `spec/` rather than inside it so that
nothing serving `spec/` can serve a survey by accident.

`npm run assemble` wipes and repopulates `packages/api/static/` from `core/dist/static` and
`view/dist-embed`. It is not incremental — a stale file cannot survive it, which is the point.

Tests are Vitest, colocated as `*.test.ts`, and there is no root config — each workspace runs
its own. **The core suite must run with `packages/core` as the cwd**, which the workspace script
does: `docs.test.ts` reads `spec/*` by relative path.

Run one file, or one case, through that same workspace script for the same reason — `npx vitest`
from the root has the wrong cwd:

```bash
npm run -w packages/core test -- src/survey.test.ts
npm run -w packages/core test -- src/survey.test.ts -t "choices"
```

Core tests compile through `src/harness.ts` — `compile(src, values)` and `errorOf(src, values)`,
which run the real parser against the real lexicon, append the `..` terminator if it is missing,
and fold `values` in as public values so `get-val-public "itemId"` resolves the way the console
resolves it. A new test that wires the parser itself is doing by hand what every other test gets
from there.

`survey.test.ts` serves the survey from a `setSource` fixture; `source.test.ts` is the one suite
that reads the real `data/` directory, because a stub there would test the stub.

**`packages/api`'s suite reads the assembled `static/` directory**, so `npm run build` has to
have run at least once or `app.test.ts` fails on a missing asset rather than on anything real.

### Environment

| Variable   | Default                         | Purpose                    |
| ---------- | ------------------------------- | -------------------------- |
| `PORT`     | `50182`                         | The language server's port |
| `AUTH_URL` | `https://auth.graffiticode.org` | Token verification         |

That is the whole environment. There is no service URL and no credential: everything a program
needs is in the program.

### Deploying

Two rules hold the deployed service together, and all three Cloud Build configs carry both —
`cloudbuild.yaml` (what `npm run gcp:build` submits), plus `cloudbuild.production.yaml` and
`cloudbuild.staging.yaml` (the GitHub triggers described in `GITHUB_DEPLOYMENT.md`). **A new
deploy path has to carry them too:**

- **`--update-env-vars`, never `--set-env-vars`.** `set` replaces the whole environment, so any
  variable added out of band is silently deleted by the next deploy.
- **`--max-instances=$_MAX_INSTANCES`, set explicitly and never merely omitted.** Cloud Run
  carries the service's current scaling forward when the flag is absent, and this service was
  pinned to `--max-instances=1` for as long as it ran the in-memory mock backend. Nothing holds
  state between requests now, but _dropping_ the flag would leave that pin of 1 in place
  indefinitely — which is why the substitution was restored rather than the flag deleted.
  Default 20, matching the sibling languages.

`npm run gcp:deploy` builds from source and passes neither flag. On an existing service Cloud
Run carries the current scaling and environment forward, so it is safe for a code-only push and
cannot be used to change either.

The hand-written `gcloud run deploy` commands in `DEPLOYMENT.md` and
`scripts/setup-gcp-deployment.sh` are deploy paths too, and carry both rules with a literal 20.

## Architecture

Three workspaces on the published `@graffiticode/l0000` and `@graffiticode/l0000-view`.

- **`packages/core`** (`@graffiticode/l0182`) — the language. `attributes.ts` is the vocabulary
  as data; `lexicon.ts` and `compiler.ts` both generate from it; `source.ts` finds the survey;
  `survey.ts` reads the program, builds the response and dispatches on the data's `style` to
  `ranked.ts` or `rating.ts`, which hold each style's assembly and every rule; `scales.ts` holds
  the scale presets and normalises every scale form to one list of points; `resolve.ts` is the
  text/id/position lookup both styles share. `spec/` is what agents read and `data/` is what the
  compiler reads.
- **`packages/api`** (`@graffiticode/api-l0182`, private) — Express: `POST /compile`, `GET /form`,
  a health check at `/`, and the assembled static assets. Its middleware order and cache headers
  are load-bearing — see "What `app.ts` serves".
- **`packages/view`** (`@graffiticode/l0182-view`) — the renderer. It does **not** depend on
  `@graffiticode/l0182`: that dependency was dropped so the published view installs from npm on
  its own, which is why the view keeps its own model types in `lib/survey.ts` rather than
  importing them from core.

### One attribute table, and no arity-2 words at all

`attributes.ts` holds one row per word, and the lexicon entry, the Checker method and the
Transformer method are all generated from it — arity included, so a word can never be declared
with one arity and handled with another. **Never hand-write an attribute handler.**

Every word is arity 1. Only the two containers (`survey`, `response`) and `PROG` are written out.
`ratings` is a generated row (`expects: "records"`) whose value is a **member list** — one
attribute list per answer, the style guide's array-of-objects form. It appears in
`validAttributes` so its words (`item`, `rating`) get the "belongs inside" hint, but it is not an
item type: `itemTypes` is the list `language-info.json` must match. `readRatings` in `rating.ts`
merges and checks each entry.

The language used to carry a second table of arity-2 chaining words that configured an activity
from outside its brackets, and that shape had a trap the compiler could never see: a config word
written as the last word inside an item satisfied its own arity by swallowing the closing
bracket, so the program died in the parser with "Too few arguments" rather than with anything a
generator could act on. **Do not reintroduce chaining.** If a word ever needs to sit outside the
brackets again, reconsider the shape first.

The style is attribute lists, per `console/docs/language-authoring-style.md` — the canonical
spec for authoring a Graffiticode dialect. Read it before adding vocabulary.

### `response` nests in the source and is lifted in the output

`PROG` takes the program's **last** expression (`compiler.ts`), so a program written as two
top-level expressions would silently discard the first. That is why `response [...]` is written
inside `survey`'s attribute list — it evaluates to a single-key record like any attribute, and
the list merges it — and why `buildSurvey` then lifts it back out to the top level. It is not
part of the survey; it is an answer to one, and anything reading the output must be able to tell
them apart.

### Value validation goes in the Transformer, never the Checker

`Checker.LIST` (inherited from L0000) visits only `elts[0]`. A rule written as a Checker method
therefore fires on the first element of a list and nowhere else — in a style built on lists,
almost nowhere. L0166 shipped a Checker rule rejecting negative points that silently did nothing
for exactly this reason. The generated Checker methods here walk the tree and do not judge.

### The compiler is the only enforcement there is

This is the load-bearing consequence of deleting the player. Nothing at delivery time can hold a
response inside the survey's rules, so the compiler checks more than a form-backed language
would need to. Ranked choice (`ranked.ts`): every `choices` entry names an option in the set, none
repeats, the count is within `minChoices`/`maxChoices`, and `write-in` does not repeat an option.
Rating (`rating.ts`): every `item` names an item, none is rated twice, every answer is on its
item's scale, every required item is answered, and `comment` only where the survey asks for one.
Both: a response in the other style's words is refused by name. Removing any of those does not
degrade a warning — it makes a meaningless record compile.

### Error messages are a product surface

The generator is an LLM that reads a compile error and tries again, so the wording is not a
diagnostic. Every message names the fix:

> response: `choices` has 4 options, but this survey's `maxChoices` is 3. Choose fewer options —
> keep the most important ones.

A message may only name a fix the reader can make. `min-choices`/`max-choices` stopped being words
when the survey left the language, and the messages that still told a program to "lower
`min-choices`" were pointing at a fix that did not exist.

The tests assert on that text, not merely that compilation failed. A message that stops naming
the fix is a regression even when the program still errors.

### `choices` and `item` name an entry by text, by id, or by position

Both take any of the three, and `resolveRef` in `resolve.ts` normalises all of them to ids before
they reach the output — so the compiled record is identical whichever was written and the input
form costs nothing downstream.

**Text is not a convenience. It is the only notation whoever answers can actually use**, and
leaving it out was a real bug rather than a missing nicety. The options live in the survey, so they
do not exist until the program compiles — which means whoever writes the response, a person or
the code generator, has never seen an id or a position. A guessed position that lands in range
compiles cleanly and records the wrong options, silently. That shipped: an `update_item` asking for
three ideas by name produced `selection [2 3 5]` (the word before `choices`) and recorded three different ones.

Three smaller rules hold it together:

- **A number is always a position, a string never is**, so those cannot collide even for a set
  whose ids look like numbers: `choices [1]` is the second option, `choices ["1"]` is the option
  called `1`. Between the two string forms an id wins — it is the canonical key.
- **Text matching folds case, trims, and collapses whitespace**, because a generator reflows
  lines. Two options that normalise to the same key make that key ambiguous, and it is refused by
  name rather than resolved to the first.
- **0-based positions**, matching the ids the language derives for a set that has none — a
  position _is_ the number in the derived id (`o0…` for options, `q0…` for items). The range
  message says where counting starts, because an off-by-one records a different ranking rather
  than failing.

**A number in `rating` is the opposite: the scale's own value, never a position.** NPS `9` is 9;
`4` on a five-point agreement scale is "Agree" because its values run 1–5. On a scale the number
IS the answer, and a 0-based reading would shift every Likert answer by one without failing. A
string `rating` matches a point's label, the item's own `anchors` for its ends, the scale's
`optOut`, or a number in quotes — folded the same way as option text.

### A survey is looked up, drawn, and held by session

`src/source.ts`. A program names a survey; the compiler finds it in `packages/core/data/`, a
directory hard-coded relative to the module (`new URL("../data/", import.meta.url)`) so it
resolves identically from `dist/`, from `src/` under vitest, and inside the Docker image.

- **A survey id names a SET of files.** `civic-priorities-1.json` … `civic-priorities-12.json` are
  versions of one survey, and `id "civic-priorities"` draws one of them **without replacement**: a
  drawn version is marked taken until every version has been taken, at which point the marks
  clear and the cycle restarts. `id "civic-priorities-7"` names a version outright — no draw, no
  mark — and that is what pins an answer to the version it answers.
- **`<id>-<n>` is the whole naming rule**, so `civic` cannot match `civic-priorities-3`, and an
  id is validated against `[a-z0-9][a-z0-9-]*` **before** any disk access: nothing resembling a
  path reaches `readFileSync`.
- **`session-id` is what survives the answering turn.** Adding a response rewrites the program,
  so it compiles again, and a second draw would check the answer against options its taker never
  saw. The word is written `session-id get-val-public "itemId"`, which the console resolves at
  PARSE time (`console/src/lib/code-generation/generate-for-request.ts:516`) — so from turn two
  the program carries the literal id and `drawn: Map<session, instance>` hands back the same
  version. L0158 uses the same mechanism.
- **An unknown session DRAWS rather than refusing.** Refusing was considered and is wrong: a
  first turn may legitimately arrive with its answer already in it ("answer the civic-priorities
  survey with …" reaches the compiler as one program), and from inside the source a brand-new
  session and a forgotten one are indistinguishable.
- **An empty `session-id` is no session.** That is what an unresolved `get-val-public` folds to,
  and honouring it would hand every such compile one shared version.

Two limits, both inherited from how the platform runs compiles rather than from this file. Both
are documented in `spec/` rather than fixed, and fixing either needs a store this language server
does not have:

- **The memory is process-local.** Cloud Run runs up to 20 instances and scales to zero when
  idle, so a session that answers some minutes later may land on a server that never drew for it
  and be given another version. Nothing depends on `--max-instances=1`, and it must not.
- **Identical programs share one compile.** A task id is content-addressed over the program
  (`graffiticode/packages/api/src/storage/tasks.js:6-9`, `data.js:8-11`), with no TTL, so two
  takers whose programs are textually identical get one stored compile and one version between
  them. `session-id` is what makes each item's program distinct, which is the other half of why
  it is written in every program.

**`setSource` is the test seam**, mirroring `setSchemaFetcher` in the base language, and it is
also the shape any other back end plugs into: a survey does not have to come from a file, and
nothing in the language changes if it stops doing so.

### Options and items keep the service's ids when they have them

A survey's data holds a bare string or a `{id, text}` record per option or item. An entry that
names its own id keeps it; one that does not is numbered positionally, `o0`/`q0` upward. Both forms exist for
one reason: a survey comes from somewhere, and when that somewhere carried ids they have to
survive into `choices`, because a selection of positional ids means nothing back at the service
the set came from.

### `PROG` ignores `options.data`, deliberately

It used to spread it, because the React player wrote the participant's answer back through it on
every recompile. That forced the compiler to unwrap the `{data, errors}` envelope storage wraps
a stored model in — **in a loop**, because a second layer was observed appearing after the first
round trip. That envelope drew blood three times across this codebase: it buried the response
one level below where the Form read it (a survey that silently would not resume), `l0000-view`
normalises it in `ne()`, and `graffiticode-mcp-server` rejected every survey as "not a survey"
for reading `.activity` off it.

Nothing writes back now, so the compiled value is the whole model and the envelope cannot reach
it. `prog.test.ts` pins that: an envelope in `data`, singly and doubly wrapped, must not appear
in the output. If a data-side response is ever wanted again, it comes back as **one key where
data wins over the compiled value** — not as a blanket spread, which is what let a stale compile
shadow a fresh one.

### What `app.ts` serves, and why the order and the headers are load-bearing

Four rules, three of which are shipped bug fixes, and all four now pinned by `app.test.ts`.
Changing any of them looks harmless locally, where there is no CDN and no cross-origin host.

- **Public static is mounted BEFORE auth.** `lexicon.json`, `schema.json`, `spec.html`,
  `instructions.md`, `language-info.json`, `usage-guide.md`, `scope.json` and `template.gc` must
  be fetchable with no token — an agent reads them before it has one. `index: false` keeps
  `GET /` a health check rather than the embed's `index.html`. Note that `routes.auth` is not a
  gate: it attaches `req.auth` and **does not reject an anonymous request**, so mounting after
  it protects nothing by itself.
- **`/assets/*` is immutable, `/form` must never be held.** The bundle's filenames carry a
  content hash, so a new build is a new name and those may be cached forever. The embed HTML
  _names_ that bundle, so caching it caches the whole deploy: new assets sit there unreferenced
  while every visitor keeps running the previous build — a failure that looks exactly like a
  successful deploy. `no-cache` alone was not enough behind Cloudflare, which served a HIT with
  `age: 1191` and rewrote the header, so `/form` goes out with `Cache-Control`,
  `CDN-Cache-Control` **and** `Cloudflare-CDN-Cache-Control` all `no-store`. **Those three
  headers are necessary and NOT sufficient** — see below.
- **`Cross-Origin-Resource-Policy: cross-origin` on every response.** Without it a COEP-isolated
  host — the claude.ai and chatgpt.com widget iframes — blocks the `/form` frame outright.
- **`GET /lexicon.js` is aliased to `lexicon.json`** for the still-deployed console, which
  slices from the first `{` and parses. No `lexicon.js` is emitted; drop the alias once the
  console migrates (Stage 3).

### The `/form` headers cannot win on their own — the zone overrides them

The three `no-store` headers above are what the origin can do, and the origin does it correctly.
The Cloudflare zone in front of it ignores them. Verified 2026-09-08, after a deploy that
shipped a CSS change: `https://l0182.graffiticode.org/form` answered `cf-cache-status: HIT` with
`age: 2009`, naming the **previous** bundle, and its `cache-control` came back rewritten to
`max-age=3600, must-revalidate` — while `cdn-cache-control: no-store` passed through untouched,
which is the tell that the rewrite is the zone's and not ours.

That does damage twice, and the second one is the one that surprises:

- The edge serves a stale HTML shell naming the previous bundle. Both bundles are present, so
  nothing 404s and nothing looks broken — the old build simply keeps running.
- The rewritten `max-age=3600` then instructs **every visitor's browser** to hold that shell for
  an hour. A purge clears Cloudflare's copy and **cannot reach that one**. This is not
  theoretical: after a purge the page still rendered the old build until a hard reload.

So a deploy that changes anything in the view is not visible until the zone is fixed, and
**the fix is zone configuration, not code** — there is nothing left to change in `app.ts`:

- A Cache Rule with action **Bypass cache**, matching:

  ```
  (ends_with(http.host, ".graffiticode.org") and starts_with(http.request.uri.path, "/form"))
  ```

  Scoped to every language host on purpose: the shell-naming-hashed-assets shape is shared, so
  this is every language server's bug, not L0182's. Bypassing costs nothing — `/form` is a small
  shell the origin already marks `no-store`, and `/assets/*` stays immutable, which is where the
  bytes are.

- **Browser Cache TTL → Respect Existing Headers** (Caching → Configuration). This is the half
  that a purge cannot substitute for. Without it the rule above fixes only the edge.

Verify with `curl -sI https://l0182.graffiticode.org/form`: it must say `cf-cache-status: BYPASS`
(or `DYNAMIC`) **and** carry the origin's own `cache-control: no-store, no-cache,
must-revalidate`. A `max-age=3600` there means the Browser Cache TTL half is still missing.

Two things that cost time when diagnosing this, both worth knowing before you start:

- **The console's iframe loads `l0182.graffiticode.org/form`, not `api.graffiticode.org`.**
  `FormIFrame.tsx` builds an `api.graffiticode.org/form?…` URL that redirects to the language
  host, and the two hostnames are separate cache entries — the api one can be fresh while the
  one actually rendering is stale, which makes a spot-check on the wrong host look clean.
- **The cache key ignores the query string**, so `?cb=1` is not a cache-buster; every iframe URL
  shares one entry despite carrying a distinct `access_token` and `id`. A trailing slash
  (`/form/`) _is_ a distinct key, which is useful for confirming what the origin would serve —
  and useless as a fix, since the next deploy just makes that path stale too.

The fastest discriminator is which asset filename the HTML names: compare the Cloud Run origin
URL (`gcloud run services describe l0182 --format='value(status.url)'`) against the public
hostname. Same name, the deploy is at fault; different names, it is the CDN.

## The view is a renderer, not a player

`components/survey/Survey.tsx` is the frame and the ranked-choice body; `Rating.tsx` is the
rating body. It is **read-only by design rather than by stage**. Adding a control would create a third way to answer that neither of the two real
clients — the console editor and `update_item` — shares.

A ranked-choice survey shows the initial state and the current one **side by side**: left is the
set as code generation inlined it, right is what came back. Options carried into `choices` are dimmed on the
left rather than removed, so the column keeps its shape and what was passed over stays visible.
The columns stack on a narrow viewport, because this is published as an embed and renders inside
other people's pages. A survey with no `response` shows the right column explicitly empty and
captioned — that is the state code generation leaves an item in, and it must read as awaiting a
response rather than as broken. A rating survey is one row per item instead: a scale already
shows before and after at once, every point it offers with the answer filled in. Points are
`<span>`s wrapped with `flex-wrap`, not a table, so a seven-label agreement scale still fits a
phone-width embed.

`Survey` is exported as `Form` too, because that is the prop name the shared View takes. **No
`reduce` is passed** — L0182 has no actions of its own, so the `LanguageReducer` hook is unused
here and L0179 is again its only user.

**There is no DOM in the view suite, deliberately.** `vitest.config.ts` pulls in no jsdom, which
is what keeps a published component's dev tree free of a rendering library. So the logic that
can be wrong without looking wrong lives in `lib/survey.ts` as pure functions —
`resolveChoices`, `boundsLabel`, `resolveRatings`, `scaleEnds`, `answerText` — and
`lib/survey.test.ts` is what tests it. Do not reach
for a render test; put the logic in `lib/` and keep the component a projection of it.
`embed/dev.html` is the way to _look_ at it: it renders every state against fixed models with no
API behind them, and Vite builds only `index.html`, so it never reaches the embed bundle.

**`resolveChoices` and `resolveRatings` name what they cannot place rather than dropping it.** The compiler refuses
those, so they only arrive on a record assembled outside it — but silently dropping one would
render a shorter ranking than the one actually recorded, which is the kind of wrong that looks
right.

### Preflight is off, and four rules have to come back

`tailwind.config.js` disables preflight so this published component never injects a global reset
into a consumer app or the page hosting the `/form` iframe. But preflight is also what sets
`border-style: solid; border-width: 0` — without it every `border-*` utility renders no border
at all — plus `box-sizing`, the list reset and the `button` reset. `src/index.css` restores them,
scoped to `.l0182-survey`, **every selector wrapped in `:where()`**: that contributes zero
specificity, so the reset sits under the utilities it is resetting for. Written without it,
`.l0182-survey button` scores (0,1,1) and beats `.bg-green-700` — which shipped once, rendering
every filled control as plain text. The component's root carries that class; a new tree that
wants borders must sit inside it.

## Spec is tested, not decorative

`docs.test.ts` is the gate on `spec/`. A wrong example is not a documentation nit — the
generator writes from `instructions.md` and retrieves from `examples.md`, so it is reproduced
verbatim into generated programs.

- Every fenced program in `spec.md`, `instructions.md` and `usage-guide.md`, plus `template.gc`,
  **compiles** —
  not merely parses. Programs are recognized by the `..` terminator rather than a list of
  opening words, because a list goes stale the moment the vocabulary changes.
- Every documented word exists in the lexicon with the signature claimed, and every L0182 word
  (derived as `lexicon` minus L0000's) is documented. The Functions table is **generated** from
  the lexicon — regenerate it rather than hand-editing. There is no script for it: print one
  `| \`word\` | \`type\` | arity | description |`row per L0182 entry of`src/lexicon.ts`, then run
  Prettier over the file.
- `schema.json` is validated against **real compiled output**, including a case asserting that
  `additionalProperties: false` actually bites. Draft 2020-12, so the test imports
  `ajv/dist/2020.js`; the hoisted ajv 6 cannot read it.
- The `## Which words each container takes` table must equal `validAttributes` exactly.
- `examples.md` numbering is coherent: prompts run `1..N`, category ranges tile the list, and
  the stated count is the count present.
- **`scope.json` carries the keywords the MCP router extracts.** `limitSentences()` in
  `graffiticode-mcp-server` inlines only sentences matching
  `/\b(ONLY when|do NOT|does NOT|are not built|not built yet|EARLY|never)\b/i` into the server
  instructions. A negative clause without one of those words never reaches the router — and
  L0180 absorbs survey requests, exactly as it over-captured cloze requests 3/3 before this was
  tuned. The test asserts several `out_of_scope` sentences carry one, and that L0180 is named.

Prose is still prose. Nothing can check that an `in_scope` line describes a capability
accurately, so re-read `scope.json` whenever the language changes.

`spec/usage-guide.md`'s `## Overview` is extracted into `dist/static/language-info.json` as
`authoring_guide`, and the build **fails** if it is missing or under 100 chars. Edit the
Overview, not the JSON.

**`packages/core/data/` holds the surveys**, a peer of `spec/` rather than inside it, and they
are NOT served by this language server — `build-static.js` never reads `data/`, and `app.test.ts`
asserts a 404. Serving them would let whoever takes a survey read it, or a client render it,
before taking it, which is the thing the split exists to prevent.

Every file is `<survey-id>-<n>.json` and declares its `"style"` — required, not inferred, because
a rating file that lost it would otherwise fail as a ranked-choice survey with no options, which
names the wrong fault. (A bare JSON list is the one shorthand, and means ranked-choice options.)
`docs.test.ts` compiles each file as a program and validates it against the schema, so a file
that stops being a valid survey fails the build rather than somebody's first prompt. It also
asserts every id the docs name is installed, that both styles are installed, that the ranked
surveys meaning to bound a response carry `minChoices`/`maxChoices` themselves, and that the
rating corpus covers every scale form — a preset, NPS, stars, a numeric range, hand-labelled
points, an opt-out, anchors, bare-string items, an optional item and a comment. The shapes differ
on purpose: a corpus of one shape teaches the generator one shape. The documented ANSWER
examples all name a single-version survey — one with several draws a version at
random, so a documented selection would match only sometimes.

**Two of the served assets are not the file you edited.** `build-static.js` concatenates
L0000's `instructions.md` with L0182's, and `lexicon.json` is the merged base + L0182 lexicon,
so `static/instructions.md` legitimately holds prose that appears in no file in this repo —
editing `spec/instructions.md` changes only the tail. Diff `spec/` against `static/` with that
in mind.

## Adding a word

1. Add its row to `attributeFields`. Arity 1; there is no other option. Every L0182 word is a row
   there now — only the two containers are hand-written.
2. Add it to the container's list in `validAttributes`.
3. Handle it in `buildResponse` in `survey.ts` and in the style it belongs to (`ranked.ts` or
   `rating.ts`), with its default and its error messages — each naming the fix. A word only one
   style takes must also be refused on the other by `assertStyleWords`.
4. If the renderer needs it, add it to the model types in `packages/view/src/lib/survey.ts` and
   project it there, not in the component.
5. Extend `spec/schema.json`.
6. Document it in `spec/instructions.md` (the container table **and** the generated Functions
   table) and in `spec/spec.md`, each with a compiling example.
7. Add prompts to `examples.md`, updating the category range and the stated count.
8. Revisit `spec/language-info.json` and `spec/scope.json`.

## What was deleted, and why it is not coming back here

The repo carried all of this until the flow left the language. It is recorded because the
obvious next feature request re-proposes one of them:

- **A survey proxy** (`/survey/open|answer|results`) that the form and the MCP tools both called,
  so a participation was identical whichever client it arrived on. There is one client now — code
  — so there is nothing to converge, and `parity.test.ts` had nothing left to assert.
- **An in-memory mock backend** with a 20-idea seed pool, least-shown-first sampling over a
  rotating window, and per-actor-class tallies. It was the only reason for `--max-instances=1`.
- **An adaptive sampler**, `sample N`, and the whole "the ideas are not authored, they live in
  the pool" model. The options are a survey's own now, read from `data/` — never authored, and
  never sampled within a version.
- **A five-screen React player** (`start`/`select`/`rank`/`contribute`/`results`/`thanks`), its
  `KINDS` registry, drag-and-drop ranking, and the `navigate`/`response` action split.
- **`participants` and `audience`**, the human-vs-agent gate and the per-population ranking.
  Both clients are the same client now, so there is no population to separate.
- **`scripts/post-response.mjs`**, which posted a response as task data. Responses are code.
- **The words that authored a survey** — `ideas` (now `options`, a key in the data, never a
  word), `title`, `instructions`, `min-choices`, `max-choices`, and `name` — plus **`fetch`** (`src/fetch.ts`, its scheme and host checks and
  its timeout), CSV reading, and the whole "point the program at a dataset" model. A survey is
  one JSON file that says everything it is; CSV could carry a list and nothing else, so a survey
  stored that way had no title, no instructions and no bounds of its own.
  The survey comes from the back end; a program that could write any of this could edit the
  survey it is taking. The parse errors they now produce are the point: they are out of the
  lexicon, not merely refused by `survey`.

If a live pool, cross-participant aggregation or an interactive flow is wanted, it is a service
plus a different client — not a return of these.

## Back-port surface (for L0180)

**There isn't one any more.** `items`, `navigation`, `submission` and `activity.ts` are deleted
here. L0180 already holds its copy of them on branch `activity-level` and is unaffected; the two
languages have diverged and no longer share a shape. Sections and item banks — QTI's `selection`
and `ordering` over an authored bank — remain L0180's business, and were always the wrong
construct here.

`title` is arity 1 again, which also removes the one correction that contract carried: it could
not be back-ported at arity 2 because L0180 already had `title` at arity 1 inside `stimulus`.

## Not built yet

Aggregating across responses — a group ranking, an average rating, an NPS score, a tally, or any
live result. Authoring a survey: the options, items, scales, wording and bounds belong to `data/`
and no word writes them. Reading a survey
from anywhere but the filesystem, or authenticating to one — `setSource` is where that would go.
A durable session→version memory (see the limits above). Sampling within a survey: a version is
served whole and in order. An interactive survey-taking flow. Mixing the two styles in one survey — a file is one style.
Other questionnaire items — demographics, fixed free-text questions, branching logic. Reverse-coded
items or any scoring of a scale. Ranking or rating objects other than a line of text. Any analysis of the responses collected. Enforced one-response-per-person.

## Related repos

- `l0000` — the base language and the View harness. Both are npm dependencies, not workspaces.
- `l0158` — the dialect `session-id get-val-public "itemId"` is borrowed from; its
  `set-var "lrn-id" get-val-public "itemId"` is the same mechanism, and its instructions show how
  hard a generator has to be told to copy such a line verbatim.
- `console/docs/language-authoring-style.md` — the style spec this dialect follows.
- `console/src/lib/languages.ts` — the catalog. **L0182 must be registered here to reach any
  user.** Its `routingHint` covers both survey styles, and L0182 carries no `brands`
  entry (console `87cfc14` on `main`); keep its `do NOT` and `never` clauses when editing, or L0180
  starts absorbing survey requests. `scripts/eval-scope-gate.ts --only survey` there is the
  routing check for rating requests, and it reads the DEPLOYED `scope.json`. L0182 declares no
  `composesWith` and should not: the compiler reads the survey itself rather than binding an
  upstream.
- `graffiticode-mcp-server` — its `open_survey` / `answer_survey` tools target the deleted proxy.
  The agent path is now plain `create_item` / `update_item`, which is exactly the path a person
  uses.
- `l0180` — the assessment dialect this was originally copied from.
