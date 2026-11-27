# Parity with codex-plugin-cc

繁體中文版：[`parity.zh-TW.md`](parity.zh-TW.md)

This plugin is a high-fidelity port of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc). The public slash-command surface, background job model, and state/result/status/cancel flow mirror the upstream; the execution backends are the first-class Gemini CLI and AGY engines rather than the Codex app server.

This file describes the **current** state. Point-in-time audits, kept because they answer *when* a behaviour changed, live alongside it: [`PARITY_AUDIT.md`](PARITY_AUDIT.md) (v0.6.0 baseline, with the v0.6.1 remediation table) and [`PARITY_AUDIT_v0.11.1.md`](PARITY_AUDIT_v0.11.1.md) (2026-08-04, against upstream v1.0.6).

## Compatibility Matrix

| Upstream (Codex) | This plugin (Gemini) | Parity |
|---|---|---|
| `/codex:setup` | `/gemini:setup` | **Gemini-specific divergence** — checks Gemini OAuth or AGY binary readiness for the selected first-class engine instead of Codex auth |
| `/codex:review` | `/gemini:review` | **best-effort equivalent** — prompt / CLI-adapter review, not a native reviewer |
| `/codex:adversarial-review` | `/gemini:adversarial-review` | **best-effort equivalent** — adversarial prompt over the same diff target |
| `/codex:rescue` | `/gemini:rescue` | **intentional divergence** — same delegation surface, but this plugin defaults to read-only intent; upstream defaults to a sandbox-confined write-capable run |
| `/codex:transfer` | `/gemini:transfer` | **1:1 parity** — exports session snapshot and generates AGY / Gemini CLI handoff launch commands |
| `/codex:status` | `/gemini:status` | **1:1 parity** — same job model; `--all` crosses Claude sessions |
| `/codex:result` | `/gemini:result` | **engine-specific divergence** — prints a Gemini session id + `gemini --resume`, or an AGY conversation id + `agy --conversation` |
| `/codex:cancel` | `/gemini:cancel` | **1:1 parity** — same process-tree termination (POSIX + Windows) |

Upstream has no equivalent of this plugin's MCP server; see [MCP Tools](../README.md#mcp-tools) for what that surface exposes and what it deliberately omits.

## Codex app server vs Gemini CLI adapter

- **Runtime**: Codex uses a persistent app-server with native review and persistent threads. This plugin invokes the selected first-class Gemini CLI or AGY engine directly *per command* (no shared runtime); `auto` uses capability-based Gemini→AGY ordering.
- **Standard review**: In the Codex plugin, `/codex:review` is a *native* reviewer. Here, `/gemini:review` is a **prompt-based / CLI-adapter equivalent** — it sends the diff to Gemini with a pragmatic-review prompt and parses structured JSON back. It is not a native Gemini reviewer.
- **Sandbox**: Codex exposes `read-only` / `workspace-write` sandboxes and confines a write-capable run to the workspace. **Neither Gemini CLI nor AGY offers an equivalent path-confined write sandbox this plugin can rely on across all supported versions.** AGY's `--sandbox` restricts what terminal commands reach rather than where file tools write (measured on 1.1.10 and 1.5.16), and Gemini CLI's `--sandbox` requires Docker or Podman. On Gemini CLI `--write` gates `--yolo` (without it no write/shell tools exist). Across all supported AGY versions, non-`--deep` diff reviews run in an isolated empty temp `cwd`; when `agy --help` advertises `--settings` (verified on 1.5.16), they also inject `review-diff` (`read_file(*)`, writes, commands, MCP, URLs denied). `--deep` reviews and `task`/`rescue` turns fail closed pre-spawn if cwd/Git-root verification fails or untrusted `.agents`/`.agent`/`_agents`/`_agent` `hooks.json`, `mcp_config.json`, `plugins.json`, or `plugins` exist within max 64 hops (native CLI offers strict boolean `--allow-repo-hooks`; MCP omits it). Fresh `--write` turns use `--new-project`, read-only `--deep`/task turns use `--add-dir`, and resumed turns pass `--conversation <id>` (gating unverified `--write` resumes and checking post-turn `init.cwd`); `--settings` layers `read-only` or `write` (file-tool `.git`/bounded secret rules up to 5,000 entries / depth 6 while keeping `command` active). Older AGY builds down to 1.1.12 omit `--settings`, and `readonly-guard.mjs` still compares the repository before and after every read-only turn. See [`THREAT-MODEL.md`](THREAT-MODEL.md) §7.2. Neither engine's plan mode is used: gemini's `--approval-mode plan` re-declares write tools, and AGY's `--mode plan` is disabled whenever `--disable-slash-commands` is passed (measured on 1.1.13 and 1.5.16).
- **Thread/session resume**: Codex persists threads on the app server. Here, the selected engine's thread id is captured from its output or legacy transcript; `/gemini:result` prints the engine-specific resume command, and `--resume-last` continues the latest thread *for the current Claude session*. On AGY the conversation id is pinned with `--conversation`; on gemini it cannot be pinned, because `--resume` accepts only `latest` or an index, so the landing is compared against the tracked session id and a mismatch is reported.
