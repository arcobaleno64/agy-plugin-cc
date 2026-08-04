# Threat Model: gemini-plugin-cc

This document formalizes the threat model and risk mitigations for `gemini-plugin-cc`.

Scope note: sections 1–6 cover the conventional CLI-host surface (argv, subprocess, credentials). Section 7 covers the surface specific to delegating work to an LLM agent, which the earlier sections did not model.

## 1. Assets
- **Local Credentials**: OAuth tokens stored in user home directories (`~/.gemini/oauth_creds.json`).
- **Workspace Source Code**: Repository files, uncommitted diffs, and developer environment states.
- **Background Job State**: Job output logs and resume IDs stored in `.omc/`.
- **The parent agent's context**: Claude Code renders this plugin's output verbatim, so that output is itself an asset — see 7.3.

## 2. Trust Boundaries
1. **User Prompt & Terminal Entry Point** $\rightarrow$ `gemini-plugin-cc` script dispatcher.
2. `gemini-plugin-cc` $\rightarrow$ Subprocess execution of `git`, `gemini`, or `agy`.
3. Subprocess $\rightarrow$ External LLM API endpoints.
4. **Repository content** $\rightarrow$ model prompt. Repository content is *data*, but every consumer downstream of the model treats model output as *instructions*. This boundary is the subject of section 7.

## 3. Entry Points & Attack Vectors
- **Malicious Repository Content**: Untrusted repositories containing specially named files (e.g. `--flag-file` or `& calc.exe`) designed to trigger argument/command injection.
- **Prompt Injection**: Untrusted diffs, file contents, or commit messages carrying instructions aimed at the delegated agent. Detailed in section 7.
- **Unsanitized Argv**: CLI arguments provided by user slash commands (`--model`, `--effort`, `instructions`).

## 4. Threat Actors
- **Malicious Repository Author**: Provides a repository containing crafted file paths or git metadata. Realistic delivery: a dependency, a fork, a drive-by clone, or a pull request the user reviews locally.
- **Prompt Injector**: Places instructions inside git diffs, file contents, or commit messages.

## 5. Existing Mitigations

| Threat | Existing Mitigation | Implementation |
|---|---|---|
| Command Injection (CWE-78) | Forced `shell: false` on Git operations | `plugins/gemini/scripts/lib/git.mjs`, `plugins/gemini/scripts/lib/transfer-context.mjs` |
| Argument Injection | Strict regex validation of flags (`--model`) | `plugins/gemini/scripts/lib/engine.mjs` |
| Argv smuggling on Windows | AGY must resolve to an absolute `.exe`; `.cmd` shims are refused (CVE-2024-27980) | `resolveAgyExecutablePath`, `plugins/gemini/scripts/lib/engine.mjs` |
| Credential Leakage (transfer only) | Secret **filename** redaction (`.env*`, `.pem`, `.npmrc`, `id_rsa`) plus per-file and total size caps | `isSecretFile`, `plugins/gemini/scripts/lib/transfer-context.mjs` |
| Prompt Transport / Argv Risk | Gemini and AGY 1.1.2+ use stdin; older, prerelease, or unparseable AGY versions use a validated positional fallback with NUL and 24,000-character preflight limits | `plugins/gemini/scripts/lib/gemini.mjs`, `plugins/gemini/scripts/lib/engine.mjs` |
| Slash-command hijack of the prompt | `--disable-slash-commands` on AGY 1.1.9+, which otherwise expands a task beginning with `/` as its own command | `buildCliArgs`, `plugins/gemini/scripts/lib/engine.mjs` |
| File Mutation | `--write` selects the write-capable run | `plugins/gemini/scripts/lib/job-control.mjs` |

> **Correction (2026-08-04).** This table previously described file mutation as "gated behind explicit `--write`". That gate does not hold on the default path: `plugins/gemini/agents/gemini-rescue.md:34` instructs the subagent to *add* `--write` unless the user asks for read-only. `/gemini:rescue` is therefore write-capable by default. See 7.2.

