# Model vs Harness — what actually drives the gap

> Scope: the models each plugin drives — **Gemini** (this plugin) vs **OpenAI Codex/GPT** (`codex-plugin-cc`).
> Date: 2026-06-02 ｜ Method: live single-shot runs on identical prompt + diff (model isolation), contrasted with each tool's native harness, plus model facts available at that time. Setting the plugin features aside.
> Currentness note: this is a dated snapshot, not a rolling model leaderboard. On 2026-07-06, npm reports `@google/gemini-cli` latest as 0.49.0 and local `agy` 1.0.16 exposes its own model surface, so do not treat the 0.44.1 / AGY 1.0.4 observations below as current global facts.
> Honesty note: proprietary model "strength" is not precisely measurable; vendor pages were partly fetch-blocked (403) so some benchmark numbers come from independent leaderboards / reputable secondary reporting. Treat single-digit gaps as noise-adjacent.

---

## TL;DR

1. **Raw single-shot review quality was close and mixed in this 2026-06-02 snapshot** — all tested models caught the headline bugs; they differed only in the long tail.
2. **Most of the gap people attribute to "model" is actually harness.** Codex's native reviewer is *agentic* (it explores the repo); this plugin's review is *single-shot prompt over a diff*. Give Gemini the same agentic loop and most of the observed difference closes.
3. **The benchmark snapshot was split:** OpenAI led on the multi-step agentic Terminal-Bench numbers available then; Gemini led the competitive/algorithmic LiveCodeBench numbers cited then.
4. **Model availability is a hard local constraint:** the 2026-06-02 gemini CLI 0.44.1 probe returned `404 ModelNotFound` for `gemini-3.5-*`. Newer CLI releases may differ, so availability claims must be re-probed.

---

## A. Controlled single-shot run (model isolated)

Same neutral review prompt, same `auth.js` diff (5 seeded defects), each model once, no agentic exploration (diff embedded in the prompt). Run locally 2026-06-02.

| Model (engine) | Real findings | Unique catch | False positives | Secret severity |
|---|:-:|---|:-:|---|
| **Gemini 3.1 Pro** (`gemini-3.1-pro-preview`) | 4 | — | **0** | critical (well-calibrated) |
| **Gemini 3 Flash** (`gemini-3-flash-preview`) | 4 | — | **1** (hallucinated an "async/await" bug not in the diff) | high |
| **Codex default** (GPT-5.x via `codex exec`) | 4 | **JWT issued without expiry** | **0** | high |

Seeded defects: SQL injection, hardcoded JWT secret, missing null-check, plaintext `==` password compare, unguarded `JSON.parse`.

Observations:
- All three caught the three headline issues (SQLi, hardcoded secret, plaintext password).
- **Codex uniquely flagged "JWT has no `expiresIn`"** — genuine security depth the Gemini models missed.
- **Both Gemini models uniquely flagged the unguarded `JSON.parse`** (crash/DoS path) — Codex missed it.
- **Gemini 3 Flash produced one false positive** (invented an async bug unsupported by the diff); Pro and Codex had none.
- Net: **the single-shot model gap is small and mixed** — different strengths, not a tier difference.

## B. Native harness contrast (model + harness)

From the earlier parity audit, run on the same repo through each tool's *native* path:
- **Codex native review is agentic**: it ran `git`/filesystem commands and additionally caught a **missing `jsonwebtoken` dependency declaration** and an **untracked `.omc/state` file that should not be committed** — issues *outside* the diff.
- **This plugin's review is single-shot over the assembled diff**: it never sees beyond the diff, so it cannot find those repo-context issues.

Crucially, in the single-shot run above **Codex did *not* catch the dependency/untracked-file issues either** — because single-shot it only had the diff, same as Gemini. **Those extra catches were the harness (agentic exploration), not the model.**

→ **Harness, not model, explains most of the observed "Codex finds more."** That deficit is on the plugin side and is improvable (see [PARITY_AUDIT](PARITY_AUDIT.md) and the agentic-review follow-up).

## C. Benchmark context (web-confirmed, mid-2026)

| Benchmark | Leader | Margin | Source (publisher, date) |
|---|---|---|---|
| SWE-bench Verified (independent) | GPT-5.5 82.6% > Gemini 3.1 Pro 78.8% | +3.8 | vals.ai leaderboard |
| Terminal-Bench 2.0 (agentic terminal) | GPT-5.5 82.7% ≫ Gemini 3.1 Pro 68.5% | **+14** | OpenAI (MarkTechPost, 2026-04-23) + Google card |
| LiveCodeBench Pro (competitive/algorithmic) | Gemini 3.1 Pro 2887 Elo > GPT-5.x | **~+200 Elo** | Google DeepMind card, 2026-02-19 |
| SWE-bench Pro | GPT-5.5 58.6% > Gemini 3.1 Pro 54.2% | +4.4 | cross-vendor — treat cautiously |

Reading: the big gap is on **multi-step agentic execution** (Terminal-Bench), which matches finding B — it is a *harness/agency* axis, not single-shot IQ. Gemini leads competitive coding.

