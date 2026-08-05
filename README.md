# Gemini / Antigravity Companion for Claude Code

> Use Gemini CLI or Antigravity CLI (`agy`) inside Claude Code for task delegation, pragmatic code review, and adversarial review.

**Transition-ready for Google's Gemini CLI to Antigravity CLI migration.**
`gemini-plugin-cc` keeps the familiar Claude Code slash-command workflow while letting you route work to Gemini CLI where available, or to Antigravity CLI (`agy`) during the post-June-2026 transition.

[繁體中文說明 →](README.zh-TW.md)

Ported from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (Apache-2.0), retaining a familiar slash-command and background-job workflow while adapting behavior to Gemini/AGY capabilities and documenting intentional divergences.

---

## Why this plugin?

`gemini-plugin-cc` is a Claude Code-native companion bridge for users who want both Gemini CLI and Antigravity CLI (`agy`) support during Google's Gemini CLI transition.

Compared with AGY-only, multi-host plugins, this project keeps the Gemini CLI path where available while providing an explicit `--engine agy` route for users migrating to Antigravity CLI.

- Claude Code-native `/gemini:*` slash commands.
- Pragmatic and adversarial code review over the current diff or branch.
- Background task delegation for longer-running companion-agent work.
- Gemini model aliases, graceful model fallback, and transient review retry.
- Version-gated AGY prompt transport: native JSON envelope on 1.1.8+, transcript recovery below it.
- Safer stdin prompt delivery on Gemini and AGY 1.1.2 or newer.

| Need | Use this plugin when... |
|---|---|
| Gemini CLI still works for you | You want model selection, JSON output, and stdin prompt delivery. |
| You are migrating to AGY | Use `--engine agy` as the fully supported Antigravity CLI backend. |
| You want adversarial review | Use `/gemini:adversarial-review` with optional focus text. |
| You need AGY-only multi-host support | Consider an AGY-only plugin instead. |

---

## Features

- **`/gemini:rescue`** — Delegate investigation, debugging, or implementation tasks to the selected Gemini CLI or AGY engine. Runs in the foreground or detached in the background.
- **`/gemini:transfer`** — Export current session context (git status, diff, instructions) into a structured JSON snapshot and print a single-quoted launch command for AGY or Gemini CLI (POSIX Bash form everywhere, plus a PowerShell form on Windows).
- **`/gemini:review`** — Standard (pragmatic) code review over the current diff or branch. Finds real bugs, missing error handling, and incomplete code paths. Add `--deep` for an agentic pass that explores repo context beyond the diff.
- **`/gemini:adversarial-review`** — Adversarial code review that challenges design decisions over the current diff or branch. Returns structured findings with severity ratings.
- **`/gemini:setup`** — Check Gemini CLI / AGY availability and OAuth status.
- **`/gemini:status`** — Inspect active and completed background jobs.
- **`/gemini:result`** / **`/gemini:cancel`** — Retrieve or cancel a background job.
- **Engine auto-detection** — Both engines are first-class; `auto` checks `gemini` first for its JSON/model contract, then `agy`.
- **Version-aware stdin prompt delivery** — Gemini always uses stdin; AGY 1.1.2 or newer uses its auto-print stdin path, while older or unknown versions retain the compatible positional path.
- **Session lifecycle hooks** — Automatically injects `GEMINI_COMPANION_SESSION_ID`; cleans up stale jobs on session end.

---

## Prerequisites

