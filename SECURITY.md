# Security Policy

## Supported Versions

Only the current MINOR line is supported. Update this table with every MINOR bump.

| Version | Supported |
|---|---|
| 0.17.x | :white_check_mark: |
| < 0.17.0 | :x: |

## Security Model & Trust Boundaries

`gemini-plugin-cc` acts as a local CLI bridge between Anthropic's Claude Code environment and local Gemini/AGY binaries.

### In-Scope Components
- Stdin transport and prompt escaping logic (`plugins/gemini/scripts/lib/gemini.mjs`, `plugins/gemini/scripts/transfer.mjs`).
- Argument validation and flag parsing (preventing flag injection into CLI subprocesses).
- Process boundary security (forcing `shell: false` on Git operations in `plugins/gemini/scripts/lib/git.mjs`, and resolving bare command names to an absolute executable or npm entry script so engine spawns also avoid the shell — `resolveSpawnTarget` in `plugins/gemini/scripts/lib/process.mjs`).
- Secret file redaction filters (`isSecretFile()` and `redactSecretsFromDiff()` in `plugins/gemini/scripts/lib/secrets.mjs`, shared by the review and transfer paths; `transfer-context.mjs` re-exports `isSecretFile` under its original name).
- Background job state directory isolation (`.omc/`).
- **Prompt injection and delegated agency** — the plugin hands repository content it did not author to an agent that can be write-capable. Modelled in [`docs/THREAT-MODEL.md` §7](docs/THREAT-MODEL.md), mapped against the OWASP Top 10 for LLM Applications. Read that section before reporting: the highest-rated item (`/gemini:rescue` defaulting to a write-capable run with no path sandbox) is **known and documented**, not an undisclosed flaw.

### Out-of-Scope Components
- Third-party CLI binary vulnerabilities within Google's `gemini` or `agy` executables.
- Claude Code runtime environment process sandbox boundaries.
- User-managed OAuth token storage inside `~/.gemini/oauth_creds.json` or AGY system keyrings.

### Data Handling

What the plugin sends, keeps, and reads — and the single path that transmits without an explicit user command — is documented in [`PRIVACY.md`](PRIVACY.md). Report any statement there that the code does not support as a documentation defect.

## Reporting a Vulnerability

If you discover a potential security vulnerability within `gemini-plugin-cc`, please **do not** open a public GitHub issue.

Instead, report it responsibly via either of:
- **Private Security Disclosure** (preferred): Submit via [GitHub Security Advisories](https://github.com/arcobaleno64/gemini-plugin-cc/security/advisories/new). It keeps the report, the discussion, and the eventual advisory in one place.
- **Email**: <arcobaleno830623@gmail.com>, for anyone who cannot or would rather not use GitHub. This address is monitored by the maintainer; it is not a team inbox, so expect one person's response times.

### Response Expectations
- **Initial Response**: Within 48 hours.
- **Status Update**: Within 7 business days.
- **Fix & Patch Advisory**: Released in a timely patch release.
