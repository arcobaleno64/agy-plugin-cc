# Known differences — gemini-plugin-cc

Deliberate, documented divergences from its sibling companion plugins
(companion-cx, companion-agy). gemini-plugin-cc is the mature, published
(v0.6.6) member and the origin of several capabilities the campaign ported to
the siblings; this file records where it intentionally differs. See the
campaign matrix for the full three-way comparison.

## Deliberate design differences

- ~~**Job state lives in the project-local `.omc/state/` dir**~~ — **this was
  never true and is withdrawn.** `resolveStateDir` has resolved to
  `$CLAUDE_PLUGIN_DATA/state/<workspace>-<hash>/`, or a system-temp fallback,
  since the first commit in this repository; only `/gemini:transfer` snapshots
  are project-local. The entry also justified itself with a compatibility
  argument for a location the code never used. What is actually true: job state
  goes to Claude Code's per-plugin data directory, which is where upstream puts
  it too, so this is not a divergence at all.
- **`--write` is opt-in here; upstream defaults to it.** `codex-plugin-cc`'s
  rescue subagent adds `--write` unless asked not to, and can afford that because
  `codex-companion.mjs:491` confines the run with `sandbox: "workspace-write"`.
  Neither Gemini CLI nor AGY offers a comparable path boundary — AGY's
  `--sandbox` restricts what a terminal command may reach, not where anything may
  write (measured, `docs/THREAT-MODEL.md` §7.2) — so the same default here would
  be write-capable *and* unconfined. The default is inverted rather than the
  feature removed. This also aligns the slash-command path with the MCP path,
  where `gemini_rescue` already defaulted `write: false`.
- **`--write` selects a workspace, not a permission.** On AGY it maps to
  `--new-project`, binding the session to `cwd`; without it AGY works in its own
  scratch directory. There is no permission flag to map it to: headless print
  mode auto-approves edits and shell commands either way.
- **Bench harness is retained.** The Codex-vs-Gemini benchmark suite (`bench/`,
  cassettes, scoring) lives only here; the siblings deliberately omit it (owner
  decision), so it is a one-way difference, not a gap.
- **Existing exported function names are unchanged.** Because this plugin is
  published (v0.6.6), the shared adapter contract is satisfied by *semantic*
  equivalence documented in `docs/adapter-contract.md` (e.g. `terminateProcessTree`
  ↔ contract `cancel`), not by renaming to match the siblings (Hyrum's law).

## Security posture (shared with siblings)

- **AGY prompt transport is version-gated.** Stable AGY 1.1.2+ receives free
  text through stdin; older, prerelease, and unparseable versions retain the
  positional fallback with NUL and 24,000-character preflight checks. AGY is
  resolved to an absolute `.exe` and spawned with `shell:false`; if that cannot
  be guaranteed, `detectEngine` fails closed rather than falling back to a bare
  name. The `quoteForWindowsShell` helper is a no-op safety net for
  fixed-constant argv only and is explicitly not relied on for free text.

## Follow-ups (adversarial-review groups, low priority)

- **`/gemini:cancel <groupId>` is not group-aware.** `status` and `result`
  accept a groupId and aggregate, but cancel matches only a job id, so an
  adversarial-review group must be cancelled one engine job at a time. The
  command docs never promised group cancel, so this is an asymmetry, not a
  broken contract.
- **Partial dispatch has no rollback.** If a later engine in an adversarial
  dispatch fails after an earlier one already spawned, the earlier job is
  orphaned (still queryable by its own id, but never gets its group peer). Low
  probability; no cleanup today.

## Upstream-blocked

- **gemini engine end-to-end** depends on Gemini API auth; the CLI OAuth path is
  retired upstream and will not be restored (owner-confirmed 2026-07-14;
  observed `API_KEY_INVALID`). With the gemini engine effectively unavailable,
  the plugin's agy path (transcript recovery) is the practical route; the gemini
  path remains for environments where a working key exists.
