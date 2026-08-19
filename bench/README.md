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

- `gemini` on PATH and authenticated (`gemini` once for OAuth) for the gemini cells.
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

- **`agy.model`, `agy.deep`, `gemini.deep`, `codex.model` — live-recorded**
  (2026-08-19, three samples each: agy 1.1.14, gemini 0.54.4, codex-cli 0.147.0).
- **`gemini.deep` records headlessly after all.** The previous note here said it could
  not — that `gemini --deep` exits non-zero with empty stdout because tool approvals
  need a TTY. It recorded six times without complaint on gemini 0.54.4, so whatever
  blocked it in this environment was not permanent. It is also the steadiest cell on
  the board.
- **`gemini.model` — still the 2026-06-04 single sample** (gemini 0.45). It now fails
  to re-record for a reason that has nothing to do with credentials: the CLI prints
  `Warning: True color (24-bit) support not detected` and `Ripgrep is not available`
  ahead of its JSON, and the cell's parser gives up. Worth fixing before trusting
  anything about the gemini model axis.
- **`codex.native` — still seeded.** `BENCH_CODEX_COMPANION` was unset, so it was
  skipped rather than recorded.

### What three samples showed

Enough to disqualify every single-sample number the scorecard has ever printed,
including the ones this file used to quote. Composite, per repeat:

| cell | `auth-basic` | `repo-context` | widest move |
|---|---|---|:-:|
| `gemini.deep` | 80, 81, 81 | 88, 88, 88 | **1** |
| `agy.deep` | 81, 77, 93 | 88, 88, 83 | 16 |
| `codex.model` | 96, 72, 98 | 0, 45, 0 | 45 |
| `agy.model` | 81, 94, 81 | 0, 65, 65 | **65** |

Two things fall out, and only one of them is about scores.

1. **The agentic cells are an order of magnitude steadier than the model cells.**
   `gemini.deep` moved by 1 point across six runs; `agy.model` moved by 65 on a single
   case. Whatever a repo-exploring harness is doing, part of it is making the answer
   repeatable — which is a more useful claim than any composite here, and the only one
   the data currently supports.
2. **The old ±2 noise band was calibrated against nothing.** It is now the measured
   spread: a verdict is named only when the lead is wider than the widest move either
   cell made between repeats. Under that rule no axis on this board is decidable, and
   neither is AGY's harness lift. That is the honest reading of two cases at three
   samples, not a defect in the runner.

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
  the **model axis** (everything is visible in the diff). Recorded.
- **`repo-context`** — an undeclared dependency and a committed runtime-state file;
  invisible single-shot, so it probes the **harness axis** (`MODEL_COMPARISON.md §B`).
  Recorded.
- **`async-lifecycle`** — five async and resource defects in one file: a catch that
  returns success, an unclosed handle, an uncleared interval, an unawaited promise and
  a map nothing deletes from. Model axis. Not yet recorded.
- **`path-and-input`** — two loud injection paths (traversal, `execSync`) and three
  quiet ones (`parseInt` without a radix, an unbounded read, an unhandled ENOENT).
  The quiet three are the discriminating half: a reviewer that reports only the two
  criticals scores 0.4 recall. Model axis. Not yet recorded.
- **`vacuous-tests`** — four green tests that constrain nothing: no assertion, an
  `indexOf` comparison that holds when neither element is present, a permanent
  `test.skip`, and an assertion inside `process.nextTick` that runs after the test
  ends. The module under test sits in `base/` so the assertions can be judged against
  real behaviour. Model axis. Not yet recorded.

The three unrecorded cases exist because of the variance measured above, not because
five cases sounded better than two. `repo-context` plants two defects, so one miss
moves the composite by 35 points and `agy.model` swung 65 across three repeats; on
five-defect `auth-basic` the same cell swung 13. Granularity was the dominant term in
the noise, so every case added here plants four or five. Until they are recorded they
print as `skipped (no cassette)` and change no number on the board.

### Adding a case

1. Create `corpus/<id>/head/...` (and `base/...` for a real diff) with the defects.
2. Write `corpus/<id>/ground-truth.json` (give every planted defect keywords).
3. `node bench/run-bench.mjs --live --case <id>` to record cassettes, or hand-author
   `cassettes/<id>/<cell>.json` for deterministic runs.
