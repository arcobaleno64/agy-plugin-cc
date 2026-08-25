# review benchmark scorecard — agy · gemini · codex

> Mode: **replay** · repeats: 1 · cases: 7 · generated: 2026-08-25T00:25:06.062Z

## Verdicts

| Axis | Winner | Detail |
|---|---|---|
| **Model** (single-shot, tools off) | **tie** | lead of 8.2 does not clear the ±65 either cell moves between runs · gemini 69.2 ±55 · agy 61 ±65 · codex 51.6 ±20 |
| **Harness** (agentic reviewers) | **tie** | lead of 2.2 does not clear the ±43 either cell moves between runs · codex 93 (seeded) · agy 75.4 ±40 · gemini 73.2 ±43 |
| **Adversarial** (agentic, adversarial prompt) | **tie** | lead of 15.7 does not clear the ±65 either cell moves between runs · agy 73 ±46 · codex 57.3 ±65 |
| Harness lift — gemini | +4 | does not clear the ±55 its ends move between runs |
| Harness lift — codex | +41.4 | one end is seeded — not a measurement |
| Harness lift — agy | +14.4 | does not clear the ±65 its ends move between runs |

## Per-cell aggregate

| Cell | Source | Cases | Composite | Spread | Recall | Precision | FP | Bonus | Sev-exact | Latency |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Gemini (model, single-shot) | live 2026-08-24 · 0.56.0 ×3 | 5 | 69.2 | ±55 | 0.68 | 0.83 | 1.67 | 0 | 0.52 | 25964ms |
| Codex (model, single-shot) | live 2026-08-24 · codex-cli 0.149.0 ×3 | 7 | 51.6 | ±20 | 0.47 | 0.71 | 1.33 | 0.33 | 0.45 | 21867ms |
| AGY (model, single-shot) | live 2026-08-24 · 1.1.19 ×3 | 7 | 61 | ±65 | 0.58 | 0.74 | 1 | 0 | 0.59 | 37990ms |
| Gemini (--deep, agentic) | live 2026-08-24 · 0.56.0 ×3 · 1 case on 0.55.1 | 5 | 73.2 | ±43 | 0.72 | 0.85 | 2.33 | 0 | 0.55 | 36868ms |
| Codex (native review, agentic) | **seeded** | 2 | 93 | — | 0.9 | 1 | 0 | 1 | 1 | 39850ms |
| AGY (--deep, agentic) | live 2026-08-24 · 1.1.19 ×3 | 7 | 75.4 | ±40 | 0.76 | 0.92 | 2 | 0 | 0.4 | 34344ms |
| Gemini (plugin review, no --deep) | — | 0 | — | — | — | — | 0 | 0 | — | — |
| AGY (plugin review, no --deep) | live 2026-08-24 · 1.1.19 ×3 | 7 | 47.7 | ±55 | 0.46 | 0.63 | 1.33 | 0 | 0.27 | 20665ms |
| Gemini (adversarial, agentic) | — | 0 | — | — | — | — | 0 | 0 | — | — |
| Codex (adversarial, agentic) | live 2026-08-24 · codex-cli 0.149.0 ×3 | 7 | 57.3 | ±65 | 0.52 | 0.81 | 3 | 0 | 0.48 | 35043ms |
| AGY (adversarial, agentic) | live 2026-08-24 · 1.1.19 ×3 | 5 | 73 | ±46 | 0.72 | 0.87 | 2 | 0 | 0.5 | 42867ms |

## Per-case breakdown

