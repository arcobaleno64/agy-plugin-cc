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
| Command Injection (CWE-78) | Forced `shell: false` on Git operations | `lib/git.mjs`, `lib/transfer-context.mjs` |
| Argument Injection | Strict regex validation of flags (`--model`) | `lib/engine.mjs` |
| Credential Leakage | Automated secret file redaction (`.env*`, `.pem`, `.npmrc`) | `lib/transfer-context.mjs` |
| Argv Overflow | Transport prompts exclusively via Stdin / JSON payload | `lib/gemini.mjs`, `scripts/transfer.mjs` |
| File Mutation Risks | Gate background file modifications behind explicit `--write` | `scripts/lib/job-control.mjs` |

## 6. Residual Risks & Codex Security Verification Scope
- **Malicious Repository Content Boundary**: Audit edge cases where malformed git diffs or file paths might evade regex filters.
- **State Corruption**: Audit concurrency and state file handling in `.omc/` during multi-job execution.
- **Unsafe Writes**: Verify that `--write` modes strictly respect directory scope and cannot be manipulated into arbitrary file truncation outside the workspace.
