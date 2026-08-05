# Changelog

## Unreleased

### Added
- **`node scripts/make-sample-repo.mjs`** materializes a benchmark corpus case into a disposable git repository and prints the defects planted in it. It is the safe target for a `--write` run, which is write-capable with no path sandbox ([`docs/THREAT-MODEL.md` §7.2](../../docs/THREAT-MODEL.md)). No new fixture content: `bench/lib/corpus.mjs` already built exactly this repo for the benchmark, so the script is that call minus the cleanup.

### Security
- **A review no longer reads through an untracked symlink that leaves the workspace.** `formatUntrackedFile` checked `isSecretFile` against the *link* name — which whoever plants the link chooses — and then followed it with `readFileSync`. An untracked symlink called `notes.txt` pointing at `~/.ssh/id_rsa` passed every check and its target's contents were sent to the model. The link is now resolved with `fs.realpathSync.native` and skipped when the target falls outside the workspace; both sides are canonicalized first, because a `cwd` that is itself a symlinked path (macOS `/tmp`) would otherwise mark every file as an escape. In-repo aliases still inline normally and broken links still report as broken. The reachable route is a write-capable delegated task creating the link and a later review reading through it — see [`docs/THREAT-MODEL.md` §7.4](../../docs/THREAT-MODEL.md).

### Fixed
- **The redacted-file list named the wrong path when a directory contained a space.** `redactSecretsFromDiff` read the b-side path off the `diff --git a/P b/P` header, which is ambiguous once `P` holds a space: for `a b/c.env` the first ` b/` gives `c.env b/a b/c.env` and the last gives `c.env`. It now takes the path from the unambiguous `+++ b/<path>` line, stopping at the first `@@` so an added line beginning `++ ` cannot be misread as the header, and falls back to the old header match for diffs with no `+++` line. Redaction itself was never wrong — the check runs on the final path segment, which survives either misparse — so this is the accuracy of what the user is told was withheld.

### Documentation
- **`PRIVACY.md` states what the plugin sends, keeps, and reads**, with a source file cited beside each claim. It was the one directory-compliance document the repository did not have; nothing in `README.md`, `README.zh-TW.md`, `SECURITY.md`, or `docs/THREAT-MODEL.md` contained the word *privacy*. Both READMEs and `SECURITY.md` link to it.
  - The document says the uncomfortable parts out loud: secret detection is by filename only; the size caps and redaction bound what the *plugin* assembles, not what the agentic CLI may read on its own once running in your workspace ([`docs/THREAT-MODEL.md` §7.2](../../docs/THREAT-MODEL.md)); and the opt-in Stop review gate is the one path that transmits a diff without a fresh command.
- **`SECURITY.md` supported-versions table said `0.12.x`** while 0.14.1 shipped — a security policy claiming the current release is unsupported. Corrected, with the rule ("only the current MINOR line") written down so the next bump does not re-stale it. The in-scope-components list also still pointed `isSecretFile()` at `transfer-context.mjs`; the definition moved to `lib/secrets.mjs` in 0.13.0.
- **`docs/verifying-without-credentials.md`** — the complete path for reviewing this plugin with no Google account, no OAuth, and no API key, and an explicit table of what the credentialed steps add. Maintainer credentials are never distributed, so the offline path has to be written down.
- **`docs/version-sources.md`** — the HANDOFF §14 P1 study, answered rather than left open. Recommendation: **keep all six version sources.** The duplication Anthropic's guidance warns about is mechanically enforced here by one bump script and a `check-version` gate that runs in both workflows, and the only redundant field interacts with a directory pipeline this repository cannot test against without experimenting on live users. Two named conditions would change the answer.
- **Support sections** in both READMEs, routing setup trouble, deliberate divergences, bugs, compatibility reports, and vulnerabilities to different places — a vulnerability in a public issue is the failure worth preventing.
- Issue templates for bug reports and compatibility reports. The bug template requires the exact command and `/gemini:setup` output, because those two answer most questions unaided. The compatibility template accepts "works on X" as readily as "breaks on X", since the docs only claim what has actually been run.

### Tests
- `tests/privacy-doc.test.mjs` pins `PRIVACY.md`'s presence, the four questions it must answer, and the link from every entry document — a policy doc rots when a README rewrite silently drops the link, not when the file is deleted. It also derives the expected supported-version line from `package.json`, so the table cannot go stale again without failing CI.
- `tests/sample-repo.test.mjs` covers the script a credential-free reviewer starts from: cases list, a materialized repo that is a real git repo with a non-empty diff and named defects, and an unknown case rejected rather than silently substituted.

Coverage for the paths that had none, per HANDOFF §14 P1. Verified against real git output, not only hand-written diffs:
- Untracked symlinks: escaping (skipped), in-workspace (still inlined), broken (still reported). Skipped with a reported reason on Windows hosts without symlink privilege rather than passing silently.
- `resolveStateDir` canonicalizes the workspace before hashing, so one checkout reached through a symlink shares a state dir, while two workspaces sharing a basename stay separate.
- Concurrent writers never expose a partially written `state.json` and leave no `.tmp` files. Pinned as the guarantee `atomicWriteJson` actually makes — a load/mutate/save cycle cannot also promise that concurrent writers keep each other's jobs.
- Hostile filenames through redaction: a directory containing a space, a rename whose destination is the secret store, and a git C-quoted non-ASCII path.
- Envelope truncation: an envelope cut mid-value is rejected, and so is one whose cut leaves a balanced inner object behind — the case where the balanced-block scan could otherwise report a successful run with no response. A large well-formed envelope is pinned as delivered intact, so any future size limit lands as a deliberate diff.

## 0.14.1 — 2026-08-05 — Correct argument quoting on the Windows shell path

