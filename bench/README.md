# bench — agy vs gemini vs codex review benchmark

A reproducible harness that pits **AGY**, **Gemini** and **Codex** against each other
on code review, scored automatically against planted ground truth. It operationalizes
the manual comparison in [`docs/MODEL_COMPARISON.md`](../docs/MODEL_COMPARISON.md):
the interesting question is **model vs harness**, so the benchmark measures both.

## Three axes, nine cells

All three tools emit the **same** structured review JSON (see
[`review-output.schema.json`](review-output.schema.json), identical to the gemini
`prompts/review.md` contract and the codex `schemas/review-output.schema.json`), so
one scorer grades all of them.

| Cell | What it is | Isolates |
|---|---|---|
| `gemini.model` | `gemini -p` on a neutral prompt + embedded diff, tools forbidden | model (single-shot) |
| `codex.model` | `codex exec --output-schema …` on the same neutral prompt + diff | model (single-shot) |
| `gemini.deep` | `gemini-companion review --deep` (agentic repo exploration) | harness |
| `codex.native` | codex's native agentic reviewer via its companion | harness |
| `agy.model` | `agy` on the same neutral prompt + diff, unoriented, tools forbidden | model (single-shot) |
| `agy.deep` | `gemini-companion review --deep --engine agy` (agentic repo exploration) | harness |
| `gemini.adversarial` | `gemini-companion adversarial-review --deep --engine gemini` | adversarial |
| `codex.adversarial` | `codex-companion adversarial-review` | adversarial |
| `agy.adversarial` | `gemini-companion adversarial-review --deep --engine agy` | adversarial |

- **Model axis** = every `*.model` cell (same prompt, no tools).
- **Harness axis** = each tool's default repo-exploring reviewer.
- **Adversarial axis** = each tool's adversarial reviewer.
- **Harness lift** = within a tool, `model → agentic` composite delta.

> **The lift is not a measurement of the harness alone.** `model → agentic` changes
> three things at once, and the number attributes all of it to exploration:
>
> 1. **the prompt** — model cells get `neutral-review-prompt.md` (33 lines: review
>    only the diff, prefer one strong finding, no false positives); agentic cells get
>    the plugin's `prompts/review.md` (84 lines, a category list and a finding bar),
>    plus the `DEEP REVIEW MODE` block the companion appends, which names the things
>    to go and look at (dependency manifests, callers, untracked files);
> 2. **the tools** — forbidden, versus allowed;
> 3. **the workspace** — no orientation, versus `--add-dir` pointing at the repository.
>
> The diff is *not* one of the differences: `collectReviewContext` embeds it in
> `REVIEW_INPUT` for both, so a `--deep` run starts from the same text and may then go
> further. Isolating that "may then go further" needs a cell running the plugin's
> review prompt with the diff embedded and no tools — which is exactly the plugin's own
> non-deep review. See the `*.shallow` cells.
>
> Two further limits on reading any lift here. Its sign is set by corpus composition:
> the per-case deltas on the current five cases run from −20 to +17 for both engines,
> so the mean says as much about which cases exist as about the harness. And exactly
> one case — `repo-context` — plants defects that are repository-scoped rather than
> file-scoped (`file: "*"` in its `ground-truth.json`), which means the capability the
> harness axis exists to measure is exercised by a single case. Adding cases of that
> kind is what would make the axis a measurement; adding repeats is not — see finding
> 4 below on why the spread statistic cannot shrink.

The adversarial cells are a third axis rather than more entries on the harness one,
because the two prompts are not interchangeable: `prompts/review.md` asks for a
pragmatic review, `prompts/adversarial-review.md` asks the model to break confidence
in the change. Ranking one against the other would be a column stating what
it is supposed to hold rather than what it holds.