## D. Model availability — the local reality (transparency)

Probed on this machine (gemini CLI **0.44.1**, then-current on npm), 2026-06-02:

| Model id | gemini CLI 0.44.1 | Note |
|---|:-:|---|
| `gemini-2.5-flash` / `-pro` / `-flash-lite` | ✅ served | GA, stable |
| `gemini-3-flash-preview` | ✅ served | preview |
| `gemini-3.1-pro-preview` | ✅ served | preview; gemini CLI's configured default |
| `gemini-3.1-flash-lite` | ✅ served | GA |
| **`gemini-3.5-flash`** | ❌ **404 ModelNotFound** | Not served by this CLI version in this probe |
| **`gemini-3.5-pro`** | ❌ **404** | Not served by this CLI version in this probe |

- **AGY (antigravity 1.0.4)** exposed **no `--model`/`--effort`** flag in the original 2026-06-02 probe. By 2026-07-06, local AGY 1.0.16 exposed `--model` and `agy models`.
  **Superseded since — current behavior (verified on AGY 1.1.12, 2026-08-12):** the plugin forwards both. `--effort <low|medium|high>` is passed to AGY natively, and `--model` is passed through as an exact AGY model id from `agy models`. What it still does *not* do is translate Gemini aliases into AGY ids — `flash` and `pro` are Gemini aliases only — and the two flags cannot be combined, because the AGY model ids reject the pairing. See `supportsAgyModelSelection` (gated at 1.1.10, the first version that applies the selection instead of silently falling back to the persisted model).
- **AGY's own model listing, read 2026-09-02 on AGY 1.1.24.** `agy models` returns 14 ids:

  | Family | Ids |
  |---|---|
  | Gemini 3.8 Flash | `gemini-3.8-flash-high` · `-medium` · `-low` |
  | Gemini 3.7 Flash | `gemini-3.7-flash-high` · `-medium` · `-low` |
  | Gemini 3.6 Flash | `gemini-3.6-flash-high` · `-medium` · `-low` |
  | Gemini 3.1 Pro | `gemini-3.1-pro-high` · `-low` |
  | Other vendors | `claude-sonnet-4-6` · `claude-opus-4-6-thinking` · `gpt-oss-120b-medium` |

  Against the 1.1.13 reading below, the 3.8 Flash family is new and the **3.5
  Flash family is gone** — the first removal since this section began recording.
  The count is 14 either way, so a count check would have seen nothing. Nothing
  in the plugin broke, because nothing keeps a roster to break: an id that no
  longer exists is refused by AGY itself, which is the same path any typo takes.

- **AGY's own model listing, read 2026-08-18 on AGY 1.1.13.** `agy models` returns 14 ids:

  | Family | Ids |
  |---|---|
  | Gemini 3.7 Flash | `gemini-3.7-flash-high` · `-medium` · `-low` |
  | Gemini 3.6 Flash | `gemini-3.6-flash-high` · `-medium` · `-low` |
  | Gemini 3.5 Flash | `gemini-3.5-flash-high` · `-medium` · `-low` |
  | Gemini 3.1 Pro | `gemini-3.1-pro-high` · `-low` |
  | Other vendors | `claude-sonnet-4-6` · `claude-opus-4-6-thinking` · `gpt-oss-120b-medium` |

  Against the previous reading (AGY 1.1.10, 2026-08-05, 11 ids) the 3.7 Flash
  family is new and nothing was removed. Note the shape rather than the roster:
  AGY encodes the effort tier into the id, which is why `--model` and `--effort`
  cannot be combined and why no Gemini alias is ever a valid AGY model id.

  There is no machine-readable form to check a copy against — `agy models` on
  1.1.13 accepts only `-h`/`--help`. This plugin's own 0.19.0 changelog entry
  states that AGY 1.1.12 added `--output-format json` to it; that is not true of
  1.1.13, and the entry is left as written because a released changelog is a
  record. `lib/model-map.mjs` no longer keeps a copy of this list and points
  here instead.
- The plugin therefore points `flash` at `gemini-3-flash-preview` (served) and **gracefully degrades** to the GA `gemini-2.5-flash` if a requested id 404s — see the model-not-found fallback in `lib/gemini.mjs`.
- Heads-up: Google's consumer Gemini CLI transition took effect on **2026-06-18** — this is past, not upcoming. On a personal account gemini CLI still installs and answers `--version`, but every request returns `API key not valid` / `API_KEY_INVALID` (verified 2026-08-04); Standard/Enterprise access and API keys are unaffected. See the note at the top of the README.

---

## What this means for the plugin

- **Don't chase raw model parity** — it is close, and the model tier is Google/OpenAI's to move (choose it with `--effort`/`--model`, not code).
- **Do close the harness gap** — giving the Gemini review path agentic repo exploration (opt-in) recovers most of the observed difference. This is the highest-leverage, in-our-control improvement.
- **Be honest about availability** — treat model availability as version-specific and re-probe before making current claims. The runtime keeps graceful fallback when Gemini IDs drift.