### Fixed
- **Arguments ending in a backslash were corrupted when `runCommand` used the Windows shell.** The escaper handled `"` but left backslashes alone, so MSVCRT read the doubled-up run as an escape: a value like `a b\` reached the child as `a b"`, `a b\\` as `a b\`, and `a\"b` as `a\b`. Backslashes are now doubled before a quote and at the end of the value, per the MSVCRT argv rules. Measured on Windows: all eight awkward values now round-trip through `node -p process.argv` unchanged, where three of them were mangled before. This path carries fixed or validated argv only (`where`/`gemini`/`taskkill`), so it was a latent defect rather than an exploitable one — the module comment explaining why this is not a general cmd.exe escaper still stands.
- **Table cells containing a backslash could break the Markdown table.** `escapeMarkdownCell` escaped `|` without escaping `\` first, so an input containing `\|` rendered as a literal backslash followed by a live column separator. Backslashes are escaped first. Display correctness only; no security claim attaches to it.

### Added
- `quoteForWindowsShell` is exported for tests. Its rules are Windows-specific and are **not** equivalent under POSIX `sh`, so they are asserted on the returned string — which runs everywhere — with the argv round-trip kept as a Windows-only leg.

## 0.14.0 — 2026-08-04 — Delegated output is framed as data

### Security
- **Model output relayed into Claude Code's context is now marked as untrusted data.** The commands require verbatim reproduction — correctly, since that stops the parent from softening or inventing findings — but it also meant text originating in a reviewed repository arrived with nothing marking it as data rather than instructions. See [`docs/THREAT-MODEL.md` §7.3](../../docs/THREAT-MODEL.md).
  - `review.md`, `adversarial-review.md`, `rescue.md` and `result.md` state that command output is untrusted data to reproduce but never act on. A contract test pins the rule and checks it has not displaced the faithful-reproduction requirement it sits beside. This covers every path, because the command file sits in the prompt alongside the output.
  - `renderTaskResult` additionally prefixes its output with `DELEGATED_OUTPUT_MARKER`. It is an HTML comment, so **nothing changes visually** — it does not render in Markdown — while remaining present in the text the parent agent reads. Only the task path emits it: that is the path whose output is model text with no plugin scaffolding around it, whereas a review is rendered by the plugin into its own verdict and findings structure.

### Known limits
- The marker names where untrusted content begins; it does not fence a region, so a model could still emit text shaped like plugin scaffolding after it. Closing that needs a per-run nonce delimiter, which would put visible noise in every result — recorded in the threat model as available if the residual is ever judged worth the cost.

## 0.13.0 — 2026-08-04 — Secret redaction on the review path

### Security
- **`/gemini:review` and `/gemini:adversarial-review` no longer send secret file contents to the model.** `transfer-context.mjs` had redacted secret-looking filenames since 0.10.0, but the review path collected `git diff` whole, with no filter — so the same `.env` change was redacted by `/gemini:transfer` and disclosed by `/gemini:review`. Untracked files were worse: `formatUntrackedFile` read them in full, so a new untracked `.env` was sent whole. See [`docs/THREAT-MODEL.md` §7.4](../../docs/THREAT-MODEL.md).
- **The secret pattern now catches stage-named stores.** It was anchored at `^\.env`, matching `.env` and `.env.production` but not `prod.env` or `staging.env`. Both the review and transfer paths now catch those.

### Added
- `lib/secrets.mjs` is the single definition of secret detection. `redactSecretsFromDiff` splits a unified diff on its `diff --git` boundaries and withholds the body of a secret file while keeping the header, so a review still knows the file changed without seeing its contents. `isSecretFile` is re-exported from `transfer-context.mjs` under its existing name.
- A 400,000-character cap on the review payload. Truncation is announced **inside the content**, so the model reports it rather than silently reviewing half a diff — the failure mode fixed for empty reviews in 0.6.4 applied to oversized ones too.

### Known limits
- Detection is filename-based. A credential pasted into an ordinary source file is not redacted on any path, and this is not a secret scanner.

## 0.12.0 — 2026-08-04 — Auto-routing checks credentials, not just presence

### Fixed
- **`auto` no longer selects an installed-but-unauthenticated Gemini CLI.** It picked gemini on `--version` success alone, so on any machine whose Gemini access has lapsed — the norm since Google ended consumer CLI access on 2026-06-18 — every `auto` command failed on auth while a working AGY sat beside it. Auto now requires the same "installed AND authenticated" condition `/gemini:setup` already reports as `geminiReady`. An explicit `--engine gemini` is unchanged: the check is a routing heuristic, not an authorization gate.
- **`auto` distinguishes "no engine installed" from "gemini installed but unauthenticated"**, because the fix differs and the second case previously surfaced as a confusing downstream API error.

### Changed
- The comment justifying gemini-first routing claimed AGY "responses and conversation ids still depend on transcript recovery". That stopped being true in v0.11.0; the rationale is now stated accurately — gemini's remaining edge is its model aliases and effort-to-model mapping, neither of which applies to an unqualified `auto`.
- `getGeminiLoginStatus` and `getGeminiPlanTier` moved to `lib/gemini-auth.mjs` so `engine.mjs` can consult credentials without an import cycle. Both are re-exported from `lib/gemini.mjs` under their existing names.
- `GEMINI_API_KEY` / `GOOGLE_API_KEY` now count as a credential for routing purposes; an API-key user has no `oauth_creds.json` and must not be read as unauthenticated.

### Added
- Auto-routing had **no test coverage at all** — which is why this defect shipped. `detectEngine` accepts `binaryAvailableImpl` and `hasGeminiCredentialsImpl` (matching the existing `resolveBinaryPathImpl` seam), and five tests now pin every branch of the decision.

## 0.11.1 — 2026-08-04 — Testable engine-response path

### Changed
- `runGeminiTurn` and `runGeminiReview` accept an optional third argument, `{ runCommandFn, detectEngineFn }`, mirroring the `{ spawnFn, detectEngineFn }` seam `dispatchBackgroundTask` already uses. No behavior change: both default to the real implementations.
- Envelope handling moved from spawn-driven fixtures to `tests/agy-envelope.test.mjs`, which injects those dependencies. Those cases previously could not run on Windows at all — the AGY stand-in there must be an absolute `.exe` (CVE-2024-27980), so a copied `node.exe` is used and cannot report a chosen AGY version. Two spawn tests remain to cover what unit tests cannot see: real argv reaching a process, and the transcript genuinely being read on AGY 1.1.7.

### Added
- Envelope coverage that did not exist before: an unrecognized `status` is treated as failure rather than rejected as malformed, stdout that is not an envelope reports `invalid-json`, and the review path's findings-JSON-inside-the-envelope-response nesting is asserted directly.

## 0.11.0 — 2026-08-04 — AGY native JSON envelope replaces transcript scraping

### Changed
- **AGY 1.1.8 and newer now take the response, conversation ID, and terminal status from `--output-format json`.** The on-disk transcript is not read at all on those versions, and no brain root is required — `/gemini:setup` and every AGY command work on a machine that has never run `agy` interactively. This removes the conversation-directory diffing that had to guess which directory belonged to the current run, along with the "transcript match is not certain" warning that guessing produced.
- **AGY results no longer include a reasoning-summary section.** The envelope reports a `thinking_tokens` count but carries no thinking text, and `stream-json` does not either (verified on 1.1.10: its step types are `user_input`, `unknown`, `agent_response`, `checkpoint`). The Gemini engine is unaffected — it takes its reasoning summary from stderr.
- **AGY failures classify better.** A `status: "ERROR"` envelope feeds its `error` string to the failure classifier, which already recognizes rate-limit and model-unavailable wording. Previously only stderr was visible, and AGY leaves stderr empty on this path.

### Fixed
- The `detectEngine` gate that refused to start AGY without a transcript brain dir now applies only below 1.1.8, where the transcript really is the only source for the response and conversation ID.

### Compatibility
- AGY below 1.1.8 keeps transcript recovery unchanged; `agy-transcript.mjs` and its 12 tests are untouched. A regression test pins AGY 1.1.7 to the transcript path and asserts it never receives `--output-format`.
- `conversation_id` from the envelope is byte-identical to the brain-directory name previously used as the thread ID, so stored job thread IDs and `agy --conversation <id>` resume commands are unaffected.

## 0.10.2 — 2026-08-04 — AGY 1.1.9/1.1.10 behavior alignment

### Fixed
- **AGY `--model` / `--effort` are now gated at 1.1.10, not 1.1.5.** AGY's 1.1.10 release notes record that both flags were applied after model configuration had already been initialized, so headless `-p` runs through 1.1.9 silently fell back to the persisted or default model. The plugin previously advertised support from 1.1.5 and forwarded a selection those versions ignored. Requests on 1.1.5–1.1.9 are now refused with an upgrade message instead of reporting a selection the run will not honor.
- **AGY invocations pass `--disable-slash-commands` on 1.1.9 and newer.** AGY 1.1.9 added slash-command and skill expansion to print mode. Task prompts are raw user text at position 0, so a request such as `/gemini:rescue /clear the cache logic` would have executed AGY's `/clear` instead of being read as instructions. The flag is omitted on older AGY, where it does not exist.

### Changed
- The three AGY version predicates share one `agyVersionAtLeast` comparison instead of repeating the parse; prerelease builds still fail closed.
- Version-specific wording removed from two errors that are not version-specific: the `--model` + `--effort` combination refusal, and the same refusal in `transfer`.
- `docs/adapter-contract.md` records both the 1.1.10 selection gate and the 1.1.9 slash opt-out.

## 0.10.1 — 2026-08-04 — `/gemini:transfer` command registration fix

### Fixed
- **`/gemini:transfer` is now actually registered as a slash command.** It shipped in 0.10.0 as `commands/transfer.json`, a format Claude Code's command loader ignores, so the command never appeared in `/plugin` and `scripts/transfer.mjs` had no entry point. Replaced it with `commands/transfer.md` following the same contract as every other command in this plugin: `disable-model-invocation: true`, `allowed-tools: Bash(node:*)`, a quoted `"$ARGUMENTS"` invocation, and explicit output-handling rules.
- **`transfer` now parses the quoted `"$ARGUMENTS"` string the slash command passes it.** It previously assumed a pre-split `argv`, which would have left `--engine`, `--model`, and `--effort` unparsed inside the instructions text. It now shares `normalizeArgv` + `parseArgs` with `gemini-companion.mjs` and rejects an unknown `--engine` value with the same message as the engine detector.

### Changed
- `normalizeArgv` moved from `gemini-companion.mjs` into `scripts/lib/args.mjs` so both entry points use one definition.
- `transfer.mjs` now guards its self-invocation with the `process.argv[1] === SELF_PATH` comparison already used by `gemini-companion.mjs` and `gemini-mcp.mjs`, instead of a loose filename suffix match.
- Command-contract tests now fail on any non-Markdown file in `commands/`, which is the defect class that hid this bug, and `transfer` is a required command in `verify-contracts`.

## 0.10.0 — 2026-08-04 — Session transfer command & AGY 1.1.10 updates

### Added
- **`/gemini:transfer` session handoff command.** Introduced `/gemini:transfer` to export workspace context (git status, diff, instructions) into a structured JSON snapshot and generate single-quoted POSIX Bash and Windows PowerShell launch commands for AGY or Gemini CLI. Includes secret redaction (`.env*`, `.npmrc`, `.p12`, `.key`, `id_rsa`), git conflict locking, per-file diff truncation, and automated `.omc/transfers/` LRU pruning (keeps latest 20 snapshots).
- **AGY 1.1.10 release alignment.** Documented Application Default Credentials (ADC) & Gemini Enterprise / WIF authentication options and the read-only `.git` sandbox rule in README documentation.

### Fixed
- **The MCP rescue parity test no longer depends on a locally installed Gemini CLI.** It now injects the runtime's existing engine-detection seam for both dispatch paths, so CI verifies byte-identical job prompts independently of developer-machine binaries.

## 0.9.0 — 2026-07-22 — AGY model and effort selection

### Changed
- **AGY 1.1.5 model or reasoning selection is now supported.** Task, review, and adversarial-review validate a selected engine before starting background work, then forward one of AGY's native `--model` or `--effort` flags. AGY model selection requires an exact ID from `agy models`; Gemini aliases fail before spawn, AGY accepts only `low|medium|high`, a model-plus-effort combination fails before spawn, and `--model` is rejected for a dual-engine review because model IDs are engine-specific. AGY versions below stable 1.1.5 reject these options with an upgrade message. Gemini's existing aliases, effort-to-model mapping, and fallback behavior are unchanged.

### Documentation
- Corrected the installation and update guidance: third-party marketplaces do not auto-update by default; this versioned plugin is updated only when its resolved manifest version changes; an update reported during a running session still requires `/reload-plugins`; and a tag-pinned marketplace remains pinned until it is removed and re-added at another tag. No runtime behavior changed.
- Corrected the AGY model-selection limitation: AGY 1.1.5+ now supports either an exact `agy models` ID or native `low`, `medium`, or `high` reasoning effort, with the documented engine-specific constraints.

## 0.8.0 — 2026-07-15 — First-class AGY and Git hardening

### Security
- **Git helpers no longer route repository-derived arguments through a Windows shell.** Every call in `lib/git.mjs` now forces `shell:false` after caller options, so auto-detected refs are passed as literal argv and cannot be reinterpreted by `cmd.exe`. A cross-platform regression creates a valid default ref containing `&`, places an adjacent command probe on `PATH`, and verifies branch target detection and diff collection complete without executing the probe. The test helper now honors an explicit `shell` override. ([#18](https://github.com/arcobaleno64/gemini-plugin-cc/issues/18))

### Changed
- **AGY is documented and reported as a first-class supported engine.** Gemini CLI and AGY are conditional dependencies: users install the CLI for the engine they select, while `auto` keeps capability-based Gemini→AGY ordering because Gemini exposes the plugin's JSON/model contract. Setup now permits the official `curl` installer without incorrectly requiring npm; runtime labels, skills, failure guidance, attribution, and the English/Traditional Chinese READMEs no longer describe AGY as an optional or lower-tier fallback.
- **AGY authentication status is now honest.** AGY 1.1.x uses an independent `consumerOAuth` flow whose state cannot be inferred from Gemini's `~/.gemini/oauth_creds.json`. `getAgyLoginStatus()` now returns `state:"unknown"` and `verifiable:false` for an installed AGY binary, instructs users to run `agy` interactively, and never claims the shared Gemini credential proves AGY login. The existing `loggedIn` and `agyFallbackAvailable` fields remain for JSON compatibility; consumers should use `agyAuth.state`, and the additive `agyAvailable` field carries the support-neutral availability signal.

### Documentation
- Added the AGY 1.1.2 macOS/Linux validation checklist and Ubuntu 24.04 WSL2 live evidence for stdin/stdout, foreground task, background task, structured review, invalid-model failure, OAuth TTY/headless behavior, transcript pairing, and the complete Linux test suite. Real macOS 1.1.2 remains explicitly `OPTIONAL / NOT RUN` as a platform-validation gate, not an indication that the AGY engine itself is optional.
- Updated the AGY prompting anti-patterns to distinguish older positional `--print` behavior from the 1.1.2 stdin auto-print path while retaining transcript-authoritative recovery.

### Tests
- The complete Windows suite passes: 238 tests, 235 passed, 0 failed, with 3 POSIX-only AGY fixtures skipped as expected. A real local AGY 1.1.2 `setup --engine agy` smoke reports `agyAvailable:true`, `authState:"unknown"`, and `authVerifiable:false` without reading or exposing credentials.

### Compatibility
- No slash-command flags, engine names, permission policy, transcript recovery, timeout, or task/review result structure changed. Gemini-only and AGY-only installations remain valid; installing both CLIs is not required.

## 0.7.1 — 2026-07-14 — AGY stdin transport

### Changed
- **AGY 1.1.2 and newer now receive prompts on stdin.** The adapter parses `agy --version` and, only for a stable version at or above 1.1.2, omits both `--print` and the prompt from argv so AGY auto-enters print mode from piped input. Older, prerelease, and unparseable versions fail closed to the existing `agy --print <prompt>` path. The 24,000-character and NUL preflight checks now apply only to that positional fallback. Windows still requires an absolute `.exe` and `shell:false`; `--print-timeout`, `--continue`, `--new-project`, and `--dangerously-skip-permissions` behavior is unchanged. (`lib/engine.mjs`, `lib/gemini.mjs`)
- **Transcript recovery remains authoritative.** Both task and review still snapshot the AGY brain directory and use the completed transcript for response text, DONE status, thinking, and conversation ID. Stdout is retained for diagnostics but does not replace the transcript contract, and the 105-second print / 120-second hard timeout strategy remains unchanged. (`lib/agy-transcript.mjs`)

### Tests
- Added version-boundary and argv tests for AGY 1.1.1 versus 1.1.2, including a prompt above the old 24,000-character positional limit. A POSIX fake AGY executable records argv/stdin, emits a conflicting stdout decoy, and writes a DONE transcript to cover task, review, legacy fallback, and transcript precedence. Existing task/review stderr-without-transcript regressions remain in place; Windows is covered by the AGY 1.1.2 live smoke described below.

### Validation
- **AGY 1.1.2 on Windows:** a foreground read-only task completed in 14 seconds and a background task in 13 seconds; both returned their unique marker, no touched files, and a conversation ID that matched a completed on-disk transcript. A one-line synthetic working-tree review completed in 26 seconds, returned structured JSON, and identified the planted wrong-operator defect. A direct invalid-model invocation used stdin with no `--print`, exited 1 in 1.7 seconds, wrote no stdout, and returned a non-empty stderr error plus the available-model list. A larger 53 KB review prompt reached a new transcript but produced no planner response before the existing 105-second print / 120-second hard timeout, which surfaced as `transcript-missing`; this confirms the transport while retaining the documented review-size/time boundary. Real credentials were not revoked, so the upstream OAuth fail-fast path remains documentation-backed rather than live-tested.

## 0.7.0 — 2026-07-14 — MCP bridge and AGY resilience

### Added
- **F-CC1: hand-rolled stdio MCP server.** Added `gemini_rescue`, `gemini_review`, `gemini_job_status`, `gemini_job_result`, and `gemini_job_cancel` as thin JSON-RPC wrappers over the existing companion dispatch, job-control, and state paths. The plugin now declares the server through `.mcp.json`; MCP and CLI background dispatch share the same persisted request construction so prompt assembly cannot drift.
- **F-CC2: parallel blind adversarial review.** `/gemini:adversarial-review --engines gemini,agy` now queues prompt-identical background jobs with one shared group ID, aggregates both engines in `/gemini:status` and `/gemini:result`, and degrades to the available engine with an explicit stderr warning when only one requested CLI is usable.

### Fixed
- **AGY 1.1.2 server-side failures now preserve actionable stderr when transcript recovery has no response.** The task and review runners no longer throw a transcript-only generic error before classifying AGY's non-zero exit. They now pass the exit status, signal, spawn error, stdout, stderr, and transcript reason through the existing failure classifier, so authentication, quota, rate-limit, and model errors take precedence while unknown failures still fall back to the transcript category. Completed transcript responses remain authoritative, and transcript recovery is unchanged. Added isolated fake-AGY runtime coverage for both task and review plus a classifier-precedence regression test. (`lib/gemini.mjs`)
- **`--engine agy --write` no longer silently writes to AGY's scratch dir instead of the target directory.** Machine-verified on AGY 1.1.0/Windows 2026-07-09: a fresh (non-continuation) `agy --print --dangerously-skip-permissions` write turn with no prior workspace/project association creates files under `~/.gemini/antigravity-cli/scratch/` rather than the spawned `cwd` — silently, with `status: 0` and no error, so a caller only notices by checking the file landed in the wrong place. `buildCliArgs` now appends `--new-project` on a write turn that is not a `--continue` resume, binding the session's workspace to `cwd`; a resumed conversation is left alone since it already has its original project association. New `tests/engine.test.mjs` coverage for the three `buildCliArgs("agy", ...)` flag-composition cases (write, resumed write, read-only). (`lib/engine.mjs`) Re-verified end-to-end post-commit on AGY 1.1.0/Windows 2026-07-10: a fresh `task --engine agy --write` turn completed in 13s (job `completed`, no `request-review` stall) with the probe file landing in `cwd`, not scratch.

### Documentation
- **AGY 1.1.2 compatibility assessment.** Windows machine validation uses AGY 1.1.2 as the current baseline: read-only foreground and background tasks both completed in 15 seconds or less, returned the expected marker, and matched the conversation ID and on-disk transcript. The isolated fake-AGY review regression and the complete 232-test suite also pass. A corrected direct probe confirmed the new auto-print syntax: supplying the prompt on stdin with no `--print` flag exited 0 and returned the marker on stdout; `--print`, `-p`, and `--prompt` still require their own string argument. With that stdin syntax, an invalid `--model` exited 1, wrote a non-empty error plus the available-model list to stderr, and did not silently fall back. The earlier exit-0 observation was a malformed probe where `--print` consumed `--model` as its prompt argument. The upstream changelog also documents OAuth-code input through `/dev/tty` or Windows `CONIN$` when stdin carries the prompt, plus fail-fast behavior when no controlling terminal exists; real credentials were not revoked to retest that path. Plugin v0.7.0 still uses positional `agy --print <prompt>` and keeps transcript recovery authoritative; the stdin transport is deferred to a version-gated adapter change. The nested-command allowlist change mostly does not affect the plugin's `--write` path because it uses `--dangerously-skip-permissions`, while MCP shutdown cleanup helps only when the user's AGY configuration loads MCP servers. The plugin still does not expose AGY `--agent` selection and does not change its `--write` permission flags.
- **AGY 1.1.0 impact assessment.** AGY 1.1.0 (released 2026-07-08) makes `request-review` the default execution mode: it pauses before file writes to show an interactive line-level diff preview. Machine-verified 2026-07-09 that `--dangerously-skip-permissions` still fully suppresses this pause for a headless `--engine agy --write` turn — no `--mode accept-edits` workaround needed. Also confirmed via `agy --help` on 1.1.0 that the four other flags this plugin depends on (`--print`, `--continue`, `--print-timeout`) are unchanged, and via the upstream tracker that [google-gemini/gemini-cli#27466](https://github.com/google-gemini/gemini-cli/issues/27466) (`agy --print` empty stdout) remains open as of 2026-06-23, so `agy-transcript.mjs`'s transcript-recovery path is still required. The `/agents` panel global-config-dir fix in 1.1.0 (`~/.gemini/antigravity-cli/` → `~/.gemini/config/`) targets subagent definitions, not the transcript "brain" root this plugin reads — no path change there.
  - **Known limitation found, not yet fixed: `getAgyLoginStatus()` is stale for AGY 1.1.0.** It infers AGY's login state from the shared gemini CLI credential file (`~/.gemini/oauth_creds.json`), per a comment asserting "AGY stores no credential of its own." That is no longer true: AGY 1.1.0's `cli.log` shows a distinct `consumerOAuth` flow ("You are not logged into Antigravity" / "authenticated successfully as ...") that is independent of the gemini CLI's OAuth state and is established by running `agy` interactively, not `gemini`. Machine-verified 2026-07-09: `~/.gemini/oauth_creds.json` stayed untouched (and reported "expired") through two `gemini`-driven logins, while `agy --print` failed with `authentication failed or timed out` until the user logged in via `agy` directly — after which the shared-credential-based status function would still have reported AGY as logged out. Where AGY 1.1.0 persists its own token was not located (not a plaintext file under `~/.gemini` or `%APPDATA%`/`%LOCALAPPDATA%`; likely OS credential storage), so `getAgyLoginStatus()` was left as-is rather than patched with an unverified detection heuristic.
- **macOS AGY is now platform-verified.** On macOS (agy 1.0.7) the AGY brain root is `~/.gemini/antigravity-cli/brain` — the same path already first in `agyBrainRoots()` — so `--engine agy` works out of the box: `gemini-companion.mjs task --engine agy` was run end-to-end on macOS and recovered the response from the transcript (`<conv>/.system_generated/logs/transcript{,_full}.jsonl`, matching the expected layout), and the upstream no-pipe behavior of `agy --print` ([google-gemini/gemini-cli#27466](https://github.com/google-gemini/gemini-cli/issues/27466)) was reproduced on macOS (0 bytes reach stdout through a pipe), confirming transcript recovery is required there too. Updated README (EN + zh-TW) Engine Routing / Troubleshooting / Known limitations, the `gemini-prompting` antipatterns reference, and the `agy-transcript.mjs` platform notes; TODO-3 (platform paths) is resolved, and the "no brain root" reason string now tells the user to run `agy` once instead of pointing at an internal TODO. No behavior change — comments, docs, and one user-facing message only.
- **README install snippets and dependency table refreshed to the current release.** Pinned-install examples now reference the latest tag `v0.6.6` (was the stale `v0.6.0`), the "newer tag" example bumped to `v0.6.7`, and the AGY dependency row reads `≥ 1.0.3` (1.0.7 verified on macOS). Docs only, no behavior change.

## 0.6.6 — 2026-06-09 — review retry resilience

### Fixed
- **Transient gemini review failures are now retried.** The gemini CLI intermittently returns an empty / `Invalid stream: ...malformed tool call` envelope (or a transport-level rate-limit / unavailability) for an otherwise-valid request; previously a single such flake surfaced to the caller as a parse error and forced a manual re-run (observed needing 2–3 attempts for the same input in practice). `/gemini:review` and `/gemini:adversarial-review` now call `runGeminiReviewResilient`, which re-runs a **read-only** review up to 3 times when the result is transient (empty stdout+stderr, or an `Invalid stream` / `malformed tool call` / `resource_exhausted` / `unavailable` / `5xx` / `429`-class signal with no parseable findings). A review that yields structured findings — or real, non-transient prose — is **never** retried (read-only reviews are idempotent, so the retry is side-effect-free); `agy` is never retried (its transcript-recovery path and fail-fast 2-min timeout handle its distinct failure mode). This composes with the existing GA-fallback retry (model-not-found, fixed within one attempt) rather than replacing it. The transient signal is matched **by channel** to avoid false positives: the malformed-output envelope on either stream, but loose transport words (`unavailable`, `rate limit`, `5xx`, …) only on stderr — so a review whose prose happens to discuss an HTTP status code is not mistaken for a flake; as a backstop, identical non-empty review text across attempts is treated as deterministic output and kept rather than retried. New helper `isTransientReviewFailure`, fixture scenario `review-transient-then-clean`, and regression tests.

## 0.6.5 — 2026-06-04 — low-severity cleanup

### Fixed
- **`/gemini:cancel` no longer claims a kill it did not make.** The detached worker is `unref()`-ed, so by cancel time its PID is often already gone; `handleCancel` discarded `terminateProcessTree`'s return value and always logged "Cancelled by user." It now reports the real outcome — `terminated the running process`, `no live process (it had already exited)`, or `no live process was attached` — in the log, the `# Gemini Cancel` report (a new `- Process:` line), and a new `processTerminated` field on the `--json` payload. The job is still marked `cancelled` in every case (the user's intent is recorded). New shared `describeTermination` helper. (`gemini-companion.mjs`, `lib/render.mjs`)
- **Narrowed the reasoning-noise `[DEP\d+]` filter.** `REASONING_NOISE` matched a bare `[DEP12]` token anywhere, which could strip a genuine reasoning line that merely contained such a bracket. It now requires Node's canonical `(node:NNN) [DEPxxx]` preamble, so real deprecation warnings are still filtered while legitimate reasoning survives. (`lib/gemini.mjs`)

