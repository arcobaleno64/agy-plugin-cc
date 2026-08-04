# Parity & Usability Re-Score — v0.11.1

> Target: `arcobaleno64/gemini-plugin-cc` **v0.11.1** (commit `bb8be2b`)
> Baseline: the v0.6.1 re-score in [`PARITY_AUDIT_v0.6.1.md`](PARITY_AUDIT_v0.6.1.md)
> Upstream: `openai/codex-plugin-cc` **v1.0.6** — dormant since 2026-07-08 (one commit on the default branch since that release)
> Date: 2026-08-04 ｜ Method: re-read of the v0.11.1 code + 275-test suite + a live `/review` run against a five-defect sample (AGY 1.1.10, Windows 11)
> Same six-axis rubric as the baseline. "Usability" = mean of axes ②–⑥.

---

## Top line

| Dimension | v0.6.0 | v0.6.1 | **v0.11.1** | Δ vs v0.6.1 |
|---|:-:|:-:|:-:|:-:|
| **Fidelity** (①, comparable 13 rows) | 3.9 | 4.0 | **4.0** | = |
| **Fidelity** (including the new `/transfer` row) | — | — | **3.9** | new scope |
| **Usability** (comparable 14 rows) | 4.0 | 4.2 | **4.3** | +0.1 |
| **Usability** (all 15 rows) | — | — | **4.2** | = |

**Read the flat number carefully.** Usability did not stall — it absorbed a large gain and two real losses:

- **+0.8 on engine routing.** v0.11.0 made AGY's native JSON envelope authoritative on 1.1.8+, so the conversation-directory diffing and its "match is not certain" warning no longer run, and no brain root is required.
- **−0.4 on manifests & tooling.** v0.10.0 shipped `/gemini:transfer` as `commands/transfer.json`, a format the Claude Code loader ignores. The command never registered, and no gate caught it — it was found by eye in the `/plugin` UI. Fixed in v0.10.1 with a test that fails on any non-Markdown file in `commands/`.
- **A new row scoring 3.8.** `/transfer` exists now, but its shape is not upstream's (see below).

---

## Re-scored matrix (Δ vs v0.6.1 usability)

| # | Feature | ① | ② | ③ | ④ | ⑤ | ⑥ | Usability | Δ | What moved |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|---|
| 1 | `/setup` | 4 | 4 | 5 | 5 | 5 | 4 | 4.6 | = | unchanged; AGY 1.1.10 ADC/WIF auth documented |
| 2 | `/rescue` | 4 | 5 | 4 | 4 | 4 | 4 | **4.2** | +0.2 | ② 4→5: envelope makes success/failure deterministic; `--disable-slash-commands` stops AGY 1.1.9+ executing a task that starts with `/` |
| 3 | `/review` | 3 | 5 | 5 | 5 | 4 | 4 | **4.6** | +0.2 | ④ 4→5: AGY's `ERROR` envelope reaches the classifier. **Live: 5/5 planted defects caught.** ① still 3 (prompt-based vs upstream native) |
| 4 | `/adversarial-review` | 4 | 5 | 5 | 5 | 4 | 4 | **4.6** | +0.2 | same classifier lift as `/review` |
| 5 | `/status` | 5 | 5 | 4 | 4 | 4 | 4 | 4.2 | = | conversation id now sourced from the envelope, same value |
| 6 | `/result` | 4 | 5 | 4 | 4 | 4 | 4 | 4.2 | = | unchanged |
| 7 | `/cancel` | 4 | 4 | 4 | 4 | 4 | 4 | 4.0 | = | still OS process-tree only; upstream's `turn/interrupt` lives in `app-server-broker.mjs:37` and has no counterpart here |
| 8 | `gemini-rescue` subagent | 4 | 4 | 4 | 3 | 4 | 4 | 3.8 | = | unchanged (still returns empty on failure) |
| 9 | skills (3) | 3 | 4 | 4 | 4 | 4 | 5 | 4.2 | = | unchanged |
| 10 | hooks (lifecycle/stop-gate) | 4 | 4 | 4 | 4 | 4 | 4 | 4.0 | = | unchanged |
| 11 | engine routing | — | 5 | 4 | 5 | 4 | 4 | **4.4** | **+0.8** | native envelope replaces transcript scraping on AGY 1.1.8+; ⑤ 3→4 (no "run `agy` once" prerequisite); ⑥ 3→4 (the macOS-unverified transcript path is now fallback-only) |
| 12 | background job model | 4 | 5 | 4 | 4 | 4 | 4 | 4.2 | = | unchanged |
| 13 | model/effort (model-map) | 4 | 4 | 4 | 5 | 4 | 3 | **4.0** | +0.2 | ④ 4→5: the false "AGY 1.1.5+ supports `--model`/`--effort`" claim is gone (they were silently ignored until 1.1.10). ⑥ still 3 — `model-map.mjs:12` reads `lastVerified: "2026-06"`, two months stale, with 16 preview references |
| 14 | manifests & tooling | 5 | 4 | 5 | 4 | 5 | 5 | **4.6** | **−0.4** | ②④ 5→4: v0.10.0 shipped an unregistered command and no gate caught it. Guard added in v0.10.1; the score should recover once it has survived a few releases |
| 15 | **`/transfer`** (new) | 2 | 4 | 3 | 4 | 4 | 4 | **3.8** | new | see below |

