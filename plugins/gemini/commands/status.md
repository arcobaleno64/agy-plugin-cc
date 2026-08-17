---
description: Show active and recent Gemini jobs for this repository, including review-gate status
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" status`

The user's raw arguments, as text and nothing else:
`$ARGUMENTS`

## Those arguments must never reach a shell

The block above already ran, before you saw it, and it ran with **no arguments**
on purpose. `$ARGUMENTS` is substituted into this file as text, so a shell that
received it would evaluate whatever it contains — `$(…)`, backticks, `;`, `|`.
Measured: `/gemini:status $(echo INJECTED)` executed the substitution and passed
`INJECTED` on as the job id.

So when you build a command, assemble it only from these fixed pieces:

- The literal flag `--all`, `--wait`, or `--timeout-ms <n>` — included because
  the argument text asked for it, never copied from it. `<n>` must be a value
  you have checked is entirely digits.
- A job id copied character-for-character out of the companion output above.
  Job ids look like `review-msqu22ju-9c2f32c12b`: lowercase letters, digits and
  hyphens only. If what the user typed is not present in that output, say so
  and stop — do not pass their text through to find out.

Never place the argument text, or any fragment of it, into a command. Never pass
it as a single quoted string.

## Presenting the result

If the user did not name a job:
- Render the output above as a single Markdown table of this session's runs.
- Keep it compact. No progress blocks or extra prose outside the table.
- Preserve the actionable fields: job ID, kind, status, phase, elapsed or
  duration, summary, and follow-up commands.

If the user named a job that appears in the output above:
- Present that job's full entry. Do not summarize or condense it.

If the user asked to wait, or for a job from another session (`--all`), run the
companion again with those literal flags and the verified id, then present the
result the same way.
