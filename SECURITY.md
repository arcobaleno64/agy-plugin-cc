# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| 0.10.x | :white_check_mark: |
| < 0.10.0 | :x: |

## Security Model & Trust Boundaries

`gemini-plugin-cc` acts as a local CLI bridge between Anthropic's Claude Code environment and the local Gemini/AGY binaries.

### In-Scope Components
- Stdin transport and prompt escaping logic (`lib/gemini.mjs`, `scripts/transfer.mjs`).
- Argument validation and flag parsing (preventing flag injection into CLI subprocesses).
- Process boundary security (forcing `shell: false` on Git operations).
- Secret file redaction filters (`isSecretFile()` in `lib/transfer-context.mjs`).
- Background job state directory isolation (`.omc/`).

### Out-of-Scope Components
- Third-party CLI binary vulnerabilities within Google's `gemini` or `agy` executables.
- Claude Code runtime environment process sandbox boundaries.
- User-managed OAuth token storage inside `~/.gemini/oauth_creds.json` or AGY system keyrings.

## Reporting a Vulnerability

If you discover a potential security vulnerability within `gemini-plugin-cc`, please **do not** open a public GitHub issue.

Instead, report it responsibly via:
- **Private Security Disclosure**: Submit via [GitHub Security Advisories](https://github.com/arcobaleno64/gemini-plugin-cc/security/advisories/new)
- **Maintainer Contact**: Email the primary maintainer directly.

### Response Expectations
- **Initial Response**: Within 48 hours.
- **Status Update**: Within 7 business days.
- **Fix & Patch Advisory**: Released in a timely patch release.