| Case | Cell | Status | Composite | Recall | FP | Bonus | Missed |
|---|---|:-:|:-:|:-:|:-:|:-:|---|
| async-lifecycle | gemini.model | ok | 82 | 0.8 | 0 | 0 | unbounded-map |
| async-lifecycle | codex.model | ok | 78 | 0.73 | 0 | 0 | floating-promise |
| async-lifecycle | agy.model | ok | 91 | 0.93 | 0 | 0 | floating-promise |
| async-lifecycle | gemini.deep | ok | 72 | 0.67 | 0.33 | 0 | unbounded-map |
| async-lifecycle | codex.native | skipped (no cassette) | — | — | — | — | — |
| async-lifecycle | agy.deep | ok | 71 | 0.67 | 0 | 0 | floating-promise, unbounded-map |
| async-lifecycle | gemini.shallow | skipped (no cassette) | — | — | — | — | — |
| async-lifecycle | agy.shallow | ok | 69 | 0.67 | 0.33 | 0 | unbounded-map |
| async-lifecycle | gemini.adversarial | skipped (no cassette) | — | — | — | — | — |
| async-lifecycle | codex.adversarial | ok | 79 | 0.8 | 0 | 0 | unbounded-interval |
| async-lifecycle | agy.adversarial | ok | 83 | 0.8 | 0 | 0 | unbounded-map |
| auth-basic | gemini.model | ok | 88 | 0.93 | 0 | 0 | null-check |
| auth-basic | codex.model | ok | 81 | 0.73 | 0 | 0.33 | json-parse |
| auth-basic | agy.model | ok | 95 | 1 | 0 | 0 | — |
| auth-basic | gemini.deep | ok | 86 | 0.87 | 0 | 0 | — |
| auth-basic | codex.native | ok | 86 | 0.8 | 0 | 1 | json-parse |
| auth-basic | agy.deep | ok | 83 | 0.87 | 0.67 | 0 | — |
| auth-basic | gemini.shallow | skipped (no cassette) | — | — | — | — | — |
| auth-basic | agy.shallow | ok | 81 | 0.8 | 0 | 0 | plaintext-compare |
| auth-basic | gemini.adversarial | skipped (no cassette) | — | — | — | — | — |
| auth-basic | codex.adversarial | ok | 73 | 0.67 | 0 | 0 | null-check, json-parse |
| auth-basic | agy.adversarial | ok | 75 | 0.73 | 0.33 | 0 | plaintext-compare |
| caller-contract | gemini.model | skipped (no cassette) | — | — | — | — | — |
| caller-contract | codex.model | ok | 0 | 0 | 0 | 0 | profile-caller-broken, admin-check-always-passes |
| caller-contract | agy.model | ok | 0 | 0 | 0 | 0 | profile-caller-broken, admin-check-always-passes |
| caller-contract | gemini.deep | skipped (no cassette) | — | — | — | — | — |
| caller-contract | codex.native | skipped (no cassette) | — | — | — | — | — |
| caller-contract | agy.deep | ok | 68 | 0.67 | 0 | 0 | admin-check-always-passes |
| caller-contract | gemini.shallow | skipped (no cassette) | — | — | — | — | — |
| caller-contract | agy.shallow | ok | 0 | 0 | 0 | 0 | profile-caller-broken, admin-check-always-passes |
| caller-contract | gemini.adversarial | skipped (no cassette) | — | — | — | — | — |
| caller-contract | codex.adversarial | ok | 43 | 0.33 | 0.33 | 0 | admin-check-always-passes |
| caller-contract | agy.adversarial | skipped (no cassette) | — | — | — | — | — |
| path-and-input | gemini.model | ok | 80 | 0.73 | 0 | 0 | unbounded-read, unhandled-enoent |
| path-and-input | codex.model | ok | 58 | 0.47 | 0 | 0 | parseint-radix, unbounded-read, unhandled-enoent |
| path-and-input | agy.model | ok | 72 | 0.6 | 0 | 0 | unbounded-read, unhandled-enoent |
| path-and-input | gemini.deep | ok | 72 | 0.67 | 0 | 0 | unbounded-read, unhandled-enoent |
| path-and-input | codex.native | skipped (no cassette) | — | — | — | — | — |
| path-and-input | agy.deep | ok | 69 | 0.6 | 0 | 0 | unbounded-read, unhandled-enoent |
| path-and-input | gemini.shallow | skipped (no cassette) | — | — | — | — | — |
| path-and-input | agy.shallow | ok | 69 | 0.6 | 0 | 0 | unbounded-read, unhandled-enoent |
| path-and-input | gemini.adversarial | skipped (no cassette) | — | — | — | — | — |
| path-and-input | codex.adversarial | ok | 53 | 0.4 | 0 | 0 | parseint-radix, unbounded-read, unhandled-enoent |
| path-and-input | agy.adversarial | ok | 53 | 0.4 | 0 | 0 | parseint-radix, unbounded-read, unhandled-enoent |
| repo-context | gemini.model | ok | 18 | 0.17 | 1.67 | 0 | missing-dependency, committed-state |
| repo-context | codex.model | ok | 0 | 0 | 1.33 | 0 | missing-dependency, committed-state |
| repo-context | agy.model | ok | 55 | 0.5 | 1 | 0 | missing-dependency |
| repo-context | gemini.deep | ok | 72 | 0.83 | 1 | 0 | committed-state |
| repo-context | codex.native | ok | 100 | 1 | 0 | 0 | — |
| repo-context | agy.deep | ok | 76 | 0.83 | 1.33 | 0 | committed-state |
| repo-context | gemini.shallow | skipped (no cassette) | — | — | — | — | — |
| repo-context | agy.shallow | ok | 15 | 0.17 | 1 | 0 | missing-dependency |
| repo-context | gemini.adversarial | skipped (no cassette) | — | — | — | — | — |
| repo-context | codex.adversarial | ok | 0 | 0 | 2.67 | 0 | missing-dependency, committed-state |
| repo-context | agy.adversarial | ok | 57 | 0.67 | 1.67 | 0 | committed-state |
| stale-duplicate | gemini.model | skipped (no cassette) | — | — | — | — | — |
| stale-duplicate | codex.model | ok | 62 | 0.5 | 0 | 0 | v1-copy-still-crashes |
| stale-duplicate | agy.model | ok | 43 | 0.33 | 0 | 0 | v1-copy-still-crashes |
| stale-duplicate | gemini.deep | skipped (no cassette) | — | — | — | — | — |
| stale-duplicate | codex.native | skipped (no cassette) | — | — | — | — | — |
| stale-duplicate | agy.deep | ok | 67 | 0.67 | 0 | 0 | v1-copy-still-crashes |
| stale-duplicate | gemini.shallow | skipped (no cassette) | — | — | — | — | — |
| stale-duplicate | agy.shallow | ok | 18 | 0.17 | 0 | 0 | v1-copy-still-crashes |
| stale-duplicate | gemini.adversarial | skipped (no cassette) | — | — | — | — | — |
| stale-duplicate | codex.adversarial | ok | 65 | 0.5 | 0 | 0 | v1-copy-still-crashes |
| stale-duplicate | agy.adversarial | skipped (no cassette) | — | — | — | — | — |
| vacuous-tests | gemini.model | ok | 78 | 0.75 | 0 | 0 | permanent-skip |
| vacuous-tests | codex.model | ok | 82 | 0.83 | 0 | 0 | permanent-skip |
| vacuous-tests | agy.model | ok | 71 | 0.67 | 0 | 0 | no-assertion, permanent-skip |
| vacuous-tests | gemini.deep | ok | 64 | 0.58 | 1 | 0 | no-assertion, permanent-skip |
| vacuous-tests | codex.native | skipped (no cassette) | — | — | — | — | — |
| vacuous-tests | agy.deep | ok | 94 | 1 | 0 | 0 | — |
| vacuous-tests | gemini.shallow | skipped (no cassette) | — | — | — | — | — |
| vacuous-tests | agy.shallow | ok | 82 | 0.83 | 0 | 0 | permanent-skip |
| vacuous-tests | gemini.adversarial | skipped (no cassette) | — | — | — | — | — |
| vacuous-tests | codex.adversarial | ok | 88 | 0.92 | 0 | 0 | — |
| vacuous-tests | agy.adversarial | ok | 97 | 1 | 0 | 0 | — |

## Caveats

- The **model axis** isolates raw single-shot quality (diff embedded, tools forbidden); the **harness axis** is each tool's repo-exploring reviewer. Most real-world gap lives on the harness axis — see `docs/MODEL_COMPARISON.md`.
- Composite = `recall*70 + precision*20 + severityExact*10` (0–100); it is a summary, not a verdict — read the columns.
- In `--live` mode model output is non-deterministic; treat single-digit composite gaps as noise. Use `--repeats N` to average.
- **Spread** is the widest gap between repeats of the same recording, on the least stable case. It is the noise band: a verdict is only named when the lead is wider than it. A cell recorded once has no spread and cannot win or lose an axis — `—` there means unknown, not stable.
- A cell marked **seeded** was never run: its cassette is an illustration kept so the table has a shape, and it is excluded from every verdict and lift above.
- A finding outside the planted set but on the case's `allowed_extras` list counts as **bonus** (a legitimate unique catch), not a false positive.

