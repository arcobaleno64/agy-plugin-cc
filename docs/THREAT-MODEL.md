# Threat Model: gemini-plugin-cc

This document formalizes the threat model and risk mitigations for `gemini-plugin-cc`.

## 1. Assets
- **Local Credentials**: OAuth tokens stored in user home directories (`~/.gemini/oauth_creds.json`).
- **Workspace Source Code**: Repository files, uncommitted diffs, and developer environment states.
- **Background Job State**: Job output logs and resume IDs stored in `.omc/`.

## 2. Trust Boundaries
1. **User Prompt & Terminal Entry Point** $\rightarrow$ `gemini-plugin-cc` script dispatcher.
2. `gemini-plugin-cc` $\rightarrow$ Subprocess execution of `git`, `gemini`, or `agy`.
3. Subprocess $\rightarrow$ External LLM API endpoints.

## 3. Entry Points & Attack Vectors
- **Malicious Repository Content**: Untrusted repositories containing specially named files (e.g. `--flag-file` or `& calc.exe`) designed to trigger argument/command injection.
- **Prompt Injection**: Untrusted diffs containing prompt injection payloads attempting to bypass read-only discipline during review.
- **Unsanitized Argv**: CLI arguments provided by user slash commands (`--model`, `--effort`, `instructions`).

## 4. Threat Actors
- **Malicious Repository Author**: Provides a repository containing crafted file paths or git metadata.
- **Prompt Injector**: Places malicious instructions inside git diffs or commit messages.

## 5. Existing Mitigations

| Threat | Existing Mitigation | Implementation |
|---|---|---|
| Command Injection (CWE-78) | Forced `shell: false` on Git operations | `plugins/gemini/scripts/lib/git.mjs`, `plugins/gemini/scripts/lib/transfer-context.mjs` |
| Argument Injection | Strict regex validation of flags (`--model`) | `plugins/gemini/scripts/lib/engine.mjs` |
| Credential Leakage | Automated secret file redaction (`.env*`, `.pem`, `.npmrc`) | `plugins/gemini/scripts/lib/transfer-context.mjs` |
| Prompt Transport / Argv Risk | Gemini and AGY 1.1.2+ use stdin; older, prerelease, or unparseable AGY versions use a validated positional fallback with NUL and 24,000-character preflight limits | `plugins/gemini/scripts/lib/gemini.mjs`, `plugins/gemini/scripts/lib/engine.mjs` |
| File Mutation Risks | Gate background file modifications behind explicit `--write` | `plugins/gemini/scripts/lib/job-control.mjs` |

## 6. Residual Risks & Codex Security Verification Scope
- **Malicious Repository Content Boundary**: Audit edge cases where malformed git diffs or file paths might evade regex filters.
- **State Corruption**: Audit concurrency and state file handling in `.omc/` during multi-job execution.
- **Unsafe Writes**: Verify that `--write` modes strictly respect directory scope and cannot be manipulated into arbitrary file truncation outside the workspace.
