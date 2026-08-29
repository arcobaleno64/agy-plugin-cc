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
- **Sandbox**: Codex exposes `read-only` / `workspace-write` sandboxes and confines a write-capable run to the workspace. **Neither Gemini CLI nor AGY offers an equivalent path boundary this plugin can impose**, so it has none. AGY's `--sandbox` is not one — measured on 1.1.10, a run with it enabled wrote outside the workspace through both the edit tool and a shell command; it restricts what a terminal command may reach, not where anything may write. Gemini CLI's same-named flag is a *container* sandbox that refuses to start without Docker or Podman, so it was not measured and is not required of users. What `--write` controls differs per engine, and only on gemini is it a capability: there it adds `--yolo`, without which the model is offered no write or shell tools at all. **On AGY it is not a boundary.** Every run is oriented on your repository — `--add-dir` when read-only, `--new-project` when writing — and neither flag withholds write, because AGY has no read-only mode. An unoriented run could still read and write any absolute path; all it lacked was knowing where your repository was, which is not a protection worth the loss of every legitimate use. See [`THREAT-MODEL.md` §7.2](THREAT-MODEL.md). Neither engine's plan mode is used: gemini's `--approval-mode plan` re-declares the write tools to the model and injects a planning workflow, making it a weaker read-only shape than passing nothing, and AGY's `--mode plan` gates the edit tools while letting a shell command write the same file (measured on 1.1.13) — and is disabled outright whenever `--disable-slash-commands` is passed, which is every AGY spawn from 1.1.9 up.
- **Thread/session resume**: Codex persists threads on the app server. Here, the selected engine's thread id is captured from its output or legacy transcript; `/gemini:result` prints the engine-specific resume command, and `--resume-last` continues the latest thread *for the current Claude session*. On AGY the conversation id is pinned with `--conversation`; on gemini it cannot be pinned, because `--resume` accepts only `latest` or an index, so the landing is compared against the tracked session id and a mismatch is reported.
