# bench — agy vs gemini vs codex review benchmark

A reproducible harness that pits **AGY**, **Gemini** and **Codex** against each other
on code review, scored automatically against planted ground truth. It operationalizes
the manual comparison in [`docs/MODEL_COMPARISON.md`](../docs/MODEL_COMPARISON.md):
the interesting question is **model vs harness**, so the benchmark measures both.

## Two axes, six cells

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

- **Model axis** = every `*.model` cell (same prompt, no tools).
- **Harness axis** = every agentic cell (each tool's repo-exploring reviewer).
- **Harness lift** = within a tool, `model → agentic` composite delta.

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

- **`gemini.model`, `agy.model`, `agy.deep` — live-recorded on all five cases**,
  three samples each, all on 2026-08-19: the two older cases on gemini 0.54.4 / agy
  1.1.14, the three new ones on gemini 0.55.1 / agy 1.1.15.
- **`gemini.deep` — no cassette.** It had five, and every one of them was AGY. See
  below.
- **`codex.model` — live-recorded on two cases only** (codex-cli 0.147.0). The three
  new cases are unrecorded because the account hit its usage limit mid-session: exit 1,
  empty stdout, `ERROR: You've hit your usage limit ... try again at Aug 25th, 2026` on
  stderr. Recordable again after that date; until then it prints
  `skipped (no cassette)` on three of five cases and its aggregate covers two.
- **`codex.native` — still seeded.** `BENCH_CODEX_COMPANION` was unset, so it was
  skipped rather than recorded.
- **`gemini.deep` records headlessly after all.** An older note here said it could
  not — that `gemini --deep` exits non-zero with empty stdout because tool approvals
  need a TTY. It has now recorded fifteen times without complaint.

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

- The five `gemini.deep` cassettes are deleted. They are real measurements of AGY's
  harness, but nothing labels them that way inside the file, and left on the board they
  put an AGY number in a column headed Gemini.
- **The harness axis previously compared AGY against AGY.** The old "tie, lead of 3.2"
  was two recordings of one engine, and the "harness lift — gemini" number was
  gemini's model cell measured against AGY's harness.
- "`gemini.deep` is the steadiest cell on the board" — a claim this file carried for
  weeks — was AGY, twice.
- Both companion cells now pin `--engine` on the command line, and `GEMINI_ENGINE` is
  stripped from the child environment. Two tests hold that: one on the environment, one
  reading the dispatch table for the flag.

The remaining hole is that a cassette still asserts its engine rather than observing
it: the companion's `--json` payload does not report which engine ran, so the runner
has nothing to check the pin against. Pinning makes the cell right; it does not make
the cassette self-describing.

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
| `agy.deep` | 81, 77, 93 | 88, 88, 83 | 81, 62, 81 | 53, 69, 69 | 95, 71, 95 | **24** |
| ~~`gemini.deep`~~ — AGY, mislabelled | 80, 81, 81 | 88, 88, 88 | 81, 69, 69 | 69, 69, 53 | 76, 53, 93 | 40 |

The last row is struck through because it is AGY under a gemini label (above). It is
kept because it is still a measurement — a second, independent AGY harness run — and
because the row is what the numbers below were read off before anyone knew that.

Three readings, in the order they cost something to learn.

1. **"The agentic cells are an order of magnitude steadier" was a property of the two
   cases, not of the cells.** That is what this section used to claim, on the strength
   of `gemini.deep` moving by 1 and by 0 — which was AGY, and so was the `agy.deep`
   row it was being praised against. The same recording moves by 40 on
   `vacuous-tests`. Set `repo-context` aside and the ordering does not survive: the
   two AGY harness runs' worst moves are 40 and 24, the model cells' 26, 24 and 19.
   What the old pair actually measured is that a harness is steady *on the case built
   to need a harness* — `repo-context` is invisible single-shot, so the model cells
   were guessing there, and guessing has variance. That is a much narrower claim than
   the one it replaced, and it is the one the data carries.
2. **Granularity was the dominant term in the model cells' noise, as predicted, and it
   was not enough.** Two-defect `repo-context` is where every model cell posts its
   widest move (55, 65, 45); across the four- and five-defect cases the same cells move
   at most 26. One miss worth 35 composite points really was most of the old spread.
   It bought no verdict: the board's leads are 6.4 on the model axis and 3.2 on the
   harness axis, against bands of ±65 and ±40.
3. **The harness axis has one measured cell, so there is no harness comparison at
   all** — `agy.deep` alone, with `codex.native` seeded and `gemini.deep` unrecorded.
   The model axis has three, and no axis is decidable — and under the present rule, no
   amount of extra sampling can make one decidable. Spread is a *range* (`max - min` over repeats, then `max`
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
  the **model axis** (everything is visible in the diff). Recorded on `gemini.model`,
  `agy.model`, `codex.model` and `agy.deep`.
- **`repo-context`** — an undeclared dependency and a committed runtime-state file;
  invisible single-shot, so it probes the **harness axis** (`MODEL_COMPARISON.md §B`).
  Recorded on `gemini.model`, `agy.model`, `codex.model` and `agy.deep`.
- **`async-lifecycle`** — five async and resource defects in one file: a catch that
  returns success, an unclosed handle, an uncleared interval, an unawaited promise and
  a map nothing deletes from. Model axis. Recorded on `gemini.model`, `agy.model`
  and `agy.deep`.
- **`path-and-input`** — two loud injection paths (traversal, `execSync`) and three
  quiet ones (`parseInt` without a radix, an unbounded read, an unhandled ENOENT).
  The quiet three are the discriminating half: a reviewer that reports only the two
  criticals scores 0.4 recall. Model axis. Recorded on `gemini.model`, `agy.model`
  and `agy.deep`.
- **`vacuous-tests`** — four green tests that constrain nothing: no assertion, an
  `indexOf` comparison that holds when neither element is present, a permanent
  `test.skip`, and an assertion inside `process.nextTick` that runs after the test
  ends. The module under test sits in `base/` so the assertions can be judged against
  real behaviour. Model axis. Recorded on `gemini.model`, `agy.model` and
  `agy.deep`.

The last three cases exist because of the variance measured above, not because five
cases sounded better than two. `repo-context` plants two defects, so one miss moves
the composite by 35 points and `agy.model` swung 65 across three repeats; on
five-defect `auth-basic` the same cell swung 13. Granularity looked like the dominant
term in the noise, so every case added here plants four or five — and on the model
cells it delivered: their worst move on the new cases is 24, against 65 on
two-defect `repo-context`. The harness side did not follow: the two AGY harness recordings move 40 and 24 on the
new cases, against 0 and 5 on `repo-context`. Granularity is a lever on the model
cells' noise and not on the harness cells'.

### Adding a case

1. Create `corpus/<id>/head/...` (and `base/...` for a real diff) with the defects.
2. Write `corpus/<id>/ground-truth.json` (give every planted defect keywords).
3. `node bench/run-bench.mjs --live --case <id>` to record cassettes, or hand-author
   `cassettes/<id>/<cell>.json` for deterministic runs.
