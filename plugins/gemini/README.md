# Gemini Companion for Claude Code

Run **Gemini CLI** or **Antigravity CLI (`agy`)** from inside Claude Code: delegate a task to it, or have it review your diff.

> **Independent project.** Community-maintained, and **not affiliated with, endorsed by, or sponsored by Google LLC or Anthropic**. "Gemini" and "Antigravity" are trademarks of Google LLC and "Claude" is a trademark of Anthropic; all are used here only to name the tools this plugin works with.

Full documentation, comparison tables, and measurements: **[repository README](https://github.com/arcobaleno64/gemini-plugin-cc#readme)**.

---

## Install

```
/plugin marketplace add arcobaleno64/gemini-plugin-cc
/plugin install gemini@gemini-plugin-cc
/reload-plugins
```

**You must supply the engine yourself.** The plugin ships no model access and no credentials of its own.

| Requirement | Notes |
|---|---|
| Node.js ≥ 18 | No dependencies; standard library only. |
| **One of** Gemini CLI ≥ 0.40 **or** AGY ≥ 1.0.3 | AGY ≥ 1.1.2 recommended. |
| Authentication | Run `gemini` or `agy` once interactively. Each engine authenticates independently. |

Gemini CLI needs a Standard/Enterprise account or an API key — Google ended consumer access on 2026-06-18. **AGY is the practical default.**

Verify with `/gemini:setup`.

---

## Three things it does

**Review the change you are about to commit**

```
/gemini:review --wait
```

Sends `git status` and your diff to the engine and returns findings. Add `--deep` to let it read beyond the diff.

**Argue with a design decision**

```
/gemini:adversarial-review --wait the retry logic in the queue worker
```

Same input, adversarial prompt: it challenges the approach rather than hunting bugs. Findings come back with severity ratings.

**Hand off a long investigation**

```
/gemini:rescue --background why does the integration suite hang on Windows only
```

Runs detached; collect it later with `/gemini:status` and `/gemini:result`.

All commands: `review`, `adversarial-review`, `rescue`, `transfer`, `setup`, `status`, `result`, `cancel`. Each carries its own `argument-hint`; type `/gemini:` to see them.

---

## What it sends, and where

The plugin **operates no service of its own** — no HTTP requests, no telemetry, no analytics, no update check, no third-party dependency.

Data leaves your machine on exactly one path: the plugin spawns **the Gemini CLI or AGY binary you installed**, and that binary sends the prompt to Google. What happens next is governed by Google's terms for your plan tier.

| Command | What is assembled | Redaction |
|---|---|---|
| `review`, `adversarial-review` | `git status`, diffs, untracked file contents | Secret-looking files withheld by filename; 400,000-character cap |
| `rescue` | Your instruction text only | — |
| `transfer` | `git status -s` and a per-file diff | Secret-looking files withheld; 25,000-character cap |

**Two limits stated plainly.** Redaction is by *filename* — a credential pasted into ordinary source is not caught. And the engine is agentic: once running, it can read files on its own initiative that no rule here ever saw. Neither CLI offers a path boundary the plugin could impose.

Full detail, every claim cited to its source file: **[PRIVACY.md](https://github.com/arcobaleno64/gemini-plugin-cc/blob/main/PRIVACY.md)** · **[THREAT-MODEL.md](https://github.com/arcobaleno64/gemini-plugin-cc/blob/main/docs/THREAT-MODEL.md)**.

---

## Permissions and hooks

The plugin spawns child processes (`git`, and the engine CLI you installed) and writes job state under Claude Code's plugin data directory. It installs three hooks:

| Hook | What it does | Default |
|---|---|---|
| `SessionStart` | Exports `GEMINI_COMPANION_SESSION_ID` so jobs can be attributed to a session. | Always on |
| `SessionEnd` | Terminates **this session's** still-running background jobs and removes their records. Other sessions' jobs are untouched. | Always on |
| `Stop` | Optional review gate: runs an adversarial review before the session ends, and can block the stop. | **Off** |

The Stop gate is the only thing that reaches the engine without a command you typed, and it is **off unless you turn it on** (`/gemini:setup --enable-review-gate`). It fires only after a `--write` task has completed in that workspace, and it fails **open** — if the review cannot run, the stop proceeds with a visible notice rather than trapping you.

Nothing here reads `~/.claude/`, `CLAUDE.md`, your conversation history, or files you uploaded to Claude.

---

## Support

- **Issues and questions**: <https://github.com/arcobaleno64/gemini-plugin-cc/issues>
- **Security reports**: [GitHub Security Advisories](https://github.com/arcobaleno64/gemini-plugin-cc/security/advisories/new), or <arcobaleno830623@gmail.com>. See [SECURITY.md](https://github.com/arcobaleno64/gemini-plugin-cc/blob/main/SECURITY.md) — read the threat model first, as the highest-rated item there is known and documented rather than undisclosed.
- **A claim in PRIVACY.md the code does not support** is a documentation defect worth reporting as one.

Licensed MIT. Derived from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0) — see [NOTICE](https://github.com/arcobaleno64/gemini-plugin-cc/blob/main/NOTICE).
