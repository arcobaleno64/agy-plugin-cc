<!-- captured: 2026-08-24 | assistant: Codex CLI 0.149.0 (codex exec, default model) | web search: 12 events -->

1. Secret protection is layered, but `/gemini:review` does **not promise blanket redaction of secrets already present in the diff**:

   - Gemini prompts are sent through stdin, not command-line arguments, preventing exposure through process listings or shell expansion.
   - Git refs and validated flags are passed as literal arguments with `shell:false`.
   - OAuth credential files are inspected only for authentication status/expiry; credential values are not logged, copied, or transmitted.
   - Gemini CLI independently redacts secret-looking environment variables when tools run.
   - Automated `.env*` and credential redaction is explicitly documented for `/gemini:transfer`, not as a general guarantee for review diffs.

2. Data minimization comes mainly from review scope:

   - A normal review sends the selected working-tree or branch diff plus the review instructions—not an automatic repository dump.
   - `--base` and `--scope` let callers restrict exactly which changes are included.
   - Broader repository exploration is opt-in through `--deep`; it is explicitly described as higher-token and context-expanding.
   - Review operations are read-only, and AGY 1.1.10+ additionally protects `.git` metadata with read-only sandbox rules.
   - Compact job state excludes prompts, credentials, and raw stderr; job data is stored outside the repository.

3. The practical boundary is important: if a secret is committed or appears in the selected diff, assume it can reach Google during review. Remove or redact it before invoking the reviewer. “Read-only” protects repository state; it does not mean “local-only”—the project explicitly marks review calls as reaching Google.

Source: [gemini-plugin-cc repository documentation](https://github.com/arcobaleno64/gemini-plugin-cc), plus [Gemini CLI’s environment-variable redaction documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md).