### Tests
- 168 → 172: honest `/cancel` outcome (render-level wording for all three states + a no-pid integration case asserting `processTerminated:false`), the narrowed DEP filter (a `[DEP12]` reasoning line survives while a real `(node:…) [DEP0190]` line is filtered), and a multi-line focus-text round-trip through the background `review-worker`.

### Documentation
- README (EN + zh-TW): added a **Known limitations** section consolidating the documented, non-blocking constraints (macOS AGY unverified, Gemini 3.5 not served by the CLI + 2026-06-18 free-CLI sunset, `/review` prompt-adapter vs native reviewer) with cross-links to the detailed sections.

## 0.6.4 — 2026-06-04 — empty-diff review guard

### Fixed
- **Background review of a clean/empty diff no longer passes vacuously.** `executeReviewRun` now short-circuits when the resolved review target has no changes — a working tree with nothing staged/unstaged/untracked, or a branch diff with no commits and an empty patch — returning an explicit `empty: true` / `result: null` payload rendered as `Nothing to review — <target> has no changes.` instead of asking Gemini to review an empty diff (which it rubber-stamps as "approved"). This closes the v0.6.1-audit gap where a detached `--background` review re-resolved the diff at run time and, if the tree was clean when the worker started, silently persisted a vacuous approve only visible at `/gemini:result`. The foreground and background paths share `executeReviewRun`, so both are covered, and the stop-review-gate stays non-blocking on an empty result (`result: null` → verdict is not `needs-attention`). New `isEmpty` flag on the working-tree/branch review context. (`lib/git.mjs`, `gemini-companion.mjs`)

