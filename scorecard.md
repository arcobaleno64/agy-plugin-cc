# review benchmark scorecard — agy · gemini · codex

> Mode: **replay** · repeats: 1 · cases: 2 · generated: 2026-08-19T08:08:44.544Z

## Verdicts

| Axis | Winner | Detail |
|---|---|---|
| **Model** (single-shot, tools off) | **tie** | lead of 12 does not clear the ±65 either cell moves between runs · gemini 73 (1 sample) · agy 64 ±65 · codex 52 ±45 |
| **Harness** (agentic reviewers) | **tie** | lead of 0.5 does not clear the ±16 either cell moves between runs · codex 93 (seeded) · agy 85 ±16 · gemini 84.5 ±1 |
| Harness lift — gemini | +11.5 | one end was recorded once — its noise is unknown |
| Harness lift — codex | +41 | one end is seeded — not a measurement |
| Harness lift — agy | +21 | does not clear the ±65 its ends move between runs |

## Per-cell aggregate

| Cell | Source | Cases | Composite | Spread | Recall | Precision | FP | Bonus | Sev-exact | Latency |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Gemini (model, single-shot) | live 2026-06-04 | 2 | 73 | — | 0.65 | 1 | 0 | 0 | 0.75 | 44083ms |
| Codex (model, single-shot) | live 2026-08-19 · codex-cli 0.147.0 ×3 | 2 | 52 | ±45 | 0.52 | 0.59 | 1.67 | 0.33 | 0.4 | 18414ms |
| AGY (model, single-shot) | live 2026-08-19 · 1.1.14 ×3 | 2 | 64 | ±65 | 0.6 | 0.84 | 0.33 | 0 | 0.57 | 25679ms |
| Gemini (--deep, agentic) | live 2026-08-19 · 0.54.4 ×3 | 2 | 84.5 | ±1 | 0.9 | 0.8 | 1.33 | 0 | 0.54 | 31253ms |
| Codex (native review, agentic) | **seeded** | 2 | 93 | — | 0.9 | 1 | 0 | 1 | 1 | 39850ms |
| AGY (--deep, agentic) | live 2026-08-19 · 1.1.14 ×3 | 2 | 85 | ±16 | 0.94 | 0.78 | 1.67 | 0 | 0.43 | 33105ms |

## Per-case breakdown

| Case | Cell | Status | Composite | Recall | FP | Bonus | Missed |
|---|---|:-:|:-:|:-:|:-:|:-:|---|
| auth-basic | gemini.model | ok | 81 | 0.8 | 0 | 0 | null-check |
| auth-basic | codex.model | ok | 89 | 0.87 | 0 | 0.33 | — |
| auth-basic | agy.model | ok | 85 | 0.87 | 0 | 0 | plaintext-compare |
| auth-basic | gemini.deep | ok | 81 | 0.8 | 0.33 | 0 | plaintext-compare |
| auth-basic | codex.native | ok | 86 | 0.8 | 0 | 1 | json-parse |
| auth-basic | agy.deep | ok | 84 | 0.87 | 0.67 | 0 | — |
| repo-context | gemini.model | ok | 65 | 0.5 | 0 | 0 | committed-state |
| repo-context | codex.model | ok | 15 | 0.17 | 1.67 | 0 | missing-dependency, committed-state |
| repo-context | agy.model | ok | 43 | 0.33 | 0.33 | 0 | committed-state |
| repo-context | gemini.deep | ok | 88 | 1 | 1 | 0 | — |
| repo-context | codex.native | ok | 100 | 1 | 0 | 0 | — |
| repo-context | agy.deep | ok | 86 | 1 | 1 | 0 | — |

## Caveats

- The **model axis** isolates raw single-shot quality (diff embedded, tools forbidden); the **harness axis** is each tool's repo-exploring reviewer. Most real-world gap lives on the harness axis — see `docs/MODEL_COMPARISON.md`.
- Composite = `recall*70 + precision*20 + severityExact*10` (0–100); it is a summary, not a verdict — read the columns.
- In `--live` mode model output is non-deterministic; treat single-digit composite gaps as noise. Use `--repeats N` to average.
- **Spread** is the widest gap between repeats of the same recording, on the least stable case. It is the noise band: a verdict is only named when the lead is wider than it. A cell recorded once has no spread and cannot win or lose an axis — `—` there means unknown, not stable.
- A cell marked **seeded** was never run: its cassette is an illustration kept so the table has a shape, and it is excluded from every verdict and lift above.
- A finding outside the planted set but on the case's `allowed_extras` list counts as **bonus** (a legitimate unique catch), not a false positive.

