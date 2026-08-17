---
description: Export the current workspace context into a transfer snapshot and generate ready-to-run AGY / Gemini CLI handoff commands
argument-hint: '[--engine <gemini|agy|auto>] [--model <id>] [--effort <low|medium|high|xhigh>] [instructions...]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Write
---

The user's raw arguments, as text and nothing else:
`$ARGUMENTS`

## Those arguments must never reach a shell

This command deliberately does **not** pre-execute anything. `$ARGUMENTS` is
substituted into this file as text, so a shell receiving it would evaluate
whatever it contains — `$(…)`, backticks, `;`, `|`. Measured on the sibling job
commands: `$(echo INJECTED)` was executed before Node ever started.

Instructions here are free text, so there is no safe way to quote them into a
command line. Write them to a file instead:

1. Read the argument text above and separate it into two parts: the recognised
   flags, and everything else, which is the instruction text.
2. Use the **Write** tool — not a shell — to put the instruction text in a file.
   A path under the system temp directory is fine; do not build the path from
   the user's text.
3. Run the transfer, assembling the command from fixed pieces only:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/transfer.mjs" --instructions-file <the path you just wrote> [--engine <value>] [--model <value>] [--effort <value>]
```

The only flags you may pass are `--engine`, `--model` and `--effort`, and their
values must be ones you checked against the sets below — chosen from the list,
never copied from the argument text:

- `--engine`: `auto`, `gemini`, `agy`
- `--effort`: `low`, `medium`, `high`, `xhigh`
- `--model`: an alias (`flash`, `pro`, `lite`, …) or a model id, which must
  match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. If it does not, stop and say so.

If there are no instructions, omit `--instructions-file` entirely.

## Presenting the result

Present the command output to the user exactly as returned. Preserve:
- The snapshot path under `.omc/transfers/`
- Every generated launch command verbatim, including its quoting — the prompt is
  already shell-escaped for the target shell, and rewriting or reflowing it
  breaks the handoff
- Both the Bash/Zsh and PowerShell variants whenever both are printed

Do not run the generated commands. They are for the user to paste into an
interactive terminal.

If the command reports a failure, relay the error verbatim and stop. The
expected failures are a clean working tree with no instructions, a git
repository in conflict state (`MERGE_HEAD`, `REBASE_HEAD`, `CHERRY_PICK_HEAD`),
an unknown `--engine` value, `--model` combined with `--effort` (AGY 1.1.5+
treats them as mutually exclusive), and an unreadable `--instructions-file`.
