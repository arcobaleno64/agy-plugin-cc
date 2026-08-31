# Frequently asked questions

繁體中文版：[`FAQ.zh-TW.md`](FAQ.zh-TW.md)

This FAQ is a short route to the repository's current evidence. The linked source documents remain authoritative when behavior changes.

## What is agy-plugin-cc?

It is an independent Claude Code companion that runs Gemini CLI or Antigravity CLI (`agy`) as a cross-model task delegate and code reviewer. It is not affiliated with, endorsed by, or sponsored by Google or Anthropic, and it is not a general-purpose multi-agent framework.

Evidence: [`README.md`](../README.md) · [`COMPARISON.md`](COMPARISON.md)

## Which engine should I choose?

Install and authenticate one engine, not both. AGY is the practical default for personal accounts; choose Gemini CLI when you have supported access and want its engine-specific model and JSON behavior. `auto` checks an authenticated Gemini CLI first, then AGY, and an explicit `--engine` overrides that choice.

Evidence: [`README.md`](../README.md) · [`engine.mjs`](../plugins/gemini/scripts/lib/engine.mjs)

## How do pragmatic and adversarial review differ?

`/gemini:review` looks for concrete defects and incomplete code paths. `/gemini:adversarial-review` challenges the approach and accepts optional focus text; `--deep` lets either review inspect relevant repository context beyond the diff.

Evidence: [`README.md`](../README.md) · [`review.md`](../plugins/gemini/commands/review.md) · [`adversarial-review.md`](../plugins/gemini/commands/adversarial-review.md)

## Can delegated work write files?

`/gemini:rescue` is dispatched without write intent unless you explicitly pass `--write`. Review commands are dispatched with read-only intent, but the plugin cannot promise that every engine configuration will prevent writes; it checks the workspace afterward and reports detected changes.

Evidence: [`PRIVACY.md`](../PRIVACY.md) · [`THREAT-MODEL.md`](THREAT-MODEL.md)

## Is the delegated engine sandboxed or filesystem-confined?

No such universal boundary is provided by this plugin. AGY permissions depend on the user's settings, while Gemini CLI has a container sandbox that this plugin does not enable or require; do not treat a review command or MCP annotation as an enforceable filesystem sandbox.

Evidence: [`PRIVACY.md`](../PRIVACY.md) · [`THREAT-MODEL.md`](THREAT-MODEL.md)

## What data can leave my machine?

The plugin operates no hosted service. It starts the engine CLI you installed, which sends the assembled prompt to Google; reviews can include git status, diffs, and eligible untracked-file contents, and an agentic engine may read additional workspace data after dispatch. The optional Stop review gate is the only automated send and is disabled until enabled by the user.

Evidence: [`PRIVACY.md`](../PRIVACY.md) · [`SECURITY.md`](../SECURITY.md)

## What is available through MCP?

The MCP server exposes background task delegation, pragmatic and adversarial review, and job status, result, and cancellation tools. It does not expose every slash command, and its safety annotations describe the conservative worst case rather than guaranteeing engine behavior or universal MCP-client compatibility.

Evidence: [`README.md`](../README.md) · [`gemini-mcp.mjs`](../plugins/gemini/scripts/gemini-mcp.mjs)

## How do I install the plugin?

Add `arcobaleno64/agy-plugin-cc` as a Claude Code marketplace, install `gemini@agy-plugin-cc`, and run `/reload-plugins`. Install and authenticate the selected Gemini CLI or AGY engine separately.

Evidence: [`README.md`](../README.md)

## How do updates work?

The release-channel marketplace follows `main`, but an existing installation updates only after the manifest version changes. Third-party marketplace auto-update is off by default; the README documents both the opt-in setting and the explicit update commands, followed by `/reload-plugins`.

Evidence: [`README.md`](../README.md) · [`version-sources.md`](version-sources.md)

## How do I pin a specific version?

Add the marketplace as `arcobaleno64/agy-plugin-cc@<release-tag>`, then install the plugin and reload. A pinned marketplace stays on that git tag even when marketplace auto-update is enabled. To move versions, remove the existing marketplace first (which also uninstalls the plugin), add it again at the new tag, reinstall the plugin, and run `/reload-plugins`.

Evidence: [`README.md`](../README.md) · [`version-sources.md`](version-sources.md)
