---
name: gemini-cli-runtime
description: Internal helper contract for calling the gemini-companion runtime from Claude Code
user-invocable: false
---

# Gemini Runtime

Use this skill only inside the `gemini:gemini-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task "<raw arguments>"`

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled CLI strings, git operations, or any other Bash activity.
- Do not call `adversarial-review`, `status`, `result`, or `cancel` from `gemini:gemini-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gemini-prompting` skill to rewrite the user's request into a tighter prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- Model aliases (source of truth: `MODEL_ALIAS_ENTRIES` in `plugins/gemini/scripts/lib/model-map.mjs`): `flash` / `flash3` → `gemini-3-flash-preview`, `pro` / `pro3` → `gemini-3.1-pro-preview`, `lite3` → `gemini-3.1-flash-lite`, `flash25` → `gemini-2.5-flash`, `pro25` → `gemini-2.5-pro`, `lite` / `fast` → `gemini-2.5-flash-lite`.
- Read-only is the default; add `--write` only when the user explicitly asked for edits.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`.
- If the forwarded request includes `--model`, normalize aliases and pass it through.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--timeout <seconds>`, pass it through to `task`. Whole seconds, 30 to 3600. It bounds both the run's duration and the amount of output it can emit before being killed.
- `--effort` accepted values: Gemini engine accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; AGY engine accepts only `low`, `medium`, `high`.
- `--resume`: add `--resume-last`, even if the request text is ambiguous.
- `--fresh`: use a fresh `task` run, do not add `--resume-last`.
- `task --resume-last`: for "keep going", "resume", "apply the top fix", or "dig deeper".

Engine routing:
- Gemini CLI and AGY are both first-class supported engines; only the selected
  engine's CLI is required.
- Default engine: credential-gated auto-detection (selects Gemini if installed
  and authenticated with valid credentials, otherwise AGY).
- Force AGY: add `--engine agy`.
- Force Gemini CLI: add `--engine gemini`.
- Note for AGY engine: `--model` takes an exact model ID from `agy models` or `--effort` accepts `low`, `medium`, or `high`; the two cannot be combined, and Gemini model aliases are rejected for AGY.

Safety rules:
- Read-only is the default in `gemini:gemini-rescue`; add `--write` only when the user explicitly asked for edits.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or the engine cannot be invoked, return nothing.
