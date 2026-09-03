# Gemini / Antigravity Plugin Comparison

`agy-plugin-cc` is a Claude Code-native companion bridge for developers who want Gemini CLI where it is still available, plus an explicit Antigravity CLI (`agy`) path during Google's Gemini CLI transition.

This project is not an AGY-only replacement or a multi-host plugin. It focuses on Claude Code workflows with richer review behavior and defensive handling around real CLI failure modes.

## The Landscape, Measured

Measured 2026-08-20 from each project's README and repository tree. Their code was not
read, so every feature attributed to another project is that project's own description.
`pushedAt` is the last code push; GitHub's `updatedAt` also moves on metadata changes
such as a new star, which makes an untouched repository look current. The other five rows
are that snapshot and are not refreshed between measurements; this project's own row is
kept current on release, so a reader can tell which numbers are old by which project they
belong to.

| Project | Stars | Last push | Latest release | Engine | Transport |
|---|---|---|---|---|---|
| [thepushkarp/cc-gemini-plugin](https://github.com/thepushkarp/cc-gemini-plugin) | 71 | 2026-04-14 | none | Gemini CLI | bridge script |
| [abiswas97/gemini-plugin-cc](https://github.com/abiswas97/gemini-plugin-cc) | 48 | 2026-04-19 | v1.0.1 | Gemini CLI | ACP |
| [sakibsadmanshajib/gemini-plugin-cc](https://github.com/sakibsadmanshajib/gemini-plugin-cc) | 24 | 2026-05-22 | v1.0.1, archived | Gemini CLI | ACP |
| [sakibsadmanshajib/antigravity-plugin](https://github.com/sakibsadmanshajib/antigravity-plugin) | 19 | 2026-05-22 | none | AGY only | `agy --print` |
| [m-ghalib/gemini-plugin-cc](https://github.com/m-ghalib/gemini-plugin-cc) | 18 | 2026-04-24 | v0.1.0 | Gemini CLI, setup installs 0.38.2 | ACP |
| **this project** | 10 | 2026-09-03 | v0.24.4 | Gemini CLI **and** AGY | direct spawn, structured JSON |

| Surface | Slash commands | MCP tools | Skills | Test files (`*.test.*`) |
|---|---|---|---|---|
| **this project** | 8 | **6** | 3 | 42 |
| abiswas97 | 8 | 0 | 3 | 13 |
| m-ghalib | 7 | 0 | 3 | 12 |
| sakibsadmanshajib/antigravity-plugin | 6 | 0 | 0 | 12 |
| thepushkarp | 1 | 0 | 0 | 1 |

A test file count measures files, not assertions: it says nothing about whether any of
these suites, this one included, would fail if the behaviour they cover broke.

No other project in the table declares an MCP server — no `.mcp.json`, and no
`mcpServers` key in `plugin.json`. Their command surface is reachable by a person typing a
slash command, not by another program calling a tool.

Every other project's last code push predates 2026-06-18, the day consumer OAuth for
Gemini CLI stopped working — measured here on 2026-08-19: without an API key the CLI
now answers `API key not valid`. That is a statement about dates, not a claim that any of them
is broken: the projects documenting `GOOGLE_API_KEY` or application-default credentials
may still authenticate normally.

Every project here descends from `openai/codex-plugin-cc` by its own attribution, this
one included, except `thepushkarp/cc-gemini-plugin`, whose README names no upstream. The command and skill sets are therefore
close by inheritance rather than by convergence: `abiswas97` ships the same three skill
directories this project does, and `m-ghalib` the same three but for a prompting skill
renamed `gemini-3-prompting`. The columns that actually differ are MCP tools and tests.

Three of the others lead somewhere this one does not go.
`sakibsadmanshajib/antigravity-plugin` installs into Codex CLI, `agy` itself and
standalone `npx`. `thepushkarp/cc-gemini-plugin` inlines globbed files into the prompt
for long-context delegation, and its one-command surface is easier to learn than eight.
`abiswas97/gemini-plugin-cc` ships `/gemini:task` for one-off delegation, where this
project spends its eighth command on `/gemini:transfer` instead. `m-ghalib` is the
closest neighbour of all: same lineage, same skills, one command fewer, and the longest
README of the five others at 318 lines.

### One Deliberate Difference

`m-ghalib/gemini-plugin-cc` ships the same stop-time review gate this project does. Both
descend from `openai/codex-plugin-cc`, and the two `hooks.json` files are identical apart
from the description line. The gates fail in opposite directions.

That project's README says its gate blocks when Gemini cannot be reached. This one fails
open (`plugins/gemini/scripts/stop-review-gate-hook.mjs:120`): it lets the stop through
and attaches a `systemMessage` naming the command to run by hand. That warning only
started reaching anyone in 0.22.3 — until then the hook wrote a `decision` the Stop
schema rejects, so Claude Code discarded the payload and the warning with it.

Both are defensible, and the choice is about which failure a user can act on. After the
OAuth change, failing closed traps every user whose credentials lapsed at the exact
moment they are trying to stop working — and a gate that cannot reach the reviewer
cannot tell a credential problem from a real finding.

## Positioning

| Need | Best fit |
|---|---|
| Claude Code-native Gemini / AGY bridge | Use this plugin. |
| Pragmatic and adversarial review inside Claude Code | Use `/gemini:review` or `/gemini:adversarial-review`. |
| Gemini CLI model aliases, JSON output, and stdin prompt delivery | Use the Gemini engine where your account still supports Gemini CLI. |
| Antigravity CLI fallback during migration | Use `--engine agy`. |
| AGY-only, multi-host, or standalone `npx` workflows | Use an AGY-only multi-host plugin instead. |

## What This Plugin Emphasizes

- Claude Code-native `/gemini:*` slash commands.
- MCP tools (`gemini_review`, `gemini_adversarial_review`, `gemini_rescue`, and job
  status / result / cancel) so another agent can call the bridge, not only a person.
- Standard and adversarial code review over the current diff or branch.
- Background jobs with status, result, and cancel flows.
- Gemini model aliases, graceful model fallback, and transient review retry.
- A declared AGY floor (1.1.12) instead of seven compatibility gates: an older AGY is refused by name with the command that fixes it, rather than silently degraded.
- Safer stdin prompt delivery on the Gemini engine.

## What This Plugin Does Not Claim

- It is not a universal multi-host Antigravity plugin.
- It does not claim full feature parity with Antigravity CLI.
- It does not implement or claim ACP support for AGY.
- It does not publish an npm / `npx` install path.

## Recommended GitHub Topics

`agy`, `adversarial-review`, `ai-code-review`, `antigravity-cli`, `claude-code`, `claude-code-plugin`, `code-review`, `cross-model-review`, `gemini-cli`, `mcp`, `model-context-protocol`, `task-delegation`
