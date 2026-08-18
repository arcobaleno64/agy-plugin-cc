---
description: Cancel an active background Gemini job in this repository
argument-hint: '[job-id | group-id] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" status`

The user's raw arguments, as text and nothing else:
`$ARGUMENTS`

## Those arguments must never reach a shell

The listing above ran before you saw it, with **no arguments**, on purpose.
`$ARGUMENTS` is substituted into this file as text, so a shell receiving it would
evaluate whatever it contains — `$(…)`, backticks, `;`, `|`. Measured on the
sibling command: `$(echo INJECTED)` was executed and its output passed on as the
job id.

Cancelling ends work that is running and may have already been paid for, so the
id has to be right for a second reason. Build the command from these pieces only:

- `cancel` plus a job id copied character-for-character from the listing above,
  and only from a job whose status is `queued` or `running`.
- Or an adversarial-review group id, copied the same way, which cancels every
  member of that group that is still active and leaves finished members alone.
  Group ids look like `review-group-msqu22ju`; `/gemini:status <group-id>` lists
  the members.
- The literal flag `--all`, added only because the argument text asked to cancel
  a job from another session — never copied from that text.

If the user named nothing and exactly one job is active in the listing, cancel
that one. If several are active, show them and ask which — do not guess.

If the user named something that does not appear in the listing, say so and
stop. Do not pass their text to the companion to find out.

## Scope

By default `cancel` targets only jobs from the current Claude session — never a
job tagged to another session, including via the no-argument "cancel the one
active job" shortcut. When no session id is present (running the companion
outside Claude Code), only session-agnostic untagged jobs are in scope. `--all`
is what deliberately crosses that boundary.

Present the companion's output as returned.
