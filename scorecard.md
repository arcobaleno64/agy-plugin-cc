# review benchmark scorecard — agy · gemini · codex

> Mode: **replay** · repeats: 1 · cases: 2 · generated: 2026-08-19T02:56:08.466Z

## Verdicts

| Axis | Winner | Detail |
|---|---|---|
| **Model** (single-shot, tools off) | **tie** | within noise · gemini 73 · agy 72 · codex 36 |
| **Harness** (agentic reviewers) | **—** | not decidable: 1 of 3 cells measured · codex 93 (seeded) · agy 87 · gemini 82.5 (seeded) |
| Harness lift — gemini | +9.5 | one end is seeded — not a measurement |
| Harness lift — codex | +57 | one end is seeded — not a measurement |
| Harness lift — agy | +15 | agy.model → agy.deep composite |

## Per-cell aggregate

| Cell | Source | Cases | Composite | Recall | Precision | FP | Bonus | Sev-exact | Latency |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Gemini (model, single-shot) | live 2026-06-04 | 2 | 73 | 0.65 | 1 | 0 | 0 | 0.75 | 44083ms |
| Codex (model, single-shot) | live 2026-06-04 | 2 | 36 | 0.3 | 0.5 | 1 | 0 | 0.5 | 28356ms |
| AGY (model, single-shot) | live 2026-08-19 · 1.1.14 | 2 | 72 | 0.65 | 1 | 0 | 0 | 0.63 | 22672ms |
| Gemini (--deep, agentic) | **seeded** | 2 | 82.5 | 0.75 | 1 | 0 | 0 | 1 | 25950ms |
| Codex (native review, agentic) | **seeded** | 2 | 93 | 0.9 | 1 | 0 | 1 | 1 | 39850ms |
| AGY (--deep, agentic) | live 2026-08-19 · 1.1.14 | 2 | 87 | 0.9 | 0.84 | 1 | 0 | 0.75 | 33498ms |

## Per-case breakdown

| Case | Cell | Status | Composite | Recall | FP | Bonus | Missed |
|---|---|:-:|:-:|:-:|:-:|:-:|---|
| auth-basic | gemini.model | ok | 81 | 0.8 | 0 | 0 | null-check |
| auth-basic | codex.model | ok | 72 | 0.6 | 0 | 0 | plaintext-compare, json-parse |
| auth-basic | agy.model | ok | 79 | 0.8 | 0 | 0 | plaintext-compare |
| auth-basic | gemini.deep | ok | 100 | 1 | 0 | 0 | — |
| auth-basic | codex.native | ok | 86 | 0.8 | 0 | 1 | json-parse |
| auth-basic | agy.deep | ok | 81 | 0.8 | 0 | 0 | plaintext-compare |
| repo-context | gemini.model | ok | 65 | 0.5 | 0 | 0 | committed-state |
| repo-context | codex.model | ok | 0 | 0 | 1 | 0 | missing-dependency, committed-state |
| repo-context | agy.model | ok | 65 | 0.5 | 0 | 0 | committed-state |
| repo-context | gemini.deep | ok | 65 | 0.5 | 0 | 0 | committed-state |
| repo-context | codex.native | ok | 100 | 1 | 0 | 0 | — |
| repo-context | agy.deep | ok | 93 | 1 | 1 | 0 | — |

## Caveats

- The **model axis** isolates raw single-shot quality (diff embedded, tools forbidden); the **harness axis** is each tool's repo-exploring reviewer. Most real-world gap lives on the harness axis — see `docs/MODEL_COMPARISON.md`.
- Composite = `recall*70 + precision*20 + severityExact*10` (0–100); it is a summary, not a verdict — read the columns.
- In `--live` mode model output is non-deterministic; treat single-digit composite gaps as noise. Use `--repeats N` to average.
- A cell marked **seeded** was never run: its cassette is an illustration kept so the table has a shape, and it is excluded from every verdict and lift above.
- A finding outside the planted set but on the case's `allowed_extras` list counts as **bonus** (a legitimate unique catch), not a false positive.