### Tests
- 166 → 168: an empty working tree review surfaces "nothing to review" without invoking Gemini (the fake-gemini state file is never written); a `--json` empty review carries `empty:true` / `result:null` so the gate proceeds. The pre-existing "adversarial review forwards focus text" test now diverges onto a feature branch so `--base main` resolves to a non-empty diff — it previously exercised the empty-branch-diff path this fix targets.

## 0.6.3 — 2026-06-02 — reasoning-noise filter fix

### Fixed
- **True-color terminal warning leaked into review "Reasoning:".** `REASONING_NOISE` (`lib/gemini.mjs`) only matched the `256-color` terminal-capability warning, but gemini CLI 0.44.1 emits the `True color (24-bit) support not detected` variant. That line matched none of the patterns, so `extractReasoningSummary` kept it and it surfaced as a bogus model-reasoning bullet in review output. Added a `/true color/i` pattern. (The DEP0190 lines seen alongside it during diagnosis were the parent process's own deprecation warning surfaced via a `2>&1` redirect, **not** a filter failure — the v0.6.1 DEP0190 filter works correctly on the subprocess stderr it targets.)

### Tests
- Extended the `review-noisy` fixture/test: it now emits the true-color line on stderr and asserts genuine reasoning still surfaces (`Considering empty-state`) while the true-color warning is filtered out. 166 tests pass.

## 0.6.2 — 2026-06-02 — model resilience, agentic review, transparency

### Added
- **Graceful model-not-found fallback.** If a requested model id is not served by the local gemini CLI (a preview/retired id, or CLI-version skew — e.g. `gemini-3.5-flash` returns 404 on CLI 0.44.1), the plugin retries the run **once** on the GA fallback `gemini-2.5-flash` and shows a visible banner instead of hard-failing. Applies to `/gemini:review`, `/gemini:adversarial-review`, and `/gemini:rescue`; the AGY path is unaffected. (`lib/gemini.mjs`)
- **`--deep` agentic review.** `/gemini:review` and `/gemini:adversarial-review` accept `--deep`, which invites Gemini to use its read-only tools to inspect repo context beyond the diff (dependency manifests, untracked files, callers) before producing the same JSON findings — closing the harness gap versus a native agentic reviewer. The default stays the fast, diff-scoped single-shot review (no behavior change). Verified live: `--deep` flags an undeclared dependency that the diff-scoped review cannot see.
- **Stop-review-gate hook test coverage** (3 deterministic tests: disabled → silent; enabled with no write task → proceed; review-failure → fail-open with a visible warning).
- **`docs/MODEL_COMPARISON.md`** — empirical model-vs-harness comparison and the local model-availability reality; **`docs/PARITY_AUDIT_v0.6.1.md`** — the v0.6.1 re-score.

### Changed
- `model-map`: `lite3` → `gemini-3.1-flash-lite` (verified GA id; drops the `-preview` suffix). Metadata records that Gemini 3.5 is GA on the API but not served by the gemini CLI 0.44.1 (reach it via AGY).
- README (EN + zh-TW): added a 2026-06-18 free-CLI-sunset heads-up, the Gemini 3.5 availability reality (CLI 404 → use AGY), the graceful-fallback note, and `--deep` documentation — so user expectations match reality.

### Tests
- 159 → 166 (model-not-found fallback for review + rescue; `--deep` prompt injection on/off; stop-gate hook coverage).

## 0.6.1 — 2026-06-02 — parity-audit follow-up fixes

### Fixed (P0)
- **`/gemini:rescue` resume prompt never fired.** `handleTaskResumeCandidate` emitted `found`, but `commands/rescue.md` keys the "continue current thread?" prompt off `available` (as upstream codex does). The companion now emits `available` in all branches; a contract guard test asserts `available` is present and the legacy `found` is gone.

### Added (P1)
- **Persistent background reviews.** `/gemini:review --background` and `/gemini:adversarial-review --background` now enqueue a detached `review-worker` (mirroring `task-worker`) instead of relying on Claude-layer `run_in_background`, so a background review result survives an interrupted session and is retrievable via `/gemini:status` / `/gemini:result`. New `review-worker` subcommand; `enqueueBackgroundJob`/`spawnDetachedWorker`/`runStoredJobWorker` generalize the shared machinery.

### Fixed (P1)
- **Stop-review-gate is no longer silent on skip.** On review failure / Gemini-unavailable the gate still fails open, but now surfaces a `systemMessage` + stderr warning so the user knows the gate was skipped. It also reviews `--scope working-tree` explicitly (where `--write` task edits live) instead of relying on auto scope.
- Removed dead `renderNativeReviewResult` from `lib/render.mjs`.

### Fixed (P2)
- **Standard `/gemini:review` mislabeled its progress as "adversarial review".** `runGeminiReview` is now mode-aware (`isAdversarial`).
- **CLI noise leaked into the "Reasoning:" output.** `extractReasoningSummary` now drops DEP0190 deprecation, 256-color, and ripgrep-fallback lines before the last-N slice.
- **Preview-model drift is now visible.** `/gemini:setup` reports the model-alias count, how many resolve to `*-preview` IDs, and the `lastVerified` date.

### Documentation
- README (EN + zh-TW): clarified that `agy --print` is locked to Gemini 3.5 Flash (High) and ignores `--model`/`--effort` (was incorrectly described as interactive selection); noted the DEP0190 warning is benign; documented that AGY transcript recovery is verified on Windows/Linux only (macOS unverified).
- Added `skills/gemini-prompting/references/` (blocks, recipes, anti-patterns), matching upstream `gpt-5-4-prompting`.

## 0.6.0 — 2026-06-01 — parity audit

### Breaking
- **`/gemini:setup` readiness now requires authentication.** `ready` is `true` only when Node **and** the Gemini CLI are present **and** OAuth is valid. An installed-but-unauthenticated Gemini now reports `ready: false` (previously `true`). New JSON fields: `readyState` (`ready` | `partial` | `not-ready`), `geminiReady`, `agyFallbackAvailable`.

### Fixed (P0)
- **Review target was discarded.** `/gemini:review` and `/gemini:adversarial-review` now honour `--base <ref>` and `--scope <auto|working-tree|branch>`; `executeReviewRun` previously re-resolved the target with empty options, silently dropping the user's selection.
- **Contradictory verbatim contract.** Removed the "STOP and ask which issues to fix" instruction from `review.md` / `adversarial-review.md`, which conflicted with the "return stdout verbatim" rule.
- **AGY install was over-eager.** `setup.md` now installs Gemini CLI as the primary engine and only prompts for AGY when the user passes `--engine agy`. Auth guidance is unified on running `gemini` (there is no `gemini login` subcommand).

### Fixed (P0 — post-audit, local-verified on agy 1.0.3 / gemini 0.44.1)
- **AGY install command was wrong (4 sites).** `npm install -g agy` installs an unrelated npm package; replaced with the official installer `curl -fsSL https://antigravity.google/cli/install.sh | bash` in `README.md`, `README.zh-TW.md`, `commands/setup.md`, and the `gemini-companion.mjs` setup hint. AGY version baseline pinned to `1.0.3`.
- **AGY silent 10-minute hang.** Local verification showed `agy --print` does not deliver its response over a pipe in non-interactive (non-TTY) use — it returned empty stdout or hung to its print-timeout under the exact piped spawn the plugin uses, while `gemini -p --output-format json` piped a clean JSON envelope every time. AGY's spawn timeout is now capped at 2 min (was 10) in `runGeminiTurn`/`runGeminiReview` so it fails fast instead of hanging, and `getAgyLoginStatus` reports the limitation honestly (and no longer reads the non-existent `status.version` field).
- **engine.mjs auto-branch comment corrected, not deleted.** The note that AGY cannot pipe output non-interactively is accurate (verified), so it was made precise rather than removed; gemini stays the preferred auto engine.

### Not done (local evidence overrode the audit prompt)
- **AGY-first auto routing for personal plans was NOT implemented.** The audit asked for it, but because `agy --print` does not pipe output, defaulting delegation to AGY would make tasks silently fail or hang. Auto-detection keeps gemini first; `--engine agy` / `GEMINI_ENGINE=agy` still force AGY for callers who explicitly want it.
- **Model-id / ListModels reconciliation deferred (needs API key).** `gemini` was confirmed to pipe a valid JSON envelope and to auto-route `gemini-2.5-flash-lite` → `gemini-3.1-flash-lite`; the `flash` alias marketing-name vs API-id check still requires the Generative Language API ListModels endpoint and is left untouched, flagged in `model-map.mjs`.

### Changed (P0-E — AGY transcript mode, v4)
- **AGY recovers its response from the on-disk transcript (#27466 workaround).** `agy --print` never writes its response to stdout under a pipe (upstream bug google-gemini/gemini-cli#27466), so `runGeminiTurn`'s agy branch no longer reads stdout: it snapshots agy's conversation ("brain") dirs before the spawn, then diffs them afterwards and reads the new conversation's `transcript_full.jsonl`/`transcript.jsonl`, returning the last `PLANNER_RESPONSE` row's `content` (with `thinking` as the reasoning summary and `convDir` as the resumable conversation id). New module `scripts/lib/agy-transcript.mjs`.
- **Fail-loud, never silent-empty.** If transcript recovery yields nothing, `runGeminiTurn` throws (citing #27466) instead of returning an empty result. `detectEngine` also refuses an explicit `--engine agy` early when no transcript brain dir exists on this platform (otherwise it permits agy and the transcript path handles it).
- **TODO-3 timeout grace.** agy's own `--print-timeout` is now set ~15 s shorter than the hard spawn kill so agy self-terminates and flushes a final `status:"DONE"` transcript row before `spawnSync` SIGKILLs it; success is judged by that row, not the (often killed) exit code.
- **Local verification (agy 1.0.3, Windows):** transcript path `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`; `agy --conversation <fresh-uuid>` does NOT pin a self-generated id (antigravity-cli#7 open), so a set-diff is used rather than a known id. `agy --print` is hardcoded to Gemini 3.5 Flash (High) with no model/effort flag — the ignore-note now states this explicitly. End-to-end proof: `task --engine agy` returned the transcript-recovered answer with empty agy stdout.
- **`getAgyLoginStatus` now checks real auth.** AGY stores no credential of its own (verified: no oauth/token file under any `~/.antigravity*` or `~/.gemini/antigravity-cli` dir) and runs off the same Google OAuth as the gemini CLI, so login status is now gauged from that shared `~/.gemini/oauth_creds.json` (presence + expiry) instead of mere binary presence.
- **Personal-plan 2026-06-18 EOL warning.** New `getGeminiPlanTier()` reads `~/.gemini/settings.json` (`security.auth.selectedType`); `setup` now appends a heads-up for `oauth-personal` plans that gemini CLI free access ends 2026-06-18, pointing to Gemini Code Assist Standard/Enterprise or the AGY transcript path. Enterprise/unknown tiers stay silent. New JSON field `geminiPlanTier`.
- **`runGeminiReview` agy path now uses transcript recovery too.** The adversarial/standard review path mirrors `runGeminiTurn`: for agy it snapshots brain dirs, applies the timeout grace, recovers the review text from the transcript (parsing the JSON findings out of it), and fails loud if nothing is recoverable — instead of reading the always-empty stdout (#27466).
- **`model-map.mjs` states the AGY model lock explicitly.** The effort-tier comment now records that AGY's `--print` is hardcoded to Gemini 3.5 Flash (High) with no model/effort flag, so tiers apply to the gemini engine only.

### Changed (P2 — engine-aware resume display)
- **`/gemini:result` (and job status) now show the correct per-engine resume command.** gemini jobs show `Gemini session ID` + `gemini --resume <id>` (the old hint used a non-existent `gemini resume` subcommand); AGY jobs show `AGY conversation ID` + `agy --conversation <id>` (the verified resume flag). The resolved engine is persisted on each completed job (`engine` field in the job record), and `render.mjs` derives the hint from it.

### Added (P1)
- **Claude session job filtering.** `/gemini:status --all` now crosses sessions (default stays scoped to the current Claude session); resume-candidate and active-task checks respect the session boundary.
- **Single source of truth for models.** New `scripts/lib/model-map.mjs` holds aliases + effort tiers + provenance (`lastVerified`, `source`, preview flags); the README table is verified against it.
- **Contract verification.** New `scripts/verify-contracts.mjs` (`npm run verify-contracts`) and ported `scripts/bump-version.mjs` (`npm run check-version` / `bump-version`). CI now runs `npm test`, `check-version`, and `verify-contracts`.
- `getSessionRuntimeStatus` now returns a `label`/`mode` so setup/status no longer render `session runtime: undefined`.

### Tests
- 90 → 117 tests. New coverage: `--base`/`--scope` divergence, setup readiness (auth missing/expired/AGY-fallback), session filtering, stdin prompt safety (metacharacter matrix), stderr-does-not-pollute-JSON, model-map/README consistency, and contract/version verification.

### Documentation
- README (EN + zh-TW): Compatibility Matrix, Codex app server vs Gemini CLI adapter, expanded Security Notes, Setup & Auth Troubleshooting, Model Alias Notes, and Upstream Attribution.

## 0.5.0 — 2026-05-27

### Added
- `/gemini:review` — standard (non-adversarial) code review; finds real bugs, missing error handling, and incomplete paths.
- `prompts/review.md` — pragmatic reviewer prompt template (same JSON output schema as adversarial-review).
- Review Gate fully implemented: `stop-review-gate-hook.mjs` now runs `adversarial-review` before session end when any `--write` task completed; blocks with finding summary if verdict is `needs-attention`.
- `/gemini:setup --enable-review-gate` / `--disable-review-gate` flags to toggle the gate without editing config JSON.
- `setup` output now includes `review gate: enabled/disabled` status.

### Fixed
- `buildSetupReport` now reads `reviewGateEnabled` from config and passes it to `renderSetupReport` — previously always rendered as "disabled".
- `commands/result.md` now mentions `/gemini:review --wait` in follow-up suggestions.

### Documentation
- README: `/gemini:rescue` flags table now includes `--fresh` (force new session).
- README: `/gemini:result` section now explains the `Resume in Gemini: gemini resume <session-id>` output.
- README: new Review Gate section with enable/disable instructions.

## 0.4.0 — 2026-05-27

### Added
- Gemini 3.x model aliases: `flash`/`flash3` → `gemini-3.5-flash` (GA), `pro`/`pro3` → `gemini-3.1-pro`, `lite3` → `gemini-3.1-flash-lite`.
- Backward-compat aliases `flash25` → `gemini-2.5-flash`, `pro25` → `gemini-2.5-pro`.
- `effort` mapping updated: `low`/`medium` → `gemini-3.5-flash`, `high`/`xhigh` → `gemini-3.1-pro`.
- `task-resume-candidate` now guards against active/queued tasks (mirrors `resolveLatestTrackedTaskThread` guard).

### Fixed
- `renderSetupReport` was reading `report.auth.detail` (field does not exist); corrected to `report.geminiAuth.detail` and `report.agyAuth.detail`.
- `verdict ?? outcome` alias in `validateReviewResultShape` / `normalizeReviewResultData` now uses `||` — `??` failed to fall through when `verdict` was an empty string.
- `detectEngine` was reading `status.version` (field does not exist on `binaryAvailable` return); corrected to `status.detail`.
- `detectEngine` now throws on unknown engine values instead of silently falling back to auto.
- Removed `preview` alias that mapped to the non-existent `gemini-3-pro-preview`.

## 0.3.0 — 2026-05-27

### Added
- Marketplace installation support: `/plugin marketplace add arcobaleno64/gemini-plugin-cc`
- Session ID (`threadId`) extraction from Gemini CLI JSON envelope in task runs — enables `--resume-last` to work correctly.
- `GEMINI_HOME` environment variable support for non-standard credential paths.

### Fixed
- `appendReasoningSection` now accepts both `string` (from `gemini.mjs`) and `Array` — reasoning output was silently dropped before this fix.
- `runCommand` null `status` now resolves to `1` when the process was killed by a signal or failed to spawn, instead of masking failures as exit `0`.
- `marketplace.json` and `plugin.json` updated with correct owner (`arcobaleno64`), repository URL, and version `0.3.0`.
- README installation section updated with proper marketplace workflow.

## 0.2.0 — 2026-05-27

### Fixed
- **P0 Windows ENOENT**: Replaced custom `runSpawn` (`shell: false`) with `runCommand` from `process.mjs` (`shell: true` on Windows), resolving failure to execute `.cmd` wrappers installed by npm.
- **P0 Shell injection**: Gemini CLI prompts are now delivered via stdin (`input` option) instead of the `-p` CLI argument, eliminating shell metacharacter injection on Windows (`shell: true` path).
- **P0 AGY pipe output**: `auto` engine order swapped — `gemini` CLI is now preferred; `agy` is fallback. AGY cannot write to a pipe in non-interactive mode and silently returned empty output as the former default.
- **P1 `task-resume-candidate` missing**: Added `handleTaskResumeCandidate` handler and `task-resume-candidate` subcommand to `gemini-companion.mjs`; previously caused `Unknown subcommand` errors from `gemini:rescue`.
- **P2 OAuth token expiry**: `getGeminiLoginStatus()` now parses `oauth_creds.json` and reports expired tokens before any invocation attempt, rather than only checking for file existence.

### Added
- `runCommand` now accepts `maxBuffer` and `timeout` options (forwarded to `spawnSync`).
- `buildCliArgs` accepts `useStdin` flag; when set for the `gemini` engine, the prompt is omitted from the args array and must be supplied via `input`.
- `README.md` and `README.zh-TW.md` with full command reference, security notes, and architecture diagram.
- `.gitignore` excluding `.omc/` runtime state directory.

## 0.1.0 — 2026-05-26

### Added
- `gemini-companion.mjs` runtime with AGY auto-detect and Gemini CLI fallback
- `session-lifecycle-hook.mjs` for `GEMINI_COMPANION_SESSION_ID` injection on SessionStart/End
- `stop-review-gate-hook.mjs` stub (opt-in via `stopReviewGateEnabled` config)
- Slash commands: `/gemini:setup`, `/gemini:rescue`, `/gemini:result`, `/gemini:status`, `/gemini:cancel`, `/gemini:adversarial-review`
- Skills: `gemini-cli-runtime`, `gemini-prompting`, `gemini-result-handling`
- Agent: `gemini-rescue` — thin forwarder to the companion task runtime
- `hooks/hooks.json` — SessionStart, SessionEnd, Stop hooks
- Engine routing: AGY preferred, Gemini CLI fallback; `--engine agy|gemini` to force
- Model aliases: `flash` → gemini-2.5-flash, `pro` → gemini-2.5-pro, `lite` → gemini-2.5-flash-lite