| Requirement | Version | Install |
|---|---|---|
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org) |
| Gemini CLI | ≥ 0.40; required for the `gemini` engine | `npm install -g @google/gemini-cli` |
| AGY | ≥ 1.0.3; ≥ 1.1.2 recommended and live-verified on Windows/Ubuntu WSL2 | _(see install note below)_ |
| Claude Code | any | [claude.ai/code](https://claude.ai/code) |

**Install AGY** (required for `--engine agy`): `curl -fsSL https://antigravity.google/cli/install.sh | bash`

**Authentication**: Each engine authenticates independently. Run `gemini` once for the Gemini engine, or run `agy` once interactively for the AGY engine. AGY 1.1.10+ also supports Application Default Credentials (ADC) and Gemini Enterprise / Workforce Identity Federation (WIF). AGY OAuth authentication cannot be verified reliably from a headless setup probe, so `/gemini:setup --engine agy` reports it as unknown until a real AGY command succeeds.

> **The Gemini engine now needs a Standard/Enterprise account or an API key.** Google ended consumer Gemini CLI access on 2026-06-18. On a personal account, gemini CLI 0.53.1 still installs and answers `--version`, but every request returns `API key not valid` (`API_KEY_INVALID`) — verified 2026-08-04. The AGY engine is unaffected and is the practical default; pass `--engine agy`, or set `GEMINI_ENGINE=agy`, if `auto` selects an unauthenticated gemini binary.

> **Heads-up (reality check):**
> - **2026-06-18 consumer transition**: Google announced that free/personal, Google AI Pro, and Google AI Ultra Gemini CLI requests stop being served after this date; Standard/Enterprise access remains. See Google's [Gemini CLI to Antigravity CLI announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/).
> - **Model availability drifts by CLI version.** A 2026-08-05 probe of the live Gemini API listing found `gemini-3.5-flash` and `gemini-3.6-flash` are now GA, while `gemini-3.5-pro` is still absent — the 2026-06-02 probe had returned `404 ModelNotFound` for both 3.5 ids. The plugin gracefully falls back to a GA model if a requested id is unavailable. See [Model Aliases](#model-aliases) and [docs/MODEL_COMPARISON.md](docs/MODEL_COMPARISON.md).

---

## Installation

### Release channel (marketplace follows `main`)

```
# 1. Add the marketplace
/plugin marketplace add arcobaleno64/gemini-plugin-cc

# 2. Install the plugin
/plugin install gemini@gemini-plugin-cc

# 3. Reload plugins
/reload-plugins
```

This marketplace source follows the repository's `main` branch, but that does **not** mean every Claude Code launch automatically installs and activates new code:

- Claude Code identifies this plugin by its explicit manifest version. Existing installations update only after that version is bumped (normally as part of a release); unversioned commits on `main` with the same manifest version are not delivered as plugin updates.
- Auto-update is disabled by default for third-party marketplaces. To opt in, open `/plugin`, select **Marketplaces** → **gemini-plugin-cc**, and choose **Enable auto-update**. When enabled, Claude Code checks the marketplace at startup and updates installed plugins whose resolved version changed.
- If Claude Code reports that the plugin was updated, run `/reload-plugins` before using it in the current session. Opening Claude Code by itself is therefore not a reliable guarantee that a newly published version is already active.

For an explicit update without enabling auto-update, run:

```
/plugin marketplace update gemini-plugin-cc
/plugin update gemini@gemini-plugin-cc
/reload-plugins
```

### Pinned release (a specific published version)

Pin the marketplace to a release tag — e.g. `v0.9.1`:

```
/plugin marketplace add arcobaleno64/gemini-plugin-cc@v0.9.1
/plugin install gemini@gemini-plugin-cc
/reload-plugins
```

> Claude Code installs plugins from the git tree, not from GitHub Release tarballs — `@<tag>` selects the git tag behind a [Release](https://github.com/arcobaleno64/gemini-plugin-cc/releases). A pinned marketplace stays on that tag even if marketplace auto-update is enabled. To move it to another release, remove the existing marketplace (which also uninstalls plugins installed from it), add the repository again with the new tag, reinstall the plugin, and run `/reload-plugins`.

Then run `/gemini:setup` for `auto`/Gemini, or `/gemini:setup --engine agy` for AGY. The selected engine is the only engine dependency that must be installed; setup offers the matching installer when it is missing.

If Gemini is installed but not authenticated yet, run:

```
!gemini
```

---

## Quick Start

```
# Delegate a task to Gemini (foreground)
/gemini:rescue Investigate why the auth middleware returns 401 on valid tokens

# Run in the background and check later
/gemini:rescue --background Add unit tests for the UserService class
/gemini:status

# Adversarial review of your current diff
/gemini:adversarial-review

# Review with a specific focus
/gemini:adversarial-review Focus on race conditions in the job queue
```

---

## Commands

### `/gemini:rescue [prompt]`

Delegates a task to Gemini. Reads from stdin if no prompt is given.

| Flag | Description |
|---|---|
| `--background` | Run detached; returns a job ID immediately |
| `--write` | Let the engine work on **your repository** instead of its own scratch directory. Off by default. On AGY this binds the session to `cwd` (`--new-project`); on gemini it adds `--yolo`. It is not a sandbox — see [Security](#security) |
| `--resume-last` | Continue the most recent Gemini session |
| `--fresh` | Force a new Gemini session, ignoring any resumable thread |
| `--engine <gemini\|agy\|auto>` | Override engine selection |
| `--model <alias\|id>` | Model override. Gemini resolves its aliases; AGY 1.1.10+ requires an exact model ID from `agy models`. AGY model selection cannot be combined with `--effort` or a dual-engine (`--engines gemini,agy`) review. |
| `--effort <low\|medium\|high\|xhigh>` | Gemini maps effort to a model; AGY 1.1.10+ forwards `low`, `medium`, or `high` as native reasoning effort when no AGY model is selected. |

### `/gemini:transfer [instructions...]`

Exports current workspace context (git diff, status, instructions) and generates ready-to-run CLI commands (`agy`/`gemini`) to hand off work to an interactive terminal session. Includes automated secret redaction (`.env*`, credentials) and git conflict safeguards. The generated commands are printed for you to paste into a terminal; the plugin never runs them.

| Flag | Description |
|---|---|
| `--engine <gemini\|agy\|auto>` | Which handoff commands to print. `auto` (default) prints both |
| `--model <id>` | Model override carried into the generated command. AGY requires an exact ID from `agy models` |
| `--effort <low\|medium\|high\|xhigh>` | Reasoning effort carried into the generated AGY command. Cannot be combined with `--model` |

### `/gemini:review`

Runs a standard, pragmatic review over the current working tree or branch diff — real bugs, missing error handling, and incomplete code paths. Not steerable and takes no focus text; use `/gemini:adversarial-review` to challenge a specific decision.

| Flag | Description |
|---|---|
| `--wait` / `--background` | Run in the foreground or detached |
| `--deep` | Agentic review — let Gemini explore repo context beyond the diff (slower, higher-token; gemini engine) |
| `--base <ref>` | Compare against a specific git ref |
| `--scope <auto\|working-tree\|branch>` | Diff scope |
| `--engine <gemini\|agy\|auto>` | Override engine |
| `--model <alias\|id>` | Model override |
| `--effort <level>` | Model selection on Gemini; native reasoning effort on AGY 1.1.10+ (`low`, `medium`, `high`) when no AGY model is selected |

### `/gemini:adversarial-review [focus]`

Runs an adversarial review over the current working tree or branch diff.

| Flag | Description |
|---|---|
| `--deep` | Agentic review — let Gemini explore repo context beyond the diff (slower, higher-token; gemini engine) |
| `--base <ref>` | Compare against a specific git ref |
| `--scope <auto\|working-tree\|branch>` | Diff scope |
| `--engine <gemini\|agy\|auto>` | Override engine |
| `--model <alias\|id>` | Model override |
| `--effort <level>` | Model selection on Gemini; native reasoning effort on AGY 1.1.10+ (`low`, `medium`, `high`) when no AGY model is selected |

### `/gemini:setup`

Prints availability and auth status for Node, Gemini CLI, and AGY.

### `/gemini:status [job-id]`

Lists active and recent background jobs. Pass a job ID to inspect a single job.

| Flag | Description |
|---|---|
| `--wait` | Block until the job completes (requires a job ID) |
| `--all` | Show all jobs, not just this session's |

### `/gemini:result [job-id]`

Retrieves the output of a completed job. If the job has a Gemini session ID, the output includes `Resume in Gemini: gemini --resume <session-id>` — paste that into a terminal to continue the session in Gemini CLI directly.

### `/gemini:cancel [job-id]`

Cancels a running or queued background job.

---

## Review Gate (Optional)

An optional stop-time gate that runs an adversarial review before Claude Code can stop, whenever a `--write` task completed in the session. Disabled by default.

Enable or disable via `/gemini:setup`:

```
# Enable
/gemini:setup --enable-review-gate

# Disable
/gemini:setup --disable-review-gate
```

When enabled and the review returns `needs-attention`, Claude Code is blocked from stopping and shown the finding summary. Run `/gemini:adversarial-review --wait` to review the findings and decide whether to accept or fix them before continuing.

---

## Model Aliases

| Alias | Resolved Model | Notes |
|---|---|---|
| `flash` / `flash3` | `gemini-3-flash-preview` | Gemini 3 Flash (preview) |
| `pro` / `pro3` | `gemini-3.1-pro-preview` | Gemini 3.1 Pro (preview) |
| `flash25` | `gemini-2.5-flash` | Stable 2.5 Flash (GA) |
| `pro25` | `gemini-2.5-pro` | Stable 2.5 Pro (GA) |
| `lite` / `fast` | `gemini-2.5-flash-lite` | Cost-efficient (GA) |
| `lite3` | `gemini-3.1-flash-lite` | Gemini 3.1 Flash-Lite (GA, cost-efficient) |

### Model Alias Notes

- Aliases and effort tiers live in a single source of truth — `plugins/gemini/scripts/lib/model-map.mjs` — and `npm test` verifies the table above against it, so the two cannot drift.
- **Effort mapping** (applied when `--effort` is given without `--model`): `none`/`minimal` → `gemini-2.5-flash-lite`; `low`/`medium` → `gemini-3-flash-preview`; `high`/`xhigh` → `gemini-3.1-pro-preview`.
- **CLI probe snapshot.** The alias table was last re-verified 2026-08-05 against the live Gemini API model listing; all six ids it uses resolved. Google can retire preview ids at any time. If an alias stops resolving, override it with `--model <exact-id>` — any value that is not a known alias is passed through to the CLI unchanged.
- **Gemini 3.5 availability has changed.** The 2026-06-02 probe returned `404 ModelNotFound` for both `gemini-3.5-flash` and `gemini-3.5-pro`. As of 2026-08-05 `gemini-3.5-flash` is GA and `gemini-3.5-pro` is still absent. Unknown or unavailable model IDs degrade gracefully to the GA fallback.
- **Graceful model fallback.** If a requested model id is not found on your gemini CLI (preview/retired id, or a CLI-version mismatch), the plugin retries the run **once on the GA fallback `gemini-2.5-flash`** and prints a clear note — so a stale id degrades gracefully instead of hard-failing.
- **AGY 1.1.10+ model and reasoning selection.** Use either `--model <exact-id>` from `agy models` or native `--effort <low|medium|high>`; the options are mutually exclusive. AGY model IDs are not Gemini aliases, and `--model` is unavailable for a dual-engine review because model IDs are engine-specific.

---

## Engine Routing

In `auto` mode the plugin selects the first available engine in this order:

1. **`gemini` CLI** — outputs via stdout; supports stdin prompt delivery.
2. **`agy`** — first-class supported engine and second `auto` candidate; AGY 1.1.2 or newer receives the prompt on stdin with no `--print` flag, while older or unknown versions retain `agy --print <prompt>`.

Override via `--engine` flag or the `GEMINI_ENGINE` environment variable.

> **Gemini counts as available only when it has a credential the CLI would actually use.** That means `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `~/.gemini/oauth_creds.json`, or the two entries Gemini CLI 0.53.1 keeps in your OS keychain (`gemini-cli-api-key/default-api-key`, `gemini-cli-oauth/main-account`). The keychain is checked for **existence only** — never the stored value — and the probe can be switched off with `GEMINI_COMPANION_DISABLE_KEYCHAIN=1`, at the cost of `auto` skipping a gemini whose credential it can no longer see. See [`PRIVACY.md`](PRIVACY.md). One case is deliberately not detected: where no keychain is available the CLI falls back to an encrypted file shared by every service, and its presence cannot distinguish a gemini credential from an unrelated token, so it is not guessed at — use `--engine gemini` there.

> **AGY 1.1.10+ selection:** use either `--model <exact-id>` from `agy models` or `--effort <low|medium|high>`. Gemini aliases are not valid AGY model IDs, model and effort cannot be combined, and `--model` is unavailable for a dual-engine review because IDs are engine-specific. Gemini retains its separate alias and effort-to-model mapping.

> **AGY 1.1.8+ uses the native JSON envelope; older AGY falls back to transcript recovery.** AGY 1.1.8 added `--output-format json`, which returns the response, conversation ID, and a terminal status on stdout. From plugin v0.11.0 that envelope is the source of truth on AGY 1.1.8 or newer, and the on-disk transcript is not read at all — no brain root is required. One consequence: the reasoning-summary section is not shown for AGY results, because the envelope reports only a `thinking_tokens` count and carries no thinking text (`stream-json` does not either). The Gemini engine is unaffected; it takes its reasoning summary from stderr.
>
> Below AGY 1.1.8 the transcript remains authoritative, because positional `agy --print` produced no piped response on older releases (upstream [google-gemini/gemini-cli#27466](https://github.com/google-gemini/gemini-cli/issues/27466); reproduced on macOS AGY 1.0.7) and no version before 1.1.8 surfaces the conversation ID on stdout. Those runs still take the completed response, DONE status, thinking, and conversation ID from disk. Known brain roots are `~/.gemini/antigravity-cli/brain` (verified on Windows, macOS AGY 1.0.7, and Linux AGY 1.1.2) and `~/.antigravity-cli/brain` (older Linux 1.0.2, reported). If no brain root is found on such a version, run `agy` once, upgrade to 1.1.8 or newer, or open an issue with its actual location.

---

## Security

- **Stdin delivery**: Gemini prompts and AGY 1.1.2-or-newer prompts use Node's `spawnSync` `input` option and never enter argv. AGY versions older than 1.1.2, plus unparseable versions, keep the positional compatibility path and its 24,000-character limit; prefer Gemini or AGY 1.1.2+ for untrusted prompt content.
- **Windows process boundary**: Gemini's npm `.cmd` shim is launched through `shell:true`, but its prompt remains on stdin and only validated flags enter argv. AGY must resolve to an absolute `.exe` and is always launched with `shell:false`.
- **Git process boundary**: Repository-derived refs are always passed to Git as literal argv with `shell:false`, including on Windows; Git helpers never inherit the `.cmd` wrapper fallback. This aligns with the upstream Codex plugin's [v1.0.6 Git shell-expansion removal](https://github.com/openai/codex-plugin-cc/releases/tag/v1.0.6).
- **DEP0190 warning is benign**: On Windows you may see `(node:NNN) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.` This is **safe to ignore here** — the deprecation is about *prompt content* placed in argv under `shell: true`, but this plugin never does that for the gemini engine: the prompt travels on stdin, and only controlled flags reach argv (each validated, e.g. model ids must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`). The warning is Node flagging the general pattern, not an actual injection vector in this code path.
- **AGY transport fallback**: Only a stable parsed version of 1.1.2 or newer enables stdin. Unknown and prerelease version strings fail closed to the existing positional path, preserving compatibility rather than assuming an upstream capability.
- **AGY 1.1.10+ `.git` sandbox rule**: AGY 1.1.10 implements read-only `.git` sandbox rules during sandboxed execution, protecting git repository metadata and commit history against accidental modification during review and subagent tasks.
- **Credential handling**: OAuth credentials in `~/.gemini/oauth_creds.json` are read only to check token expiry via `getGeminiLoginStatus()`; they are never logged, copied elsewhere, or transmitted by this plugin.
- **`.gitignore`**: The workspace-local `.omc/` directory, which holds `/gemini:transfer` snapshots, is excluded from version control. Job state and logs live outside the repository entirely — see [How It Works](#how-it-works).

**What is sent, kept, and read** — including the one path that transmits without an explicit command — is documented in [`PRIVACY.md`](PRIVACY.md).

---

## Setup & Auth Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `gemini: not found` | Gemini CLI not installed | `npm install -g @google/gemini-cli`, or run `/gemini:setup` and accept the install prompt |
| `npm: not found` | Node/npm missing from PATH | Install Node.js ≥ 18 from [nodejs.org](https://nodejs.org) |
| setup shows `gemini auth: No credentials …` | OAuth not completed | Run `!gemini` once and complete the browser login |
| setup shows `… token expired` | OAuth token lapsed | Run `!gemini` again to refresh credentials |
| `Status: partial (AGY available …)` | Gemini CLI unavailable but AGY present | Use `--engine agy` directly; setup keeps AGY auth `unknown` because it cannot verify the independent AGY OAuth flow non-interactively |
| Windows: command resolves but fails | `.cmd` wrapper / PATH | Confirm `where gemini` resolves; the plugin spawns bare names through `shell: true` to find `.cmd` shims |
| `--engine agy` reports no brain root | AGY has not created its brain directory yet, or it lives in an unknown location | Run `agy` once so it creates the brain dir. Known roots: `~/.gemini/antigravity-cli/brain` (verified on Windows, macOS AGY 1.0.7, and Linux AGY 1.1.2) and `~/.antigravity-cli/brain` (older Linux 1.0.2, reported); if yours differs, open an issue with its location |

For the Gemini engine, run **`!gemini`** once — the plugin completes OAuth by invoking `gemini` itself. There is **no** `gemini login` subcommand. For the AGY engine, run `agy` interactively once; its separate OAuth state is not inferred from Gemini's `~/.gemini/oauth_creds.json`. `setup` reports AGY as `partial` while the binary is present but auth remains unverifiable.

---

## How It Works

```
Claude Code
  └─ /gemini:rescue "prompt"
       └─ gemini-companion.mjs task
            ├─ detectEngine()        → gemini | agy
            ├─ buildCliArgs()        → version-gated args
            ├─ runCommand()          → spawnSync
            │    input: prompt       ← gemini + AGY ≥1.1.2
            │    argv: prompt        ← older/unknown AGY only (24K cap)
            └─ renderTaskResult()   → Markdown output to Claude
```

Background mode spawns a detached worker child process (`task-worker` for `/gemini:rescue`, `review-worker` for `/gemini:review` and `/gemini:adversarial-review`) and returns a job ID immediately. State is polled via `/gemini:status`, so a background result survives even if the Claude session is interrupted.

Job state is written to Claude Code's per-plugin data directory — `$CLAUDE_PLUGIN_DATA/state/<workspace>-<hash>/`, holding `state.json` and one `.json` plus `.log` per job, most recent 50 kept. Outside Claude Code, where that variable is unset, it falls back to `<system temp>/gemini-companion/<workspace>-<hash>/`; the OS eventually cleans that, so a job left running across a temp sweep can disappear. Set `GEMINI_COMPANION_DATA` to pin the location yourself.

The workspace-local `.omc/` directory is a separate thing: it holds `/gemini:transfer` snapshots only, not job state.

---

## Parity with codex-plugin-cc

This plugin is a high-fidelity port of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc). The public slash-command surface, background job model, and state/result/status/cancel flow mirror the upstream; the execution backends are the first-class Gemini CLI and AGY engines rather than the Codex app server.

### Compatibility Matrix

| Upstream (Codex) | This plugin (Gemini) | Parity |
|---|---|---|
| `/codex:setup` | `/gemini:setup` | **Gemini-specific divergence** — checks Gemini OAuth or AGY binary readiness for the selected first-class engine instead of Codex auth |
| `/codex:review` | `/gemini:review` | **best-effort equivalent** — prompt / CLI-adapter review, not a native reviewer |
| `/codex:adversarial-review` | `/gemini:adversarial-review` | **best-effort equivalent** — adversarial prompt over the same diff target |
| `/codex:rescue` | `/gemini:rescue` | **1:1 parity** — same forwarder/subagent contract and flags |
| `/codex:transfer` | `/gemini:transfer` | **1:1 parity** — exports session snapshot and generates AGY / Gemini CLI handoff launch commands |
| `/codex:status` | `/gemini:status` | **1:1 parity** — same job model; `--all` crosses Claude sessions |
| `/codex:result` | `/gemini:result` | **Gemini-specific divergence** — surfaces the Gemini session id + `gemini --resume` |
| `/codex:cancel` | `/gemini:cancel` | **1:1 parity** — same process-tree termination (POSIX + Windows) |

### Codex app server vs Gemini CLI adapter

- **Runtime**: Codex uses a persistent app-server with native review and persistent threads. This plugin invokes the selected first-class Gemini CLI or AGY engine directly *per command* (no shared runtime); `auto` uses capability-based Gemini→AGY ordering.
- **Standard review**: In the Codex plugin, `/codex:review` is a *native* reviewer. Here, `/gemini:review` is a **prompt-based / CLI-adapter equivalent** — it sends the diff to Gemini with a pragmatic-review prompt and parses structured JSON back. It is not a native Gemini reviewer.
- **Sandbox**: Codex exposes `read-only` / `workspace-write` sandboxes and confines a write-capable run to the workspace. **Neither Gemini CLI nor AGY offers an equivalent path boundary this plugin can impose**, so it has none. AGY's `--sandbox` is not one — measured on 1.1.10, a run with it enabled wrote outside the workspace through both the edit tool and a shell command; it restricts what a terminal command may reach, not where anything may write. Gemini CLI's same-named flag is a *container* sandbox that refuses to start without Docker or Podman, so it was not measured and is not required of users. What `--write` controls differs per engine: on AGY it selects *where the engine works* (without it AGY operates in its own scratch directory and your repository is untouched), while on gemini it adds `--yolo`, which genuinely gates whether write and shell tools are offered to the model at all. See [`docs/THREAT-MODEL.md` §7.2](docs/THREAT-MODEL.md). (`--approval-mode plan` is not used — it *does* work headless, but it re-declares the write tools to the model and injects a planning workflow, making it a weaker read-only shape than passing nothing.)
- **Thread/session resume**: Codex persists threads on the app server. Here, resume relies on the Gemini CLI **session id** captured from the JSON envelope; `/gemini:result` prints `gemini --resume <session-id>`, and `--resume-last` continues the latest thread *for the current Claude session*.

---

## Skills

Three skills are bundled for Claude Code to consume:

| Skill | Purpose |
|---|---|
| `gemini-cli-runtime` | Runtime contract — how to call `gemini-companion task` |
| `gemini-result-handling` | Result presentation rules (severity, reasoning, evidence) |
| `gemini-prompting` | Prompt composition guide (XML tags, output contract) |

---

## Known limitations

Documented, non-blocking constraints — see the linked sections for detail:

- **Model and access availability drift.** Google announced the 2026-06-18 consumer Gemini CLI transition; Gemini model IDs served by the CLI also change over time. This plugin keeps a GA fallback for unavailable Gemini model IDs. See [Model Alias Notes](#model-alias-notes) and [docs/MODEL_COMPARISON.md](docs/MODEL_COMPARISON.md).
- **`/gemini:review` is a prompt/CLI adapter, not a native reviewer.** It sends the diff with a review prompt and parses the structured JSON, rather than using an app-server reviewer, so its feedback depth differs from a native one. See [Codex app server vs Gemini CLI adapter](#codex-app-server-vs-gemini-cli-adapter).

---

## Support

- **Setup or auth failing** — check [Setup & Auth Troubleshooting](#setup--auth-troubleshooting) first; most install and OAuth symptoms are in that table.
- **A feature behaves differently from `codex-plugin-cc`** — check [docs/known-diffs.md](docs/known-diffs.md) before filing. Several differences are deliberate and documented.
- **A bug** — open a [bug report](https://github.com/arcobaleno64/gemini-plugin-cc/issues/new?template=bug_report.yml). Include the exact command and your `/gemini:setup` output; those two answer most questions on their own.
- **An engine version or platform we have not verified** — open a [compatibility report](https://github.com/arcobaleno64/gemini-plugin-cc/issues/new?template=compatibility_report.yml). "It works on X" is as useful as "it breaks on X", because the docs only claim what has actually been run.
- **A security vulnerability** — do not open an issue. Use [private disclosure](https://github.com/arcobaleno64/gemini-plugin-cc/security/advisories/new); see [`SECURITY.md`](SECURITY.md).

Reviewing the plugin rather than using it? [`docs/verifying-without-credentials.md`](docs/verifying-without-credentials.md) is the complete offline path — no account, no API key. For a run of every command end to end against a stand-in engine, start with `node scripts/reviewer-demo.mjs`.

---

## Changelog

See [CHANGELOG.md](plugins/gemini/CHANGELOG.md).

---

## License & Upstream Attribution

MIT © 2026 arcobaleno64.

This project is a derivative work of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc), Copyright 2026 OpenAI, licensed under the Apache License, Version 2.0. Adapted portions remain under Apache-2.0 (see [`LICENSE-APACHE-2.0`](LICENSE-APACHE-2.0) and [`NOTICE`](NOTICE)); Gemini/AGY-specific changes are MIT (see [`LICENSE`](LICENSE)).

**Derived from upstream** (adapted, Apache-2.0): the slash-command structure, the background job model (enqueue / worker / status / result / cancel), the `.omc/state` persistence and job-control patterns, the stop-time review-gate pattern, the skill contract layout, and the version/manifest tooling (`bump-version`).

**Original to this repository** (MIT): the Gemini/AGY engine detection and routing, stdin prompt delivery, the `model-map` alias/effort source, AGY engine handling, OAuth status checks, and the contract-verification script.
