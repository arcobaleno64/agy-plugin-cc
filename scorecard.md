# review benchmark scorecard — agy · gemini · codex

> Mode: **replay** · repeats: 1 · cases: 5 · generated: 2026-08-19T12:24:38.903Z

## Verdicts

| Axis | Winner | Detail |
|---|---|---|
| **Model** (single-shot, tools off) | **tie** | lead of 6.4 does not clear the ±65 either cell moves between runs · gemini 75.4 ±55 · agy 69 ±65 · codex 52 ±45 |
| **Harness** (agentic reviewers) | **tie** | lead of 4 does not clear the ±41 either cell moves between runs · codex 93 (seeded) · agy 79.2 ±24 · gemini 75.2 ±41 |
| Harness lift — gemini | -0.2 | does not clear the ±55 its ends move between runs |
| Harness lift — codex | +41 | one end is seeded — not a measurement |
| Harness lift — agy | +10.2 | does not clear the ±65 its ends move between runs |

## Per-cell aggregate

| Cell | Source | Cases | Composite | Spread | Recall | Precision | FP | Bonus | Sev-exact | Latency |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Gemini (model, single-shot) | live 2026-08-19 · 0.55.1 ×3 | 5 | 75.4 | ±55 | 0.73 | 0.92 | 1 | 0 | 0.56 | 24866ms |
| Codex (model, single-shot) | live 2026-08-19 · codex-cli 0.147.0 ×3 | 2 | 52 | ±45 | 0.52 | 0.59 | 1.67 | 0.33 | 0.4 | 18414ms |
| AGY (model, single-shot) | live 2026-08-19 · 1.1.15 ×3 | 5 | 69 | ±65 | 0.64 | 0.92 | 0.66 | 0 | 0.57 | 23672ms |
| Gemini (--deep, agentic) | live 2026-08-19 · 0.55.1 ×3 | 5 | 75.2 | ±41 | 0.74 | 0.85 | 2.66 | 0.33 | 0.63 | 34398ms |
| Codex (native review, agentic) | **seeded** | 2 | 93 | — | 0.9 | 1 | 0 | 1 | 1 | 39850ms |
| AGY (--deep, agentic) | live 2026-08-19 · 1.1.15 ×3 | 5 | 79.2 | ±24 | 0.81 | 0.89 | 2 | 0 | 0.45 | 28125ms |

## Per-case breakdown

| Case | Cell | Status | Composite | Recall | FP | Bonus | Missed |
|---|---|:-:|:-:|:-:|:-:|:-:|---|
| async-lifecycle | gemini.model | ok | 75 | 0.73 | 0.33 | 0 | unbounded-map |
| async-lifecycle | codex.model | skipped (no cassette) | — | — | — | — | — |
| async-lifecycle | agy.model | ok | 72 | 0.67 | 0.33 | 0 | floating-promise |
| async-lifecycle | gemini.deep | ok | 78 | 0.73 | 0.33 | 0 | floating-promise, unbounded-map |
| async-lifecycle | codex.native | skipped (no cassette) | — | — | — | — | — |
| async-lifecycle | agy.deep | ok | 75 | 0.73 | 0 | 0 | unbounded-map |
| auth-basic | gemini.model | ok | 88 | 0.93 | 0 | 0 | plaintext-compare |
| auth-basic | codex.model | ok | 89 | 0.87 | 0 | 0.33 | — |
| auth-basic | agy.model | ok | 85 | 0.87 | 0 | 0 | plaintext-compare |
| auth-basic | gemini.deep | ok | 85 | 0.87 | 0.33 | 0 | null-check |
| auth-basic | codex.native | ok | 86 | 0.8 | 0 | 1 | json-parse |
| auth-basic | agy.deep | ok | 84 | 0.87 | 0.67 | 0 | — |
| path-and-input | gemini.model | ok | 75 | 0.67 | 0 | 0 | unbounded-read |
| path-and-input | codex.model | skipped (no cassette) | — | — | — | — | — |
| path-and-input | agy.model | ok | 69 | 0.6 | 0 | 0 | unbounded-read, unhandled-enoent |
| path-and-input | gemini.deep | ok | 69 | 0.6 | 0 | 0 | unbounded-read, unhandled-enoent |
| path-and-input | codex.native | skipped (no cassette) | — | — | — | — | — |
| path-and-input | agy.deep | ok | 64 | 0.53 | 0 | 0 | unbounded-read, unhandled-enoent |
| repo-context | gemini.model | ok | 67 | 0.67 | 0.67 | 0 | — |
| repo-context | codex.model | ok | 15 | 0.17 | 1.67 | 0 | missing-dependency, committed-state |
| repo-context | agy.model | ok | 43 | 0.33 | 0.33 | 0 | committed-state |
| repo-context | gemini.deep | ok | 86 | 1 | 1 | 0 | — |
| repo-context | codex.native | ok | 100 | 1 | 0 | 0 | — |
| repo-context | agy.deep | ok | 86 | 1 | 1 | 0 | — |
| vacuous-tests | gemini.model | ok | 72 | 0.67 | 0 | 0 | no-assertion, permanent-skip |
| vacuous-tests | codex.model | skipped (no cassette) | — | — | — | — | — |
| vacuous-tests | agy.model | ok | 76 | 0.75 | 0 | 0 | permanent-skip |
| vacuous-tests | gemini.deep | ok | 58 | 0.5 | 1 | 0.33 | no-assertion, permanent-skip |
| vacuous-tests | codex.native | skipped (no cassette) | — | — | — | — | — |
| vacuous-tests | agy.deep | ok | 87 | 0.92 | 0.33 | 0 | — |

## Caveats

- The **model axis** isolates raw single-shot quality (diff embedded, tools forbidden); the **harness axis** is each tool's repo-exploring reviewer. Most real-world gap lives on the harness axis — see `docs/MODEL_COMPARISON.md`.
- Composite = `recall*70 + precision*20 + severityExact*10` (0–100); it is a summary, not a verdict — read the columns.
- In `--live` mode model output is non-deterministic; treat single-digit composite gaps as noise. Use `--repeats N` to average.
- **Spread** is the widest gap between repeats of the same recording, on the least stable case. It is the noise band: a verdict is only named when the lead is wider than it. A cell recorded once has no spread and cannot win or lose an axis — `—` there means unknown, not stable.
- A cell marked **seeded** was never run: its cassette is an illustration kept so the table has a shape, and it is excluded from every verdict and lift above.
- A finding outside the planted set but on the case's `allowed_extras` list counts as **bonus** (a legitimate unique catch), not a false positive.

