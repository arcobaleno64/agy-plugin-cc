---
description: Export the current workspace context into a transfer snapshot and generate ready-to-run AGY / Gemini CLI handoff commands
argument-hint: '[--engine <gemini|agy|auto>] [--model <id>] [--effort <low|medium|high|xhigh>] [instructions...]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/transfer.mjs" "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve:
- The snapshot path under `.omc/transfers/`
- Every generated launch command verbatim, including its quoting — the prompt is already shell-escaped for the target shell, and rewriting or reflowing it breaks the handoff
- Both the Bash/Zsh and PowerShell variants whenever both are printed

Do not run the generated commands. They are for the user to paste into an interactive terminal.

If the command reports a failure, relay the error verbatim and stop. The expected failures are a clean working tree with no instructions, a git repository in conflict state (`MERGE_HEAD`, `REBASE_HEAD`, `CHERRY_PICK_HEAD`), an unknown `--engine` value, and `--model` combined with `--effort` (AGY 1.1.5+ treats them as mutually exclusive).