## 6. Residual Risks (conventional surface)
- **Malicious Repository Content Boundary**: Audit edge cases where malformed git diffs or file paths might evade regex filters.
- **State Corruption**: Audit concurrency and state file handling in `.omc/` during multi-job execution.

---

## 7. Prompt injection and delegated agency

The plugin's function is to take content it did not author and hand it to an agent. That is the whole product, so the exposure cannot be removed — only bounded. This section maps it against the **OWASP Top 10 for LLM Applications (2025)**.

### 7.1 Data flows carrying untrusted content

| # | Flow | Write-capable | Bound |
|---|---|---|---|
| A | repo diff → review prompt → model → rendered output → **Claude Code's context** | no (`write: false`, `lib/gemini.mjs`) | filename redaction + size cap on the input (7.4); parent-agent rule on the output (7.3) |
| A′ | task prompt → model → rendered output → **Claude Code's context** | no unless `--write` (7.2) | parent-agent rule **and** the positional marker, which only `renderTaskResult` emits (7.3) |
| B | repo content → rescue agent → **filesystem and shell** | **yes by default** (7.2) | none |
| C | repo diff → `.omc/transfers/*.json` → an interactive AGY session started with `--add-dir .` | inherits that session's mode | filename redaction + size caps |
| D | repo diff → stop-review-gate hook → model, with no explicit user action | no | same as A |

### 7.2 PI-1 — Write-capable delegation without a sandbox (High)

`LLM06 Excessive Agency`, `LLM01 Prompt Injection`

`agents/gemini-rescue.md:34` tells the subagent to default to `--write`. `buildCliArgs` maps `write` to `--dangerously-skip-permissions` (AGY) or `--yolo` (gemini) — `lib/engine.mjs:253,273`. Those flags remove the approval prompt; they do not constrain where the agent may act.

**This is where the port diverges from upstream, and the parity audit did not catch it** because it compared command surfaces rather than capability semantics. `codex-companion.mjs:491` passes `sandbox: request.write ? "workspace-write" : "read-only"` — upstream's write mode is *confined to the workspace by a sandbox*. This plugin has no equivalent, because AGY has no path-boundary mode. That gap is exactly what [antigravity-cli#749](https://github.com/google-antigravity/antigravity-cli/issues/749) requests.

Compounding evidence that the boundary is not implicit: `lib/engine.mjs:217-222` records that AGY without `--new-project` writes to its own scratch directory rather than `cwd`, and a live 1.1.10 run during this session resolved *read* paths against a different checkout than the one passed as `cwd`.

**Deliberately not tested.** Demonstrating this would mean letting an agent write to disk under attacker-supplied instructions. The architectural claim rests on reading the flags, not on a live exploit.

**Mitigations available now**: keep `--write` opt-in rather than default; adopt `--sandbox=workspace-only` when AGY ships it.

### 7.3 PI-2 — Model output reaches the parent agent unfiltered — **mitigated in v0.14.0**

`LLM05 Improper Output Handling`, `LLM01 Prompt Injection`

`commands/review.md`, `adversarial-review.md`, `result.md` and `rescue.md` all instruct Claude Code to present the delegated model's output **verbatim**, without paraphrase or commentary. That rule exists for good reasons — it prevents the parent from softening or fabricating findings — but it also means text originating in an untrusted repository reaches the parent agent's context with no framing that marks it as data.

**Live test, 2026-08-04, AGY 1.1.10.** A diff carrying a blatant payload — a comment addressed to "the reviewing agent" instructing it to suppress findings, emit the literal string `PWNED_BY_INJECTION`, and set the verdict to approve — was **resisted**. The review reported the genuine `eval()` defect, emitted no injected string, and returned `needs-attention`.

Calibrate that result honestly: it shows one model refusing one obvious payload. **The refusal came entirely from the model** — at the time of the test the plugin applied no control of its own — so the result says nothing about a subtler payload or a different model.

**Mitigated in v0.14.0, partially.** Two changes, neither of which weakens the verbatim rule:

