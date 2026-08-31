# Documentation index

繁體中文版：[`README.zh-TW.md`](README.zh-TW.md)

Two kinds of file live here, and telling them apart matters more than their size. **Reference** describes how the plugin behaves now and is corrected when behaviour changes. A **dated record** describes what was measured on a specific day against specific versions; it is never rewritten, because its value is answering *when* something changed. Reading a dated record as if it were current is the mistake this page exists to prevent.

Start with the [README](../README.md). Nothing here is required reading to use the plugin.

## Reference — kept current

| File | Answers |
|---|---|
| [`FAQ.md`](FAQ.md) · [`FAQ.zh-TW.md`](FAQ.zh-TW.md) | Concise answers to identity, engine, review, trust-boundary, data-handling, MCP, installation, update, and version-pinning questions, each routed to current repository evidence. |
| [`THREAT-MODEL.md`](THREAT-MODEL.md) | What an untrusted repository can make a delegated agent do, mapped to OWASP LLM Top 10. §7.2 is the one to read before trusting any "read-only" claim. |
| [`parity.md`](parity.md) · [`parity.zh-TW.md`](parity.zh-TW.md) | How this plugin maps to `codex-plugin-cc`, command by command, and where the runtimes differ. |
| [`known-diffs.md`](known-diffs.md) | Deliberate divergences from upstream, with the reason each one is kept. |
| [`COMPARISON.md`](COMPARISON.md) | Positioning against AGY-only and multi-host plugins — what this plugin does and does not claim. |
| [`MODEL_COMPARISON.md`](MODEL_COMPARISON.md) | Why review depth differs between engines, and how much of it is harness rather than model. Contains dated probe records, each marked where superseded. |
| [`adapter-contract.md`](adapter-contract.md) | The interface an engine adapter has to satisfy. |
| [`version-sources.md`](version-sources.md) | Which file is authoritative for each version string, and what keeps them in lockstep. |
| [`verifying-without-credentials.md`](verifying-without-credentials.md) | How to exercise the engine paths without a Gemini or AGY account. |
| [`evidence.md`](evidence.md) | The rule this repository investigates by: nothing counts as evidence until it has been seen to fail. Includes the traps already paid for. |
| [`ROADMAP.md`](ROADMAP.md) | Every item in the handover playbook, triaged against HEAD: already done, premise verified and worth doing, blocked on something that does not exist, wrong as written, or a non-goal. Read this before acting on the playbook. Traditional Chinese. |

## Dated records — never rewritten

| File | Measured against | Superseded by |
|---|---|---|
| [`PARITY_AUDIT.md`](PARITY_AUDIT.md) | plugin v0.6.0 vs upstream v1.0.4, 2026-06-02 | `PARITY_AUDIT_v0.11.1.md` |
| [`PARITY_AUDIT_v0.6.1.md`](PARITY_AUDIT_v0.6.1.md) | plugin v0.6.1 re-score | `PARITY_AUDIT_v0.11.1.md` |
| [`PARITY_AUDIT_v0.11.1.md`](PARITY_AUDIT_v0.11.1.md) | plugin v0.11.1 vs upstream v1.0.6, 2026-08-04 | current state: [`parity.md`](parity.md) |
| [`AGY_1.1.2_MACOS_LINUX_VALIDATION.md`](AGY_1.1.2_MACOS_LINUX_VALIDATION.md) | plugin v0.7.1 against AGY **1.1.2**, macOS/Linux | nothing re-ran it; see the banner in the file |
| [`HANDOVER_MARKETING_AND_RELEASE_PLAYBOOK.md`](HANDOVER_MARKETING_AND_RELEASE_PLAYBOOK.md) | plugin v0.22.2 / `22b93a7`, 2026-08-21 | [`ROADMAP.md`](ROADMAP.md) triages it against a later baseline. Treat every spec and template as a dated proposal and reverify it against HEAD before use. |

Behaviour measured after the newest of these lives in the [CHANGELOG](../plugins/gemini/CHANGELOG.md) and in `THREAT-MODEL.md` §7.2, both of which carry their own measurement dates.
