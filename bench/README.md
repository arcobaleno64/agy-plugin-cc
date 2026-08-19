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
npm run bench:live       # run the real CLIs and re-record cassettes (needs auth)

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
recorded against, and no `source`; a seeded one carries a `source` field. The
scorecard prints this per cell, and **a seeded cell is excluded from every verdict
and every harness lift** — it is an illustration kept so the table has a shape, not a
result. Current committed state:

- **`agy.model`, `agy.deep` — live-recorded** (2026-08-19, agy 1.1.14, single sample).
  Both axes of the AGY column are real, which makes the AGY harness lift
  (`agy.model` → `agy.deep`) the only lift on the scorecard measured end to end.
- **`gemini.model`, `codex.model` — live-recorded** (2026-06-04, gemini 0.45 /
  codex-cli 0.137, single sample) and predate the `engineVersion` field, so their
  builds are recorded here rather than in the cassette. Gemini CLI's consumer tier
  stopped serving on 2026-06-18, so re-recording `gemini.model` now needs a paid
  Code Assist or API-key credential.
- **`gemini.deep`, `codex.native` — still seeded.** They could not be driven
  headlessly in this environment: `gemini --deep` exits non-zero with empty stdout
  under headless agentic+JSON mode (tool approvals need a TTY), and the
  `codex.native` app-server review exceeded the 180s cap. Refresh them with a longer
  `BENCH_TIMEOUT_MS`, an interactive/approved session, or on a platform where the
  agentic harness runs non-interactively.

`agy.deep` records headlessly where `gemini.deep` cannot, because AGY's print mode
auto-approves tools and never waits for a TTY. That is a difference in permission
model, not in capability, and `docs/THREAT-MODEL.md` 7.2 is where it is argued about
rather than celebrated.

Adding a cell means one entry in `lib/cells.mjs` and one `case` in `lib/adapters.mjs`;
everything else — which cases get materialized, which cells need a repo, the axes,
the lifts — reads the registry. It did not always: two hardcoded cell lists in
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

Seeded cases:
- **`auth-basic`** — five in-diff defects (the `MODEL_COMPARISON.md §A` set); probes
  the **model axis** (everything is visible in the diff).
- **`repo-context`** — an undeclared dependency and a committed runtime-state file;
  invisible single-shot, so it probes the **harness axis** (`MODEL_COMPARISON.md §B`).

### Adding a case

1. Create `corpus/<id>/head/...` (and `base/...` for a real diff) with the defects.
2. Write `corpus/<id>/ground-truth.json` (give every planted defect keywords).
3. `node bench/run-bench.mjs --live --case <id>` to record cassettes, or hand-author
   `cassettes/<id>/<cell>.json` for deterministic runs.