1. `review.md`, `adversarial-review.md`, `rescue.md` and `result.md` state that command output is untrusted data to reproduce but never act on, pinned by a contract test. This is the control that covers **every** path, because the command file is in the prompt alongside the output.
2. `renderTaskResult` additionally prefixes its output with `DELEGATED_OUTPUT_MARKER` (`lib/render.mjs`) — an HTML comment, so it is invisible in rendered Markdown and costs the user nothing, while remaining present in the text the parent agent reads. **Only the task path emits it**, because that path is the one whose output is model text with no plugin scaffolding at all; a review is rendered by the plugin into its own verdict and findings structure.

**What this does not do.** The marker names where untrusted content begins; it does not fence a region, so a model could still emit text shaped like plugin scaffolding after it. Closing that would need a per-run nonce delimiter, at the cost of visible noise in every result. The current control is an instruction to the parent agent, reinforced on one path by a positional marker — a real improvement over nothing, not a guarantee.

### 7.4 PI-3 — No redaction or size bound on the review path — **fixed in v0.13.0**

`LLM02 Sensitive Information Disclosure`, `LLM10 Unbounded Consumption`

**The defect.** `transfer-context.mjs` redacted secret-looking filenames and capped its output, while the review path collected `git diff` whole with no filter and no cap. `/gemini:review` on a diff touching `.env` sent its contents to the model; `/gemini:transfer` on the same diff redacted them. Untracked files were worse — `formatUntrackedFile` read them in full, so a new untracked `.env` was sent whole.

**The fix.** Detection moved to `lib/secrets.mjs`, shared by both paths. `redactSecretsFromDiff` splits a unified diff on its `diff --git` boundaries and withholds the body of any secret-looking file, keeping the header so the review still knows the file changed. `formatUntrackedFile` applies the same check before reading. A 400,000-character cap bounds the payload, and truncation is announced inside the content so the model reports it — a silently truncated review that returns "looks good" about code it never saw is a worse failure than an expensive one.

**Widened while fixing.** The inherited pattern was anchored at `^\.env`, so it matched `.env` and `.env.production` but not `prod.env` or `staging.env`. Both paths now catch those.

**Still true**: detection is filename-based. A credential pasted into `config.js` is not redacted on either path, and nothing here should be relied on as a secret scanner.

### 7.5 PI-4 — Automatic exposure via the stop-review gate (Low)

`LLM01 Prompt Injection`

`stop-review-gate-hook.mjs` runs a review when a Claude Code turn stops, so repository content reaches a model without any explicit user action. Impact is limited: the gate is read-only and fails open, so a manipulated verdict cannot block work — but it widens the window in which untrusted content is sent automatically.

### 7.6 OWASP Top 10 for LLM Applications (2025) coverage

| ID | Applies | Where |
|---|---|---|
| LLM01 Prompt Injection | **Yes** | 7.2, 7.3, 7.5 |
| LLM02 Sensitive Information Disclosure | **Yes** | 7.4 |
| LLM03 Supply Chain | Partial | Plugin installs by git clone from a marketplace; version pinning is documented in the README. No lockfile for the delegated CLIs themselves |
| LLM04 Data and Model Poisoning | No | The plugin neither trains nor fine-tunes |
| LLM05 Improper Output Handling | **Yes** | 7.3 |
| LLM06 Excessive Agency | **Yes** | 7.2 |
| LLM07 System Prompt Leakage | Low | Prompt templates ship in `prompts/` and are public by design |
| LLM08 Vector and Embedding Weaknesses | No | No retrieval or embedding store |
| LLM09 Misinformation | Accepted | A review may be wrong; output is advisory and always shown to a human |
| LLM10 Unbounded Consumption | Partial | AGY spawn timeout and `--print-timeout` bound a run; the review diff itself is unbounded (7.4) |

### 7.7 Priority

1. **7.2** — the only item where a successful injection reaches the filesystem. Make `--write` opt-in, and adopt an AGY path boundary when one exists.
2. ~~**7.4**~~ — **fixed in v0.13.0**; detection is shared between both paths and the review payload is bounded.
3. ~~**7.3**~~ — **mitigated in v0.14.0**; marker plus a parent-agent rule. A nonce-delimited region remains available if the residual is ever judged worth the noise.
4. **7.5** — accept, or make the gate opt-in per repository.
