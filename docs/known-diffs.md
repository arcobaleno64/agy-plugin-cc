# Known differences — agy-plugin-cc

Deliberate, documented divergences from its sibling companion plugins
(companion-cx, companion-agy). agy-plugin-cc is the mature, published
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
  Neither engine offers a comparable path boundary the plugin can impose — AGY's
  `--sandbox` restricts what a terminal command may reach, not where anything may
  write, and Gemini CLI's same-named flag is a container sandbox that refuses to
  start without Docker or Podman (both measured, `docs/THREAT-MODEL.md` §7.2) —
  so the same default here would be write-capable *and* unconfined. The default
  is inverted rather than the feature removed. This also aligns the slash-command
  path with the MCP path, where `gemini_rescue` already defaulted `write: false`.
- **`--write` means something different on each engine.** On Gemini CLI it maps
  to `--yolo`, which *is* a permission: without it the model is offered no write
  or shell tools at all. On AGY it maps to `--new-project` rather than
  `--add-dir` (workspace orientation). Across all supported AGY versions,
  non-`--deep` diff reviews spawn in an isolated empty temp `cwd`. On AGY
  builds advertising `--settings` in `--help` (verified on 1.5.16), the plugin
  additionally passes a one-shot `--settings` file: `review-diff` denies
  `read_file(*)`, `write_file(*)`, `command(*)`, `mcp(*)`, `read_url(*)`, and
  `execute_url(*)`; `--deep` reviews and read-only `rescue` turns deny
  writes/commands/MCP/URLs and emit bounded workspace-relative `read_file(...)`
  rules for scanned secrets (up to 5,000 entries, depth 6, skipping `.git`,
  `node_modules`, `dist`, `build`, `.next`, `target`, `vendor`); and `--write`
  turns apply file-tool rules on `.git`/scanned secrets while leaving `command`
  enabled. `--deep` reviews and tasks also fail closed pre-spawn if cwd/Git-root
  verification fails or `.agents`/`.agent`/`_agents`/`_agent` `hooks.json`,
  `mcp_config.json`, `plugins.json`, or `plugins` exist within 64 parent hops
  (unless native CLI strict boolean `--allow-repo-hooks` is passed; MCP omits
  this flag), and write-capable `--conversation` resumes require verified job-store
  workspace binding. Older AGY builds down to 1.1.12 omit `--settings` and fall
  back to the post-turn `readonly-guard.mjs` snapshot, so `--write` remains an
  intent + orientation boundary across the full supported floor.
  - Until v0.16.4 a read-only AGY turn was given no orientation flag at all,
    which read as a boundary and was not one: the model simply did not know
    where the repository was, while remaining able to reach any absolute path.
    It also could not do the investigation `/gemini:rescue` is documented for.
    See `docs/THREAT-MODEL.md` §7.2 for the measurements and the correction.
- **Bench harness is retained.** The Codex-vs-Gemini benchmark suite (`bench/`,
  cassettes, scoring) lives only here; the siblings deliberately omit it (owner
  decision), so it is a one-way difference, not a gap.
- **Existing exported function names are unchanged.** Because this plugin is
  published (v0.6.6), the shared adapter contract is satisfied by *semantic*
  equivalence documented in `docs/adapter-contract.md` (e.g. `terminateProcessTree`
  ↔ contract `cancel`), not by renaming to match the siblings (Hyrum's law).

## Security posture (shared with siblings)

- **AGY prompt transport is stdin-only.** Every AGY the plugin runs receives
  free text through stdin. The positional fallback, and the NUL and
  24,000-character preflight checks that guarded it, went with the version
  floor: the versions that needed them are refused at engine detection. AGY is
  resolved to an absolute `.exe` and spawned with `shell:false`; if that cannot
  be guaranteed, `detectEngine` fails closed rather than falling back to a bare
  name. The `quoteForWindowsShell` helper is a no-op safety net for
  fixed-constant argv only and is explicitly not relied on for free text.
- **The gemini engine now avoids the shell too, by a different route.** AGY must
  be an absolute `.exe` or the run fails closed. Gemini cannot hold to that — on
  Windows a global npm install is a `.cmd` shim, and refusing `.cmd` would refuse
  the normal installation — so instead the shim's package is read and its `bin`
  entry is spawned through this process's own Node with `shell:false`. Where that
  cannot be established the shell fallback remains, so this is a narrowing of the
  shell path, not its removal.

## Follow-ups (adversarial-review groups, low priority)

*`/gemini:cancel <groupId>` was the other entry here. Closed in v0.22.0: cancel
reuses the same aggregating pattern as `status` and `result`.*

- **Partial dispatch has no rollback — narrowed, and re-checked 2026-08-18.**
  The original entry said any failure in a later engine could orphan an earlier
  group member. The larger half of that is closed: `gemini-companion.mjs`
  validates every selected engine into `preparedSelections` *before* the first
  detached worker is spawned, with a comment saying so, so a validation error
  now fails before anything is queued. What remains is the spawn itself failing
  for a later engine, which leaves the earlier job orphaned as described. Lower
  probability than the entry implied; still no cleanup, and still deliberate —
  an orphan is queryable by its own id and costs a quota-spending job to undo.

## Upstream-blocked

- **gemini engine end-to-end** depends on Gemini API auth; the CLI OAuth path is
  retired upstream and will not be restored (owner-confirmed 2026-07-14;
  observed `API_KEY_INVALID`). With the gemini engine effectively unavailable,
  the plugin's agy path is the practical route — it reads the native JSON
  envelope, which the version floor guarantees. Transcript recovery is no longer
  a version fallback; it survives only as salvage for a run killed before it
  printed. The gemini path remains for environments where a working key exists.