The prediction behind that separation was wrong, and the measurement is worth keeping
next to it. Composite is `recall*70 + precision*20 + severityExact*10`, so the guess
was that the adversarial prompt would buy recall at the cost of false positives.
Measured on agy 1.1.19 across five cases x3, `agy.deep` -> `agy.adversarial` moved
recall 0.81 -> 0.77, precision 0.91 -> 0.92 and false positives 1.67 -> 1.33: more
conservative, not more aggressive. The axis stays separate anyway — the prompts are
not interchangeable whichever way the scores happen to fall.

It is also the only axis codex can currently be measured on end-to-end: `codex.native`
runs codex's built-in reviewer, whose `--json` payload carries no `result`
([openai/codex-plugin-cc#679](https://github.com/openai/codex-plugin-cc/issues/679)),
while `adversarial-review` emits schema-shaped findings.

The axes are read off `lib/cells.mjs`, not off a list of tool names, so a cell added
there joins both the ranking and its own lift without touching the report.

## Running

```bash
npm run bench            # deterministic replay from cassettes — no auth, no network
npm run bench:live -- --repeats 3   # re-record (needs auth; note the `--`, npm eats bare flags)

# narrow it down
node bench/run-bench.mjs --case auth-basic --cell gemini.model
node bench/run-bench.mjs --live --repeats 3
```

The scorecard prints to stdout and is written to `bench/results/scorecard.md`
(+ `scorecard.json`). `results/` is gitignored.

### `--live` requirements

- `gemini` on PATH and authenticated for the gemini cells. On a personal account
  that means `GEMINI_API_KEY` in the environment — consumer OAuth ended 2026-06-18
  (see the root README). `gemini.deep` additionally needs
  `GEMINI_CLI_TRUST_WORKSPACE=true`, because the cases are materialized into a fresh
  temporary repository the CLI has never been told to trust; without it the cell fails
  on trust before it reaches the API.
- **Do not set `GEMINI_ENGINE`.** The runner strips it from the companion cells and
  each of them pins `--engine` explicitly, so it should no longer matter — but the
  variable is why five `gemini.deep` cassettes had to be thrown away, so it is worth
  not having.
- `codex` on PATH and authenticated for `codex.model`.
- For `codex.native`, set `BENCH_CODEX_COMPANION` to the installed codex plugin's
  `scripts/codex-companion.mjs`. If unset, that cell is **skipped** (marked in the
  scorecard), not failed.
- Model output is non-deterministic — use `--repeats N` to average; treat
  single-digit composite gaps as noise.

### Cassette provenance & live-refresh status

A cassette recorded from a real run carries `recordedAt`, the `engineVersion` it was
recorded against, every repeat in `samples`, and no `source`; a seeded one carries a
`source` field. The scorecard prints all of it per cell. Current committed state:

- **`codex.model` — live-recorded on all five cases** (codex-cli 0.149.0, three
  samples each, 2026-08-24). The three cases that were missing while the account sat
  at its usage limit were recorded once it reset, and the two older ones were
  re-recorded on the same version so the cell reads as one tool at one version.
- **`agy.model`, `agy.deep` — live-recorded on all five cases** (agy 1.1.19, three
  samples each, 2026-08-24). Both cells sat mid-refresh for part of that day: AGY
  refused four recordings with `Individual quota reached ... Resets in 94h2m50s`, and
  they were finished once the account reset. A failed live record leaves the existing
  cassette untouched, so nothing was lost while the cell was half-refreshed — and
  while it was, the scorecard said so rather than printing the newer version for
  every case.
- **`gemini.model` — all five cases on gemini 0.56.0** (three samples each,
  2026-08-24), recorded once a `GEMINI_API_KEY` was available; the stored OAuth token
  had expired on 2026-08-20.
- **`gemini.deep` — four of five cases on 0.56.0**, `vacuous-tests` still on 0.55.1.
  That case does not merely miss the 180s cap on 0.56.0, it produces nothing at 420s
  with empty stdout and empty stderr, reproduced three times, while the other four
  finish in ~35s. `gemini.deep`'s cassettes remain the only genuine gemini reading the
  harness axis has — see the AGY mix-up below.
- **`gemini.adversarial` — unrecorded.** The same hang, wider: both cases attempted
  (`async-lifecycle`, `auth-basic`) were killed at the cap with no output, while the
  identical cases complete under `review --deep` and every adversarial case completes
  under `--engine agy`. It tracks prompt weight on the gemini engine, not the case and
  not the subcommand.
- **`codex.adversarial`, `agy.adversarial` — live-recorded on all five cases**
  (codex-cli 0.149.0 and agy 1.1.19, three samples each, 2026-08-24).
- **`codex.native` — still seeded, and now for a known reason.** Pointing
  `BENCH_CODEX_COMPANION` at the installed codex plugin 1.0.6 makes the cell run: the
  companion completes, exits 0, and returns a payload carrying `review`, `target`,
  `threadId` and a prose `codex.stdout`. It carries no `result`, and that is by
  construction rather than by failure. In 1.0.6 the companion has two review paths:
  `review` maps to codex's built-in reviewer (`runAppServerReview`), whose payload is
  prose only — no `outputSchema` is passed and no `result`, `rawOutput` or
  `parseError` key exists on it — while `adversarial-review` goes through the prompt
  template with `--output-schema` and does emit `result` conforming to the plugin's
  own `schemas/review-output.schema.json` (verified here on the same repo: `result`
  present, `parseError: null`).

  The adapter scores `payload.result`, so all five cases report `skipped (companion:
  no result in payload)`. Recording this cell means either the companion emitting
  schema-shaped output on the `review` path, or this cell switching to
  `adversarial-review` — which changes what the cell measures, so it is a decision,
  not a fix. Filed upstream as
  [openai/codex-plugin-cc#679](https://github.com/openai/codex-plugin-cc/issues/679).
- **`gemini.deep` records headlessly after all.** An older note here said it could
  not — that `gemini --deep` exits non-zero with empty stdout because tool approvals
  need a TTY. Given a key and `GEMINI_CLI_TRUST_WORKSPACE`, gemini 0.55.1 recorded all
  fifteen samples without complaint. (The note predates the AGY mix-up below, and was
  written about runs that were not gemini; it happens to be true of gemini as well.)

#### `gemini.deep` was recording AGY

The cell invoked the companion with no `--engine`. The companion resolves its engine
from `GEMINI_ENGINE` when the flag is absent (`lib/engine.mjs`, `detectEngine`), and
this machine sets `GEMINI_ENGINE=agy` in `~/.claude/settings.json` for every session.
So every `gemini.deep` recording ever made here ran AGY. The cassette said gemini
0.55.1 anyway, because `engineVersionFor` derives the version from the cell's declared
tool and runs `gemini --version` — it stamps what the column header claims, never what
executed.

Measured, on 2026-08-19, at the point the contradiction surfaced: `gemini.deep` had
been recording successfully while a bare `gemini` in the same environment exited 400.

| run | engine resolved | outcome |
|---|---|---|
| companion `--deep`, no `--engine`, env as recorded | `{engine: "agy", version: "1.1.15"}` | review produced, 43 s |
| same, `GEMINI_ENGINE` removed | gemini | fails on workspace trust |
| same, `--engine gemini` and trust granted | gemini | fails talking to the Gemini API |

The third row is the control that matters: with the engine pinned to gemini and the
trust objection removed, the cell fails on credentials exactly as `gemini.model` did.
The cell never had a working gemini route to record; it had AGY.

What follows from it:

- The five `gemini.deep` cassettes were deleted and re-recorded against gemini 0.55.1
  with a key in the environment. They had been real measurements of AGY's harness, but
  nothing labelled them that way inside the file.
- **The harness axis previously compared AGY against AGY.** The old "tie, lead of 3.2"
  was two recordings of one engine, and the "harness lift — gemini" number was
  gemini's model cell measured against AGY's harness.
- "`gemini.deep` is the steadiest cell on the board" — a claim this file carried for
  weeks — was AGY, twice.
- Both companion cells now pin `--engine` on the command line, and `GEMINI_ENGINE` is
  stripped from the child environment. Two tests hold that: one on the environment, one
  reading the dispatch table for the flag.
- The re-recording was checked the other way round before being believed. Same command,
  same trust flag, key removed: exit 400, no review, 5 s. AGY had been authenticating
  without a Gemini key for months, so a run that succeeds without one is AGY whatever
  the cassette says. This one could not run without the Gemini credential, which is the
  observation the cassette's `engineVersion` field cannot make.

**The pin is no longer the only defence.** The companion's `--json` payload now carries
`engine` — the engine it *resolved*, not the one it was asked for — and each companion
cell declares what it expects. A run from the wrong engine fails the cell instead of
being recorded, and a companion too old to report the field fails it too: reading "no
answer" as "the right answer" is how the original defect survived every green run. New
cassettes carry `engineObserved`, read back from the run. Cassettes recorded before
this change do not have the field, and no number on the board depends on re-recording
them — the cells they came from are now checked.

Three tests hold it, and each was made to fail before being believed: one on a
mismatch, one on a companion that says nothing, and one on whether anything calls the
check at all. That third one exists because deleting the two lines at the call site
left the helper correct, unreachable, and the suite green — the same shape as the
defect, wearing a different hat.

#### Two failure explanations that were wrong

Both were wrong the same way: a failure was explained by reading the code instead of
the failure.

`gemini.model` was said to fail because the CLI prints `Warning: True color (24-bit)
support not detected` ahead of its JSON and the parser gives up. `extractJsonObject`
skips leading non-JSON — it finds the first `{` and brace-matches — so that story was
never consistent with the code it blamed. Captured, the failure was authentication and
then billing, in three steps: `~/.gemini/settings.json` selects
`security.auth.selectedType: "gemini-api-key"` and with no key in the environment the
CLI exits 400 with `API key not valid`; with a key it exits 429 with `Your project has
exceeded its monthly spending cap`; with the cap raised it answers a normal envelope
and records. `GEMINI_DEFAULT_AUTH_TYPE=oauth-personal` does not override the settings
file.

`codex.model` was read as a parser fault for the same reason: its adapter branch was
the one that did **not** append stderr to its failure message, so a quota wall arrived
labelled `codex: could not parse review JSON`. It carries stderr now, like the gemini
and agy branches always did.

### What five cases at three samples showed

Composite per repeat, and the widest move each cell made between repeats of the same
recording:

| cell | `auth-basic` | `repo-context` | `async-lifecycle` | `path-and-input` | `vacuous-tests` | widest |
|---|---|---|---|---|---|:-:|
| `gemini.model` | 94, 92, 79 | 45, 55, 100 | 84, 60, 81 | 69, 69, 86 | 76, 76, 65 | 55 |
| `agy.model` | 81, 94, 81 | 0, 65, 65 | 65, 67, 84 | 69, 69, 69 | 76, 76, 76 | **65** |
| `codex.model` | 96, 72, 98 | 0, 45, 0 | — | — | — | 45 |
| `gemini.deep` | 81, 94, 80 | 88, 83, 88 | 84, 80, 69 | 69, 69, 69 | 79, 38, 58 | 41 |
| `agy.deep` | 81, 77, 93 | 88, 88, 83 | 81, 62, 81 | 53, 69, 69 | 95, 71, 95 | **24** |
| ~~`gemini.deep`~~ as it was — AGY, mislabelled | 80, 81, 81 | 88, 88, 88 | 81, 69, 69 | 69, 69, 53 | 76, 53, 93 | 40 |

The last row is struck through because it is AGY under a gemini label (above). Its
cassettes are gone; the numbers are kept here because they are still a measurement — a
second, independent AGY harness run — and because they are what this section's
conclusions were read off before anyone knew whose they were.

Four readings, in the order they cost something to learn.

1. **"The agentic cells are an order of magnitude steadier" does not survive, and the
   real gemini cell is the least steady thing on the harness axis.** This section used
   to claim it on the strength of `gemini.deep` moving by 1 and by 0 — which was AGY,
   and so was the `agy.deep` row it was being praised against. Re-recorded as actual
   gemini, that cell moves by 41. Set `repo-context` aside and the ordering inverts:
   the deep cells' worst moves are 41 and 24, the model cells' 26, 24 and 19.

   One piece of the original reading does survive, and it is the piece worth keeping.
   On `repo-context` — the case that is invisible single-shot — both deep cells move
   by 5 while all three model cells move by 55, 65 and 45. A harness is steady *on the
   case built to need a harness*, because the model cells are guessing there and
   guessing has variance. That is the claim the data carries. "Agentic reviewers are
   steadier" is not.
2. **Granularity was the dominant term in the model cells' noise, as predicted, and it
   was not enough.** Two-defect `repo-context` is where every model cell posts its
   widest move (55, 65, 45); across the four- and five-defect cases the same cells move
   at most 26. One miss worth 35 composite points really was most of the old spread.
   It bought no verdict: the board's leads are 6.4 on the model axis and 3.2 on the
   harness axis, against bands of ±65 and ±40.
3. **Gemini's harness does not beat gemini's own model cell.** Harness lift — gemini is
   **-0.2** (75.4 single-shot, 75.2 agentic). It is well inside the band and so is not
   a finding that repo exploration fails to help; it is the absence of the finding that
   it helps, on this corpus, for this tool. AGY's lift is +10.2, also inside its band.
   The one lift that looks decisive, codex's +41, has a seeded end and is not a
   measurement at all.
4. **No axis is decidable — and under the present rule, no amount of extra sampling can
   make one decidable.** Spread is a *range* (`max - min` over repeats, then `max`
   over cases, `lib/report.mjs:48`), and a range only ever grows as samples are added.
   It estimates the worst repeat, not the uncertainty in the average, so "run it more"
   moves every verdict further out of reach rather than closer. Naming a lead honestly
   would need a different statistic — a standard error over repeats shrinks with the
   square root of the sample count; a range does not — and that is a change to the
   scoring rule, not to the corpus. It is deliberately not made here: an undecidable
   board that says so is worth more than a decidable one that got there by choosing a
   friendlier statistic.

A cell recorded once has no spread. It is printed as `—`, meaning *unknown*, and it
can neither win nor lose an axis — the same exclusion a seeded cell gets, for the same
reason: there is nothing to compare against.

Adding a cell means one entry in `lib/cells.mjs` and one `case` in `lib/adapters.mjs`;
everything else — which cases get materialized, which cells need a repo, the axes, the
lifts, the bands — reads the registry. It did not always: two hardcoded cell lists in
`run-bench.mjs` meant a newly added model cell ran with a null prompt, and on AGY that
surfaced 180 seconds later as an engine timeout rather than as a missing diff.

## Scoring (`lib/score.mjs`, pure & unit-tested)

Per cell, findings are matched against the case's `ground-truth.json`:

- A finding **matches** a planted defect when the file matches and a category
  keyword is present (keyword is the robust signal; an exact line overlap is the
  fallback for keyword-less defects). `file: "*"` means keyword-only (for defects
  that span files, e.g. an undeclared dependency).
- Each finding is assigned to its **single best** unmatched planted defect, so two
  line-adjacent defects are never double-counted.
- `recall` = planted found / planted total. `precision` = relevant / findings.
- **An empty review scores 0, not 20.** Precision over zero findings is undefined
  rather than perfect, and paying for it made silence the best available wrong
  answer: saying nothing scored 20 while naming one thing and being wrong scored 0.
  A scorer that rewards not looking cannot be used to argue that looking helps. The
  exception is kept: when a case plants nothing, an empty review is the correct
  answer and earns its precision. No committed sample was ever empty (28 of 28 have
  at least one finding), so this closes a hole rather than restating any result.
- A finding matching none of the planted set but listed in `allowed_extras` is a
  **bonus** (a legitimate unique catch), not a false positive. Everything else
  unmatched is a **false positive**.
- `severityExactRate` compares reported vs expected severity on found defects.
- `composite` (0–100) = `recall*70 + precision*20 + severityExact*10` — a summary,
  not a verdict. Always read the columns.

`node --test bench/run-bench.test.mjs` (also part of `npm test`) pins the scorer on
synthetic findings with known precision/recall.

## Corpus format

```
corpus/<case-id>/
  base/                 # committed baseline (optional)
  head/                 # changed working tree (the code under review)
  ground-truth.json     # planted defects + allowed_extras
  prompt.md             # optional neutral-prompt override for the model cells
```

`ground-truth.json`:

```json
{
  "planted": [
    { "id": "sqli", "category": "injection", "file": "src/auth.js",
      "line_start": 7, "line_end": 9, "severity": "critical",
      "match": { "keywords": ["sql injection", "concatenat"] } }
  ],
  "allowed_extras": [
    { "id": "jwt-expiry", "file": "src/auth.js", "match": { "keywords": ["expiresin"] } }
  ]
}
```

Cases:
- **`auth-basic`** — five in-diff defects (the `MODEL_COMPARISON.md §A` set); probes
  the **model axis** (everything is visible in the diff). Recorded on every live cell.
- **`repo-context`** — an undeclared dependency and a committed runtime-state file;
  invisible single-shot, so it probes the **harness axis** (`MODEL_COMPARISON.md §B`).
  Recorded on every live cell.
- **`async-lifecycle`** — five async and resource defects in one file: a catch that
  returns success, an unclosed handle, an uncleared interval, an unawaited promise and
  a map nothing deletes from. Model axis. Recorded on every live cell but
  `codex.model`.
- **`path-and-input`** — two loud injection paths (traversal, `execSync`) and three
  quiet ones (`parseInt` without a radix, an unbounded read, an unhandled ENOENT).
  The quiet three are the discriminating half: a reviewer that reports only the two
  criticals scores 0.4 recall. Model axis. Recorded on every live cell but
  `codex.model`.
- **`vacuous-tests`** — four green tests that constrain nothing: no assertion, an
  `indexOf` comparison that holds when neither element is present, a permanent
  `test.skip`, and an assertion inside `process.nextTick` that runs after the test
  ends. The module under test sits in `base/` so the assertions can be judged against
  real behaviour. Model axis. Recorded on every live cell but `codex.model`.

The last three cases exist because of the variance measured above, not because five
cases sounded better than two. `repo-context` plants two defects, so one miss moves
the composite by 35 points and `agy.model` swung 65 across three repeats; on
five-defect `auth-basic` the same cell swung 13. Granularity looked like the dominant
term in the noise, so every case added here plants four or five — and on the model
cells it delivered: their worst move on the new cases is 24, against 65 on
two-defect `repo-context`. The harness side did not follow: the deep cells move 41 and 24 on the new cases against
5 and 5 on `repo-context` — the opposite direction. Granularity is a lever on the model
cells' noise and not on the harness cells', whose variance comes from somewhere this
corpus does not control.

### Adding a case

1. Create `corpus/<id>/head/...` (and `base/...` for a real diff) with the defects.
2. Write `corpus/<id>/ground-truth.json` (give every planted defect keywords).
3. `node bench/run-bench.mjs --live --case <id>` to record cassettes, or hand-author
   `cassettes/<id>/<cell>.json` for deterministic runs.