> Row 11 fidelity is `—` (original feature, no upstream counterpart) and excluded from the fidelity mean.

---

## The `/transfer` row is the honest weak spot

Both plugins have the command; they do opposite things.

| | upstream `/codex:transfer` | this plugin `/gemini:transfer` |
|---|---|---|
| Argument hint | `[--source <claude-jsonl>]` | `[--engine …] [--model …] [--effort …] [instructions…]` |
| Mechanism | **imports** the session into a real Codex thread | **exports** a JSON snapshot to `.omc/transfers/` |
| Result | `codex resume <thread-id>` | a launch command whose prompt names a file path |
| Continuity | context is *in* the conversation | context sits *next to* it, and only if the receiving agent opens the file |

This is not an implementation shortfall. AGY has no transcript-import capability, which is exactly what [antigravity-cli#567](https://github.com/google-antigravity/antigravity-cli/issues/567) requests. Everything downstream of an import already works on AGY 1.1.10 — verified this session: `--conversation <id> --output-format json` returns the same `conversation_id` with `num_turns` incrementing. The import step is the only missing link, so ① is capped at 2 until upstream ships it.

---

## Live evidence (this round)

**Environment**: Windows 11, AGY 1.1.10, engine forced with `--engine agy` so the run exercised the new v0.11.0 envelope path.
**Sample**: `src/auth.js` committed in a safe form, then five defects introduced in the working tree — SQL string concatenation, hardcoded JWT secret, removed null check, `==` plaintext password comparison, removed `JSON.parse` try/catch.

`review --wait --scope working-tree` → **5/5 caught** in 21.6 s, `verdict: needs-attention`:

| Planted defect | Reported as |
|---|---|
| SQL string concatenation | `[critical] src/auth.js:5` with a parameterized-query fix |
| Hardcoded JWT secret | `[high] src/auth.js:9` — also flagged the unplanted 365-day expiry |
| Removed null check | folded into `[critical] src/auth.js:13-14` |
| `==` password comparison | `[critical] src/auth.js:13-14` |
| Removed `JSON.parse` try | `[medium] src/auth.js:21` |

Line numbers correct, every finding carries a pasteable fix. One nuance: defects 3 and 4 were merged into a single finding rather than reported separately — complete in content, slightly coarse in granularity.

This also served as the first live end-to-end check of the v0.11.0 refactor on the **review** path (the release itself was verified live only on the task path).

---

## What did NOT change (by design)

- `/review` stays **prompt-based**, not a native reviewer → ① capped at 3.
- `/cancel` still cannot interrupt a model turn. Upstream gets this from a persistent app-server (`app-server-broker.mjs`, 252 lines); this plugin spawns a fresh process per command. Closing it needs AGY daemon mode ([antigravity-cli#749](https://github.com/google-antigravity/antigravity-cli/issues/749)).
- **macOS remains unverified** on every axis. Development is on Windows, CI on Ubuntu.
- AGY results no longer carry a reasoning summary — a deliberate v0.11.0 trade, since neither `json` nor `stream-json` carries thinking text.

---

## Scope and limits of this round

- Live sampling covered the **AGY engine only**. The Gemini engine was not re-run; its consumer tier ended 2026-06-18, so AGY is the realistic default.
- Only `/review` was live-run. Rows 1–2 and 5–15 were re-scored from code, tests, and this session's direct AGY probes, not fresh end-to-end runs.
- Upstream is dormant (v1.0.6, 2026-07-08), so fidelity drift this round comes entirely from changes on this side.
- Single auditor, no independent critic pass — unlike the v0.6.1 round, which used a fan-out plus a regression critic.

---

## Candidates for the next release

1. **Re-verify `model-map`.** `lastVerified: "2026-06"` with 16 preview references is the oldest unexamined claim in the codebase and the only row still scoring 3 on any axis.
2. **Adopt `--json-schema`** (AGY 1.1.8) to replace prompt coercion plus `parse-robustness` fallbacks around `schemas/review-output.schema.json`.
3. **Let the packaging guard mature.** Row 14 recovers to 5.0 on evidence, not on intent — a few releases with no packaging defect.
4. **macOS verification**, the last unaddressed platform, already honestly disclosed in the README.
