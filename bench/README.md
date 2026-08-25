# bench — agy vs gemini vs codex review benchmark

A reproducible harness that pits **AGY**, **Gemini** and **Codex** against each other
on code review, scored automatically against planted ground truth. It operationalizes
the manual comparison in [`docs/MODEL_COMPARISON.md`](../docs/MODEL_COMPARISON.md):
the interesting question is **model vs harness**, so the benchmark measures both.

## Three axes, a control, and eleven cells

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
| `gemini.shallow` | `gemini-companion review` **without** `--deep` | control (prompt only) |
| `agy.shallow` | `gemini-companion review --engine agy`, no `--deep` | control (prompt only) |
| `gemini.adversarial` | `gemini-companion adversarial-review --deep --engine gemini` | adversarial |
| `codex.adversarial` | `codex-companion adversarial-review` | adversarial |
| `agy.adversarial` | `gemini-companion adversarial-review --deep --engine agy` | adversarial |

- **Model axis** = every `*.model` cell (same prompt, no tools).
- **Harness axis** = each tool's default repo-exploring reviewer.
- **Adversarial axis** = each tool's adversarial reviewer.
- The `*.shallow` cells are a **control, not an axis**: they hold the prompt fixed
  against `*.deep` so the lift can be split. They enter no verdict row.
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
> One further limit on reading any lift here: its sign is set by corpus composition.
> Across the original five cases the per-case deltas run from −20 to +17 on both
> engines, so a mean over them says as much about which cases exist as about the
> harness. Adding cases that exercise the capability is what makes the axis a
> measurement; adding repeats is not — see finding 4 below on why the spread statistic
> cannot shrink.
>
> **Measured, on agy 1.1.19 across all seven cases, three samples each:**
>
> | case | model | shallow | deep | prompt | exploration |
> |---|:-:|:-:|:-:|:-:|:-:|
> | async-lifecycle | 91 | 69 | 71 | −22 | +2 |
> | auth-basic | 95 | 81 | 83 | −14 | +2 |
> | path-and-input | 72 | 69 | 69 | −3 | 0 |
> | vacuous-tests | 71 | 82 | 94 | +11 | +12 |
> | **caller-contract** | 0 | 0 | **68** | 0 | **+68** |
> | **repo-context** | 55 | 15 | **76** | −40 | **+61** |
> | **stale-duplicate** | 43 | 18 | **67** | −25 | **+49** |
> | **mean** | | | | **−13.3** | **+27.8** |
>
> The −4.4 harness lift reported over the original five cases was two opposing effects
> cancelling. Exploration is worth **+28** on average and its gains land exactly where
> the design says they should — +68, +61, +49 on the three repository-scoped cases,
> against +2, +2, 0, +12 on the four file-scoped ones. The plugin's own review prompt,
> run without tools, is worth **−13** against the bench's neutral prompt, and that
> penalty is concentrated on the same repository-scoped cases (−40, −25).
>
> What that penalty is *not*: it is not the `DEEP REVIEW MODE` block, which the
> `*.shallow` cells never see, and it is not a thinner input — the probe over all
> seven cases puts `REVIEW_INPUT` between 645 and 1414 characters against a 400,000
> cap, with the full diff present in both. It is `prompts/review.md` itself, and an
> ablation takes half of it apart
> ([`ablations/prompt-penalty-2026-08-25.json`](ablations/prompt-penalty-2026-08-25.json)).
>
> The ablation runs review.md's *text* through the same single-shot path as the
> `*.model` cells, with the same diff substituted into `{{REVIEW_INPUT}}`, so the only
> thing that varies between it and the model axis is the prompt string. That
> reproduces the penalty: on `async-lifecycle` and `auth-basic` the verbatim prompt
> lands at 68.7 and 82.0, against `agy.shallow`'s 69 and 81. The cause is the prompt
> text, not how the companion builds its input.
>
> | arm | removed | composite | recall | findings |
> |---|---|:-:|:-:|:-:|
> | `agy.model` | — (the neutral prompt) | 93.0 | 0.97 | 4.83 |
> | E | D + `<review_scope>` | 86.2 | 0.87 | 4.33 |
> | D | all four hedging blocks | 84.2 | 0.87 | 4.83 |
> | A | nothing — review.md verbatim | 75.3 | 0.73 | 3.83 |
>
> **+8.8 of the 17.7 is four hedging blocks** — `<calibration_rules>`, `<finding_bar>`,
> `<operating_stance>`, `<grounding_rules>` — and the mechanism is volume: dropping
> them takes the findings count from 3.83 to 4.83, exactly `agy.model`'s. Removing
> them in pairs (arms B and C, in the artifact) buys about +4 each, in per-case
> directions that disagree, so no single block carries it.
>
> **`<review_scope>` is not a cause.** The prediction was that an enumerated category
> list aims attention, so removing it should move recall. Recall does not move at all
> — 0.867 either way — and the +2.0 in composite sits inside a band whose single
> samples run 79 to 96.
>
> **The remaining ~6.8 is not suppression, and is not attributed.** At arm E the
> prompt is down to 1731 characters from 3250 and reports as many findings as the
> neutral one, but hits 0.87 of the planted defects against 0.97. Same volume, worse
> aim. What is left — the `<role>` framing, the XML sectioning itself, sheer length —
> is smaller than the noise band at three samples, so choosing between them needs more
> repeats rather than more arms, and that experiment has not been run.
>
> **The ablation covers the file-scoped end only.** The two largest per-case penalties
> (−40 on `repo-context`, −25 on `stale-duplicate`) sit on repository-scoped two-defect
> cases that neither end of the control can solve without tools. A composite that moves
> 40 points on two planted defects is one finding either way, and three samples of one
> finding decides nothing, so those cases were left out rather than explained.
>
> One thing held across all 33 runs: **precision never moved.** It is ~1.00 in every
> arm, verbatim prompt included. Whatever this prompt spends recall on, it is not
> buying precision with it — the same signature the adversarial axis showed.
>
> **These numbers were read off a matcher that had to be fixed first.** It credited a
> finding for naming a defect's subject without making its claim, and the credit was
> not spread evenly: `repo-context`'s `agy.model` was reading 97 for catching an
> undeclared dependency it never mentioned, which alone put 20 points of the prompt
> penalty on that case. Tightening every planted defect into a subject (`match.all`)
> and a claim (`match.keywords`) took the share of recorded findings that match more
> than one planted defect from 16% to 2.4%, and moved no cell's mean by more than
> 1.5 points — the correction was concentrated, not diffuse.
>
> The 2.4% that remains is a different thing and is left alone: all ten are findings
> that genuinely report two defects in one entry ("Plaintext Password Comparison and
> Unchecked Null User"). The scorer credits one of the two, so it under-counts them.
> Dropping them outright takes exploration to +12.5, but that number is a statement
> about how a merged finding is counted, not about the matcher, and most of the swing
> is `caller-contract`, where two of the four recorded findings are merged reports.
>
> `caller-contract` and `stale-duplicate` were added for exactly that, joining
> `repo-context` as the cases whose planted defects are repository-scoped (`file: "*"`).
> They are the first evidence on this board that exploration does anything at all:
> on `caller-contract`, `agy.model` scores **0** — it misses both defects, because the
> diff is a clean refactor of `findUser` and says nothing about the two callers left on
> the old contract — while `agy.deep` scores **68**. On `stale-duplicate` the same pair
> is 43 → 67. Both far outside any band on this board.

The adversarial cells are a third axis rather than more entries on the harness one,
because the two prompts are not interchangeable: `prompts/review.md` asks for a
pragmatic review, `prompts/adversarial-review.md` asks the model to break confidence
in the change. Ranking one against the other would be a column stating what
it is supposed to hold rather than what it holds.

The prediction behind that separation was wrong, and the measurement is worth keeping
next to it. Composite is `recall*70 + precision*20 + severityExact*10`, so the guess
was that the adversarial prompt would buy recall at the cost of false positives.
Measured on agy 1.1.19 across five cases x3, `agy.deep` -> `agy.adversarial` moved
recall 0.79 -> 0.72, precision 0.88 -> 0.87 and false positives 0.40 -> 0.40. The
prediction fails on its own terms: the adversarial prompt did not buy recall, and it
did not spend precision or false positives failing to. It reports less, and that is
the whole of the difference. The axis stays separate anyway — the prompts are not
interchangeable whichever way the scores happen to fall.

An earlier version of this paragraph read 0.81 -> 0.77, 0.91 -> 0.92 and 1.67 -> 1.33.
Those came off the matcher corrected below, which credited a finding for naming a
defect's subject without making its claim. The direction survived the re-scoring; the
two numbers that made it look like a precision-for-recall trade did not.

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

- **`codex.model` — live-recorded on all seven cases** (codex-cli 0.149.0, three
  samples each, 2026-08-24 and 2026-08-25). The three cases that were missing while
  the account sat at its usage limit were recorded once it reset, and the two older
  ones were re-recorded on the same version so the cell reads as one tool at one
  version. The two repository-scoped cases came last: `caller-contract` **0**,
  `stale-duplicate` **62**. The zero is the case doing its job — both planted defects
  live outside the diff, and `agy.model` scores 0 on it too.
- **`agy.model`, `agy.deep`, `agy.shallow` — live-recorded on all seven cases**
  (agy 1.1.19, three samples each, 2026-08-24). Both cells sat mid-refresh for part of that day: AGY
  refused four recordings with `Individual quota reached ... Resets in 94h2m50s`, and
  they were finished once the account reset. A failed live record leaves the existing
  cassette untouched, so nothing was lost while the cell was half-refreshed — and
  while it was, the scorecard said so rather than printing the newer version for
  every case.
- **`gemini.model` — five of seven cases on gemini 0.56.0** (three samples each,
  2026-08-24), recorded once a `GEMINI_API_KEY` was available; the stored OAuth token
  had expired on 2026-08-20.
- **`gemini.deep` — four of seven cases on 0.56.0**, `vacuous-tests` still on 0.55.1,
  and the two repository-scoped cases unrecorded. `gemini.shallow` is unrecorded
  entirely — the same engine hang.
  That case does not merely miss the 180s cap on 0.56.0, it produces nothing at 420s
  with empty stdout and empty stderr, reproduced three times, while the other four
  finish in ~35s. `gemini.deep`'s cassettes remain the only genuine gemini reading the
  harness axis has — see the AGY mix-up below.
- **`gemini.adversarial` — unrecorded.** The same hang, wider: both cases attempted
  (`async-lifecycle`, `auth-basic`) were killed at the cap with no output, while the
  identical cases complete under `review --deep` and every adversarial case completes
  under `--engine agy`. It tracks prompt weight on the gemini engine, not the case and
  not the subcommand.
- **`codex.adversarial` — live-recorded on all seven cases**, `agy.adversarial` on
  five (codex-cli 0.149.0 and agy 1.1.19, three samples each, 2026-08-24 and
  2026-08-25). On the two repository-scoped cases codex's adversarial reviewer scores
  **43** and **65** against its own single-shot **0** and **62** — it explores, so the
  gain is a harness reading and not a prompt one. `agy.adversarial` has not been run
  on those two cases yet.
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

### What seven cases at three samples showed

Composite per repeat, and the widest move each cell made between repeats of the same
recording. Every number here is scored by the corrected matcher (§ Scoring); the
figures this section carried before were read off the loose one and off cassettes that
have since been re-recorded, so none of them are comparable to these.

| cell | `auth-basic` | `repo-context` | `async-lifecycle` | `path-and-input` | `vacuous-tests` | `caller-contract` | `stale-duplicate` | widest |
|---|---|---|---|---|---|---|---|:-:|
| `gemini.model` | 92, 92, 81 | 55, 0, 0 | 84, 81, 81 | 84, 84, 72 | 79, 76, 79 | — | — | 55 |
| `agy.model` | 94, 96, 94 | 55, 55, 55 | 96, 94, 84 | 72, 72, 72 | 76, 76, 60 | 0, 0, 0 | 65, 0, 65 | **65** |
| `codex.model` | 86, 72, 86 | 0, 0, 0 | 69, 81, 84 | 53, 69, 53 | 93, 79, 73 | 0, 0, 0 | 65, 65, 55 | 20 |
| `gemini.deep` | 81, 81, 96 | 83, 88, 45 | 64, 72, 79 | 81, 69, 65 | 79, 55, 58 | — | — | 43 |
| `agy.deep` | 77, 77, 96 | 88, 88, 52 | 69, 76, 69 | 69, 69, 69 | 93, 95, 93 | 95, 55, 55 | 55, 90, 55 | 40 |
| `agy.shallow` | 81, 81, 81 | 0, 0, 45 | 62, 64, 81 | 69, 69, 69 | 76, 93, 76 | 0, 0, 0 | 0, 0, 55 | 55 |
| `codex.adversarial` | 69, 81, 69 | 0, 0, 0 | 79, 79, 79 | 53, 53, 53 | 95, 76, 93 | 65, 0, 65 | 65, 65, 65 | **65** |
| `agy.adversarial` | 64, 81, 79 | 42, 88, 42 | 81, 84, 84 | 53, 53, 53 | 98, 98, 95 | — | — | 46 |

An earlier version of this table carried a struck-through row for `gemini.deep` as it
was before the engine mix-up was found — AGY under a gemini label. That row is gone
rather than corrected: its cassettes were deleted, so its numbers cannot be re-scored
under the current matcher, and leaving pre-fix numbers in a table of post-fix ones is
the same error this section is about. The mix-up itself is documented above and still
matters; only its scoreboard row has been retired.

Four readings, in the order they cost something to learn.

1. **Steadiness does not separate by harness, and a steady cell is not a reliable
   one.** This section used to claim the agentic cells were "an order of magnitude
   steadier", on the strength of a `gemini.deep` that turned out to be AGY. What the
   board shows now is that the two widest moves on it belong to a *model* cell
   (`agy.model`, 65 on `stale-duplicate`) and an *adversarial* one
   (`codex.adversarial`, 65 on `caller-contract`), while the two deep cells top out at
   43 and 40.

   The surviving piece of the old reading has inverted too, and the inversion is the
   more useful fact. It used to say the deep cells were steady on `repo-context` — the
   case built to need a harness — while the model cells thrashed. They now move 43 and
   36 there, and `agy.model` posts 55, 55, 55 while `codex.model` posts 0, 0, 0. Those
   are perfect steadiness and they mean nothing: a cell that fails the same way every
   time has no spread. On this board low spread reads as *consistent*, not as
   *trustworthy*, and the repository-scoped cases are where the two come apart —
   exploration sometimes lands and sometimes does not, which is what movement in a
   deep cell looks like when the cell is actually doing something.

2. **Granularity is still the dominant term in the noise, and still buys no verdict.**
   Every widest move on the board sits on a two-defect case: 55 and 65 on
   `stale-duplicate`, 65 on `caller-contract`, 55 and 43 on `repo-context`. Across the
   four- and five-defect cases no cell moves more than 24. One miss worth 35 composite
   points really is most of the spread. It buys nothing: the board's leads are 8.2 on
   the model axis and 2.2 on the harness axis, against bands of ±65 and ±43.

3. **No lift on this board clears its own noise, and they are not measured over the
   same cases.** Harness lift is +4 for gemini, +14.4 for AGY, both inside their bands.
   Codex's +41.4 has a seeded end and is not a measurement at all. Worth stating
   plainly because the table above hides it: gemini's lift spans five cases and AGY's
   spans seven, and the two extra cases are precisely the ones where exploration pays.
   Comparing those two lifts to each other would be comparing corpora, not tools.

4. **No axis is decidable — and under the present rule, no amount of extra sampling can
   make one decidable.** Spread is a *range* (`max - min` over repeats, then `max`
   over cases, `lib/report.mjs:59`), and a range only ever grows as samples are added.
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
- `match.keywords` is **any-of** — the reviewer's wording for the claim is free.
  `match.all` is **every-of** — the subject the finding has to actually be about.
  A wildcard defect is matched on words alone, and a subject word is a word every
  finding about that area writes down: `repo-context` listed the bare module name
  among its any-of keywords, so a finding about an unvalidated secret, which named
  the module only in passing, was credited with catching a missing manifest entry.
  That single false credit was worth 42 composite points to one cell and nothing to
  others — worse than being wrong uniformly, because the board is a comparison
  between cells. Put the subject in `all` and the claim in `keywords`, and a
  finding has to carry both. Every case declares both now; a `file: "*"` defect that
  does not is a test failure, because there the filename disambiguates nothing.
  The four file-scoped cases were split the same way — five defects sharing one file
  also share a vocabulary, and words like `undefined`, `leak`, `throws`, `memory` and
  `..` were carrying credit on their own. Findings matching more than one planted
  defect fell from 16% to 2.4%, and what is left is genuine: one entry reporting two
  defects at once, which the scorer credits once.
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
      "match": { "keywords": ["sql injection", "concatenat"] } },
    { "id": "missing-dependency", "file": "*",
      "line_start": 1, "line_end": 1, "severity": "high",
      "match": { "all": ["jsonwebtoken"],
                 "keywords": ["undeclared", "not in package.json"] } }
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
