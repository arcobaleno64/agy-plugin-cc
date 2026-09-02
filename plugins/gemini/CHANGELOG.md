# Changelog

## 0.24.4 - Unreleased

- **`/gemini:result --all` no longer advises `--all`.** With an empty job store
  the message was unconditional, so a user who had just passed the flag was told
  to pass it, and told the search covered "this session" when it had covered
  every session in the workspace. Under `--all` the message now says the
  workspace is empty and stops there — there is nothing left to widen to. The
  session-scoped message is unchanged, because that advice is still true.

- **An AGY review survives a rate limit that clears in under a minute.**
  `runGeminiReviewResilient` returned on `engine === "agy"` unconditionally, so a
  limit AGY itself reports as `Resets in 58s` ended the review outright. Two of
  the three reasons for that blanket exclusion still hold; the one that was meant
  to cover this case does not — a fail-fast timeout answers a hang, and a rate
  limit is a clean ERROR envelope arriving in six seconds with every token count
  at zero (measured, AGY 1.1.24). The exclusion is now an **allowlist**: agy
  retries on `rate-limit` and nothing else, which keeps `tool-permission-denied`
  and brain-root `transcript-missing` unreachable — neither is in
  `ACCOUNT_STATE_FAILURES` and no heuristic names them, so a denylist would have
  exposed both. A retry happens only when AGY states when the limit clears, and
  waits that long (ceiling 90s, one-second grace); with no stated reset there is
  no retry, because this wrapper has no backoff and three immediate attempts
  would finish in seconds at the same refusal. Nor is a compound duration
  half-read: `Resets in 1m 30s` is refused rather than taken as 61s, which would
  have retried 29 seconds early into the same limit. The reset is looked for on
  both the engine detail and stderr, since a detail truncated at 2000 characters
  can be non-null while no longer carrying the sentence.

  Two further bounds. A rate-limited attempt that already produced parsed
  findings is kept rather than retried away — under stream-json an ERROR envelope
  with an empty `response` still yields salvaged text that can parse, so a review
  can be complete and rate-limited at once. And the wait is **opt-in with a
  budget spent across the whole call**, defaulting to none: a foreground
  `/gemini:review` is a single Bash call under the host's default 120s timeout, so
  sleeping there would turn a clean six-second "rate limited" into a killed
  command reporting nothing. Only a detached worker, which is polled through
  `/gemini:status`, passes a budget. The wrapper also now forwards its spawn
  seams, without which its own branching could not be tested at all. (#142)

- **A failed AGY turn now shows what AGY said.** `classifyCliFailure` read AGY's
  structured `error` to pick a category and then dropped it, so the rendered
  failure carried only this plugin's own words — which come from a table keyed by
  category and cannot name anything specific to the run. Measured on AGY 1.1.24:
  a rejected `--model` is answered with the eleven model ids AGY would have
  accepted, and the user was shown "Use a supported model" with that list
  discarded and `rawOutput` empty. Failures gained a `detail` field carrying the
  engine's message verbatim (capped at 2000 characters, since it is engine output
  written to job records on disk, and the cap is idempotent so a re-read record
  does not re-truncate). It is populated on AGY's structured-envelope path only —
  the gemini engine's stderr is captured but still not surfaced, and the other
  `classifyCliFailure` call sites pass no detail. The task renderer prints it
  under `Engine said:`, inside the delegated-output marker, since this is the
  first engine-controlled text to reach that branch; the job listings deliberately
  omit it, because a status report renders many jobs. The same field is where a
  rate limit's reset time now surfaces. (#141)

## 0.24.3 - 2026-09-02 - A 503 is a flake again

- **A transport 503 that names the model is retried again.** 0.24.2 stopped a
  spend cap from burning three review attempts by asking `classifyCliFailure`
  first and refusing to retry anything it called non-retryable. That test was
  too wide: `model-unavailable` is non-retryable and matches on the bare word
  `unavailable`, which is exactly what a 503 says. Measured — stderr
  `503: model gemini-3-pro is temporarily unavailable, try again later` was
  classified `model-unavailable` and returned on the first attempt, losing the
  flake absorption `runGeminiReviewResilient` exists for. The guard now names
  the categories it is about (`quota`, `auth`, `binary-missing`,
  `prompt-too-long`); every other category stays subject to the transport and
  envelope heuristics. Both directions are pinned by tests: reverting to the
  wide test turns the 503 case red, deleting the guard turns the spend-cap
  cases red. (#132)

- **A per-minute rate limit is no longer reported as an exhausted quota.** The
  same over-match as above, one layer down: the `quota` branch matched the bare
  words `quota`, `billing` and `RESOURCE_EXHAUSTED`, and Google's standard
  free-tier refusal is `429 RESOURCE_EXHAUSTED: You exceeded your current quota,
  please check your plan and billing details` — which contains two of them. A
  limit that clears in sixty seconds was classified `quota` (`retryable: false`)
  and ended the review on attempt 1. The branch now matches only the durable
  wordings: a spend cap, a billing account, a monthly allowance, or a limit id
  naming `per day`. `billing` alone is gone, because the transient message says
  `billing details`. Anything still carrying `quota` or `RESOURCE_EXHAUSTED`
  falls through to `rate-limit`, which is retryable — and `rate-limit` gained
  both words, so a bare `RESOURCE_EXHAUSTED` with no `429` no longer falls past
  every category to `unknown`. Google names the period after the noun
  (`limit ... per day`), so the day and minute wordings are pinned by tests in
  both directions; a first draft had the word order reversed and could never
  have matched. (#136)

- **A Windows process test no longer guesses how long a kill takes.** `taskkill
  /F` returns once the kill is requested, and Windows reaps asynchronously, so
  the fixed 800ms wait before asserting the parent was gone failed on a loaded
  CI runner. Both that test and its sibling now poll to a 10s ceiling, which
  keeps them fast on an idle machine and makes a real regression fail on the
  assertion rather than on timing. (#139)

## 0.24.2 - 2026-09-02 - The stop gate stops re-arming, and a spend cap stops being retried

- **A write task now arms the stop-review gate once, not on every turn forever.**
  The gate reads the whole workspace job store on purpose — a write task queued
  through the MCP tools carries no session id, so a session-scoped predicate
  would leave exactly those edits ungated — but nothing consumed the trigger,
  and `SessionEnd` never evicts an untagged job. One MCP `--write` task therefore
  re-ran an adversarial review at the end of every agent turn, indefinitely.
  Jobs are now stamped `gateReviewedAt` once a review returns a verdict, and
  re-arm only when the job reaches a terminal state again. The mark is compared
  against `completedAt`, not `updatedAt`: `upsertJob` stamps `updatedAt` on every
  write, so a mark compared against it is stale the instant it is recorded and the
  gate re-arms every turn regardless — the defect this fix exists to remove. A
  review that fails still fails
  open **without** marking, so edits it could not check are not silently
  forgiven. New `pendingGateWriteTasks` export; `hasCompletedWriteTask` is kept
  as a predicate over it. (`stop-review-gate-hook.mjs`)

- **The gate's review mark no longer evicts a newer result.** `listJobs` sorts by
  `updatedAt` and `pruneJobStore` evicts everything past the 50-job cap, so
  stamping the mark through a normal `upsertJob` promoted an old reviewed job to
  the head of the list and evicted a NEWER finished result in its place.
  `upsertJob` takes `{ touch: false }` for patches that record something about a
  job rather than something the job did. (`lib/state.mjs`,
  `stop-review-gate-hook.mjs`)

- **Cancelling an already-finished job no longer reports it as missing.**
  `resolveCancelableJob` searched only active jobs with the throwing form of
  `matchJobReference`, so its own `No active job found` branch was unreachable and
  a finished id came back as `No job found` — pointing at /gemini:status, which
  then displayed the job. It now names the job and its status. (`lib/job-control.mjs`)

- **An exhausted spend cap is no longer retried three times.** Google returns
  `Your project has exceeded its monthly spending cap` with code 429, and none of
  `quota`, `billing`, or `RESOURCE_EXHAUSTED` appear in it, so `classifyCliFailure`
  fell through to `rate-limit` (retryable) and the review wrapper's transport
  heuristic re-ran the review. Measured: three full attempts over 10m46s to reach
  the same refusal. The classifier now matches `spend(ing) cap` as `quota`, and
  `isTransientReviewFailure` consults `classifyCliFailure` before its own
  heuristic, so any failure classified non-retryable ends the run immediately. A
  plain `429 Too Many Requests` still retries. (`lib/failures.mjs`, `lib/gemini.mjs`)

- **Docs corrected where they described the gate's scope wrongly.** The `Stop`
  hook runs at the end of every agent turn, not once at session end; the gate's
  enable/disable setting is stored per workspace on disk, so it persists across
  sessions and must be enabled again in each repository; the `--write` task that
  arms it is any one in the workspace, not only one from the current session; and
  `SessionEnd` removes a session's finished job records too, so a background
  result must be collected before the session ends rather than after.
  (`README.md`, `README.zh-TW.md`, `plugins/gemini/README.md`,
  `commands/review.md`, `commands/adversarial-review.md`, `lib/render.mjs`)

- **`/gemini:result` no longer printed a resume command that cannot run.** The
  gemini branch emitted `gemini --resume <session-id>`, but that flag accepts only
  `latest` or an index number — the id is not addressable, as the runtime's own
  `--resume-last --write` refusal already explained. The session id is still
  shown; the paste-ready line is replaced by a note pointing at `--resume-last`.
  New `resumeLine` helper, so a null command cannot render as the literal
  `null`. (`lib/render.mjs`)

- **`/gemini:result` on a running job said "No job found".** `resolveResultJob`
  probes twice — finished first, then active — so it can answer "still running"
  instead of "not found", but the first probe threw on no-match and the second was
  unreachable. Measured through `gemini_job_result`: a job whose file was on disk
  and which `/gemini:status` was listing as `running` came back as missing, with a
  next step (`/gemini:status`) that then showed the job. `matchJobReference` takes
  a `missing` mode, and the two probes inside `resolveResultJob` pass `"null"`;
  every other caller keeps the throw. (`lib/job-control.mjs`)

- **`/gemini:result` with nothing to show no longer overstates its scope.** The
  message said no finished jobs existed "for this repository" while the search was
  filtered to the current session, sending users to look for a job-store fault
  that was not there. It now says "for this session" and names `--all`.
  (`lib/job-control.mjs`)

- **Flag documentation corrected where it under-reported the runtime.**
  `--resume-last` is refused with `--write` on the gemini engine (README said
  nothing); `--engines gemini,agy` was missing from the adversarial-review flag
  table; `--effort` was missing from both review commands' argument hints;
  `status --wait` gives up after 4 minutes rather than blocking indefinitely;
  `transfer --effort xhigh` produces a command AGY rejects and the generated
  gemini command carries no effort flag at all; and the CLI help for `task`
  listed only `low|medium|high` when `none`, `minimal`, and `xhigh` are accepted.
  (`README.md`, `README.zh-TW.md`, `commands/*.md`, `gemini-companion.mjs`)

- **The rescue subagent no longer maps `flash` / `pro` to `--model` on AGY.**
  Those are Gemini aliases; `normalizeAgyRequestedModel` refuses them before
  spawn, so the instruction produced a guaranteed fatal error whenever the engine
  was AGY. It is now conditioned on the engine, with `--effort` named as the AGY
  route. (`agents/gemini-rescue.md`)

- The comment justifying "agy is never retried" no longer cites agy's
  transcript-recovery path: from AGY 1.1.8 on, `supportsAgyStructuredOutput`
  routes to the native JSON envelope and that path never runs. The behaviour is
  unchanged — the fail-fast timeout and respawn cost still hold it up — but the
  stale half of the rationale is removed rather than left to be trusted.

## 0.24.1 - 2026-08-28 - Readonly guard now detects untracked submodule writes on Linux

- **Readonly review jobs now fail when a submodule's untracked content changes.**
  Git is explicitly asked not to ignore submodule modifications, removing a
  platform-dependent gap that let the same regression test pass on Windows but
  fail on Linux.

## 0.24.0 - 2026-08-28 - The project is now agy-plugin-cc; Gemini commands stay stable

- **The repository, marketplace, and private package identities are now
  `agy-plugin-cc`.** New installations use
  `/plugin marketplace add arcobaleno64/agy-plugin-cc` followed by
  `/plugin install gemini@agy-plugin-cc`. Existing users should remove the old
  `gemini-plugin-cc` marketplace entry, add the renamed repository, reinstall
  the plugin, and run `/reload-plugins`.

- **The plugin identity and command surface do not change.** The manifest still
  declares `"name": "gemini"`, the source remains under `plugins/gemini/`, and
  every `/gemini:*` command keeps its existing name and behavior.

## 0.23.0 - 2026-08-26 - What a repository could make this plugin run, and what it never asked for

- **The handover playbook is now triaged, and filed as a dated record.** It sat
  under "Reference -- kept current" while carrying a baseline three releases old,
  which is precisely the mistake `docs/README.md` exists to prevent. It moves to
  "Dated records", and `docs/ROADMAP.md` takes its place: every item in it sorted
  into already-done, premise-verified-and-worth-doing, blocked-on-something-that-
  does-not-exist, wrong-as-written, or non-goal -- each with the command that
  re-checks it, because this classification will go stale too.

  What the triage found, verified against HEAD rather than against the playbook:
  `SAFE_MODEL_ID` really does still reject Vertex AI paths, the stop gate really
  is fail-open, and `allocateBudget` really is unweighted -- three premises that
  survived. Against that, the AEO benchmark it lists as missing already exists and
  ships tests; the CI fail-closed switch exists only to serve an `action.yml` that
  does not; `robots.txt` and JSON-LD need a site, and GitHub Pages is not enabled;
  and its funding-application template describes the project as a multi-agent
  consensus framework, which its own 2 explicitly says the project is not.

  Also recorded: `scripts/aeo-benchmark.mjs` asks whether an answer mentions SARIF
  export, and there is no SARIF export. That query can only pass on a hallucination.

  Upgrading the playbook to v3.8.1 broke two assertions in
  `tests/seo-aeo-validation.test.mjs`, and both were the test being wrong rather
  than the document. It required `User-agent: Claude-Web`, which is retired --
  Anthropic documents ClaudeBot, Claude-User and Claude-SearchBot, and they take
  different policies, which a single retired name cannot express. It also demanded
  five literal `Disallow:` lines from every group, failing a group that disallows
  the entire site more strongly; and it extracted 4.8 by stopping at the first
  `---`, which a markdown table's `|---|` satisfies, so the whole FAQ section came
  back empty and every assertion under it silently went unreached. The
  answer-first check then read `[^*]+` across an answer naming `.env*` and
  `*.pem`. Each fix was mutation-tested: dropping an agent, unbolding an answer,
  removing a group's blanket disallow, and stripping one `Disallow:` line all
  still fail the suite.

- **Documented what the hooks decline, and what 0.x promises.** Two additions,
  no behavior change. `PRIVACY.md` 3 now names the hook payload: Claude Code
  hands each hook a JSON object whose documented fields include a
  `transcript_path`, and the two hook scripts read `session_id`, `cwd` and
  `hook_event_name` between them and nothing else. The section already said
  Claude memory and transcripts are never read; it did not say the pointer is
  handed over and declined, which is the stronger and more checkable claim. It
  also now accounts for `$CLAUDE_PLUGIN_DATA/state/`, the one Claude-Code-owned
  path the plugin does open, rather than leaving a reader to find it in 4 and
  wonder why 3 did not mention it.

  The READMEs gain a **Versioning** section, because "0.23.0" on its own says
  nothing and a reader is entitled to know whether that is caution or neglect.
  It is caution: MINOR may break the command/MCP/hook surface and says so in the
  CHANGELOG's first line, PATCH never does, and 1.0.0 waits on three consecutive
  MINOR releases without a break plus an AGY integration that no longer needs
  per-version gates -- `scripts/lib/engine.mjs` still carries seven `supportsAgy*`
  gates, so neither condition holds.

- **A binary sitting in the repository could get itself spawned.** `where.exe`
  searches the current directory before PATH, and unlike cmd.exe and
  CreateProcess it keeps doing so when `NoDefaultCurrentDirectoryInExePath` is
  set. Command resolution trusted its first hit, so `runCommand("git", ...)` in a
  tree holding a `git.exe` resolved to that file and spawned it -- measured, not
  reasoned about. Cloning a repository and opening it was the whole attack. The
  lookup now runs from System32, which is already on PATH and needs administrator
  rights to write, so it contributes no candidate that was not already trusted.

  A second, independent path had the same shape and hid behind the first: when
  resolution cannot identify a command it falls back to a shell, and cmd.exe
  searches the current directory too -- but only where that variable is unset.
  Git Bash sets it, which is why a suite run from Git Bash could not see this at
  all; a plain PowerShell, cmd, or service environment does not. Child processes
  now get the variable set. Both paths are pinned by tests, and the one for the
  lookup runs in a child process on purpose: the lookup reads `process.cwd()`
  rather than the `cwd` it is handed, so an in-process test asserts against a
  directory the code never consults and passes either way. The first version of
  that test did exactly that, and both mutations survived it.

- **A `.omc` junction could send a transfer snapshot out of the workspace.**
  `/gemini:transfer` writes under `<workspace>/.omc/transfers/`, but that is a
  claim about names: a junction or symlink named `.omc` -- which an unprivileged
  Windows user can create, so a repository can ship one -- redirected every write
  and every prune, while the path reported back still read as a directory inside
  the repository. A snapshot carries the entire uncommitted diff, which made this
  a way for a repository to publish its author's working tree. Both `.omc` and
  `.omc/transfers` are now resolved with realpath and checked for containment
  before anything is written, and the refusal names the link.

- **`gemini_review` and `gemini_adversarial_review` no longer report
  `readOnlyHint: true`.** The annotation claimed the reviewed workspace is never
  modified, on the grounds that the review path dispatches the engine with
  `--write` disabled. On AGY that disables nothing the user's own `settings.json`
  has not already decided.

  Measured on AGY 1.1.20, both arms, with exactly the argv the review path builds.
  Under `toolPermission: "always-proceed"` with the target inside
  `trustedWorkspaces`, a review turn replaced a file in the workspace, replaced
  one outside it, and ran a shell command -- three for three. Under an isolated
  home holding a minimal settings file, with the target on a volume no
  `trustedWorkspaces` entry covers, all three were auto-denied. So the workspace is
  safe on a default install and unsafe on a permissive one, and `always-proceed`
  is an ordinary convenience setting rather than an exotic one. An annotation is
  static per tool, cannot read the user's settings, and by this file's own rule
  describes the worst a call can do.

  The earlier reasoning was wrong twice over, and the second one is the one worth
  recording: it leaned on gemini's `--yolo` gate from `docs/THREAT-MODEL.md` 7.2 as
  though it covered both engines. `--yolo` is a gemini flag, AGY has no equivalent,
  and that section opens by saying the two engines behave in opposite ways and
  nothing transfers between them.

  The same run also settles a caveat every AGY block in the threat model carried:
  those measurements were taken on a machine with `always-proceed` set, which the
  document flagged as uncontrolled. Controlled, the permissive arm reproduces them
  all and the default arm reproduces none. Recorded there in full.

- **Nine review findings on the changes above.** The exec-hijack guard's lookup
  directory now comes from `where.exe`'s own resolved path instead of re-reading
  `%SystemRoot%` -- the fallback that read was unreachable, since the same variable
  is what finds `where` in the first place, and a mutation replacing it survived the
  whole suite. `NoDefaultCurrentDirectoryInExePath` is now set only on the shell
  branch: unconditionally, it reached the engine CLI and every shell command the
  model ran through it, changing command resolution inside the user's workspace for
  processes this plugin does not own.

  The transfer containment guard now refuses a link whether or not it resolves,
  covers `.omc/.gitignore` as well as the two directories, and fails closed when it
  cannot inspect a path. Each was a real hole: a *dangling* `.gitignore` symlink
  passed both directory checks and both the old guard's `realpath` (ENOENT read as
  "not there yet") before `writeFileSync` followed it, and a junction that can be
  traversed but not opened reports EACCES, which the guard was treating as
  contained.

  Also: the `--resume` refusal message said the flag accepts only `latest` when it
  also accepts an index number, `PRIVACY.md` credited the wrong mechanism for
  protecting an older AGY's positional prompt, and the spawn-target cache key's NUL
  separator made git classify `scripts/lib/process.mjs` as binary -- so the diff of
  a security change did not render at all in review. The separator is U+001F now,
  equally impossible in a command name or a PATH and not a byte git treats as
  binary.

- **A resumed gemini turn may no longer also write.** `gemini --resume` accepts
  only `latest` or an index number (`gemini --help`, 0.56.0), and an index is a
  position rather than an identity -- it shifts as sessions are created. So a
  resumed turn continues whatever gemini ran last --
  which need not be the thread the caller resolved -- and a resumed conversation
  carries its own workspace. Read-only that costs an answer about the wrong
  project, which the run detects afterwards and reports; write-capable it costs
  edits landing in that project's directory, and no after-the-fact notice undoes
  those. The pair is now refused, naming three ways out: `--fresh`, resuming
  without `--write`, or `--engine agy`, which pins the conversation by id.

  This is the refusal AGY already made, narrowed rather than copied. AGY declines
  any unpinned resume because it can always pin one; gemini can never pin one, so
  declining every resume there would remove the feature instead of securing it.
  The read-only path is untouched, and a test pins both directions -- the refusal
  must fire on the pair and must not fire on a read-only resume.

- **The rescue subagent no longer invites itself.** Its description opened with
  "Proactively use when" and its own guidance said "Do not wait for the user to
  explicitly ask for Gemini" -- an instruction to spawn an external CLI, ship the
  user's prompt and repository context to Google, and spend their quota, without
  their asking. The Anthropic Software Directory Policy is explicit that
  instructional software must not call external tools "unless requested and
  intended by a user". Both lines are gone and the gate is stated positively, in
  the `description` field specifically: that is what the host matches on when it
  decides whether to reach for the agent, so a gate living only in the body
  arrives after the selection it was meant to govern.

- **Three documentation claims the code did not support.** `PRIVACY.md` said it
  applied to 0.16.x, six minors behind, in a document whose whole value is that
  every claim can be checked against the source; its transport section said
  "never a shell command line" while a Windows fallback shell existed; and both
  READMEs described `SessionEnd` as cleaning up stale jobs when it terminates
  this session's running ones and discards their results. The rest of `PRIVACY.md`
  was re-checked line by line against 0.23.0 rather than carried forward -- the
  caps, the retention counts, the keychain commands, and the never-read list all
  hold.

- **The plugin directory now carries its own README**, and both top-level READMEs
  state plainly that this project is not affiliated with Google or Anthropic.

- **`agy.adversarial` now covers all seven cases, and the two new ones changed the
  axis's claim rather than confirming it.** Recorded on `caller-contract` and
  `stale-duplicate` (agy 1.1.19, three samples each). `agy.deep` and `agy.adversarial`
  now span the same seven cases, so comparing those two is comparing prompts and not
  case lists -- not yet true of the axes as a whole, where `gemini.deep` holds five
  and `gemini.adversarial` none.

  Over the original five cases `agy.deep -> agy.adversarial` read recall 0.79 -> 0.72
  with precision and false positives flat, which supported "it reports less, and that
  is the whole of the difference". At seven cases it reads recall 0.76 -> 0.70,
  precision 0.92 -> 0.89, false positives 0.29 -> 0.33: the adversarial prompt still
  does not buy recall, and now it spends a little precision failing to. The trade runs
  the wrong way on both ends.

  Per-case it is not one behaviour either: **84.3** on `caller-contract` against
  `agy.deep`'s 68.3, **55.0** on `stale-duplicate` against 66.7 -- ahead by 16 on one,
  behind by 12 on the other, both inside spreads of 46 and 40. And `stale-duplicate`
  posts 55, 55, 55, which is not stability but the same half-answer three times: the
  v1 copy is missed in every repeat. Zero spread on a cell that fails identically is
  the reading this board already warns about.

- **The scorecard's Source column now names every day a cell holds.** It took the date
  from the first cassette, which is fine only while a cell was recorded in one sitting.
  `agy.adversarial` is the first that was not -- five cases on 2026-08-24 and two on
  2026-08-25 -- and printed a single day for both. That is the failure the version
  column was already fixed for, on a second axis.

- **Failure advice no longer sends everyone one way.** The next steps for
  `timeout`, `no-output`, and `prompt-too-long` were written when AGY was the
  unreliable engine and all pointed at gemini, so a gemini failure got no engine
  advice at all. Field note gi-2026-08-24-b7c1 is the first recorded case of the
  reverse -- gemini stalling for minutes on a diff AGY answered in about 25
  seconds. The two conditions either engine can produce now name both. The
  `prompt-too-long` default is engine-neutral now for a different reason than the
  other two: the cases an engine can be blamed for -- AGY's argv limit and NUL
  bytes -- never reach it, because they throw with their own next step. What
  reaches it is a model's context window overflowing, most often gemini's, so it
  now says to send less rather than to switch engines. That advice is pinned
  where it is produced instead of where it is defaulted. The AGY-only conditions
  -- transcript recovery and its brain directory -- stay one-directional, and a
  test pins both halves of that: the advice must not offer AGY to an AGY failure,
  and must keep offering gemini as the way out.

- **The MCP surface now says which copy of the plugin is answering.** The host
  resolves a plugin to a versioned directory and keeps that server process for
  the session, while the slash surface is re-read on every invocation, so the two
  can run different versions -- and nothing in the session said so. Field note
  gi-2026-08-17-a1c7 recorded a server on 0.17.3 against an installed 0.19.0,
  where a tool was simply absent and the mismatch was found only by reading the
  server process's command line. `serverInfo.version` already carried the answer
  but no host displays it; the running version and script path are now stated in
  the initialize result's `instructions`, which hosts inject into the agent's
  context. `/reload-plugins` remains the remedy -- the resolution is the host's,
  not this plugin's. What is fixed here is the silence.

## 0.22.5 — 2026-08-25 — Neither host reads the manifest the other one's way

- **The Gemini MCP now actually starts under Codex.** 0.22.4 removed the literal
  `cwd` placeholder that failed Windows process creation, on the assumption that
  Codex expanded the script argument. It does not: `codex mcp get gemini --json`
  shows `${CLAUDE_PLUGIN_ROOT}/scripts/gemini-mcp.mjs` reaching `node` verbatim,
  so the server died before `initialize` for a second reason. Codex substitutes
  nothing in `command`/`args`/`env` and resolves `cwd` against the plugin
  directory; Claude Code substitutes in all three and has no `cwd` field at all.
  The manifest now carries the plugin root both ways -- through `env` for the
  host that substitutes, through `cwd: "."` for the host that does not -- and a
  short `node -e` bootstrap uses whichever arrived intact. The launch test runs
  each host's reading, including Codex forwarding no env at all.
- **The bootstrap's start signal no longer escapes into everything the server
  spawns.** `GEMINI_MCP_STDIO` was set in the bootstrap's own environment, and
  the server hands `process.env` to its detached worker, which hands it to the
  CLI -- so any descendant that merely imported the server module took over
  stdin and never exited, hanging a delegated turn that ran this repo's suite.
  The guard now deletes the flag before starting, so it is consumed rather than
  inherited. The bootstrap also drops `||` and `=>`: hosts spawn `node`
  directly today, but one `shell: true` away those are cmd.exe operators, and
  `>` there creates a file.

## 0.22.4 — 2026-08-25 — Start the MCP before it can do anything else

- **The Gemini MCP now starts under Codex on Windows.** Its manifest supplied
  `${CLAUDE_PLUGIN_ROOT}` as both the script location and the process working
  directory. Codex expands the script argument but passed the working directory
  through literally, so Windows rejected process creation with error 267 before
  the server could answer `initialize`. The manifest now inherits the host working
  directory while keeping the script path rooted at the plugin. The launch test
  pins that split and waits for the server process to exit before removing its
  temporary Windows directory.

- **Half of the -13 prompt penalty is now diagnosed, and the other half is now known
  not to be what it looked like.** The board reported that `prompts/review.md`, run
  without tools, costs 13 composite points against the bench's neutral prompt, and
  named that a measurement rather than a diagnosis. An ablation closes part of the gap
  (`bench/ablations/prompt-penalty-2026-08-25.json`, agy 1.1.19, 33 runs).

  The method matters more than the numbers: review.md's *text* was substituted into the
  same single-shot path the `*.model` cells use, with the same diff in
  `{{REVIEW_INPUT}}`, so the prompt string is the only variable. On `async-lifecycle`
  and `auth-basic` that reproduces `agy.shallow` to within 0.3 and 1.0 points, which is
  what rules out the companion's input construction as the cause.

  - **+8.8 of 17.7 is four hedging blocks** (`<calibration_rules>`, `<finding_bar>`,
    `<operating_stance>`, `<grounding_rules>`), acting by suppressing report volume:
    removing them takes findings from 3.83 to 4.83, exactly `agy.model`'s count.
    Removing them in pairs buys ~+4 each in per-case directions that disagree, so no
    single block carries it.
  - **`<review_scope>` is not a cause.** The prediction was that its enumerated
    categories aim attention, so recall should move; recall is 0.867 with and without.
    The +2.0 in composite is inside a band whose single samples run 79 to 96.
  - **The remaining ~6.8 is not suppression.** At half the original prompt length the
    findings count matches the neutral prompt while recall is 0.87 against 0.97 — same
    volume, worse aim. Deciding among what is left (`<role>`, the XML sectioning,
    length) needs more repeats, not more arms, and was not attempted.

  Two limits stated rather than papered over: the ablation covers the file-scoped end
  only, since the largest per-case penalties (-40, -25) sit on two-defect
  repository-scoped cases where one finding is the whole composite; and arm A's
  `REVIEW_INPUT` is the diff alone, where the companion also appends commit history,
  which is the 4.9 residual against `agy.shallow` and why `vacuous-tests` was dropped
  after arm A rather than ablated.

  Across all 33 runs precision never moved from ~1.00. Whatever this prompt spends
  recall on, it is not buying precision with it -- the same signature the adversarial
  axis showed.

- **`bench/README.md` was describing a board that no longer existed.** Six places,
  found by re-deriving every number in the file from the cassettes rather than reading
  the prose:

  - the header and cell table said "three axes, nine cells" and omitted both `*.shallow`
    cells entirely — a table missing a row does not look broken, it looks complete;
  - the adversarial measurement was quoted from the loose matcher: recall
    0.81 -> 0.77 is really 0.79 -> 0.72, precision 0.91 -> 0.92 is 0.88 -> 0.87, and
    false positives 1.67 -> 1.33 is 0.40 -> 0.40. The conclusion survives — the
    adversarial prompt reports less — but the two numbers that made it look like a
    precision-for-recall trade do not;
  - the per-repeat spread table was stale twice over, from re-recording and from
    re-scoring. `agy.model` on `repo-context` was printed as 0, 65, 65; it is
    55, 55, 55, and the +-65 noise band now comes from `stale-duplicate`;
  - three of the four readings under that table quoted lifts and leads that have all
    moved (gemini's lift -0.2 -> +4, AGY's +10.2 -> +14.4, the axis leads 6.4 and 3.2
    -> 8.2 and 2.2);
  - two coverage bullets still said "all five cases";
  - a `lib/report.mjs:48` citation pointed at provenance code; spread is at :59.

  Reading 1 needed rewriting rather than renumbering, because its surviving claim
  inverted. It used to say the deep cells were steady on `repo-context` while the model
  cells thrashed. They now move 43 and 36 there, while `agy.model` posts 55, 55, 55 and
  `codex.model` posts 0, 0, 0 — perfect steadiness that means nothing, because a cell
  that fails the same way every time has no spread. Low spread on this board reads as
  *consistent*, not *trustworthy*.

  The struck-through row for the mislabelled `gemini.deep` was retired rather than
  corrected: its cassettes are deleted, so it cannot be re-scored, and pre-fix numbers
  sitting in a table of post-fix ones is the error this whole pass is about.

  A test now asserts the README's cell table lists exactly the cells in `CELLS`.
  Mutation-confirmed by deleting a row.

- **codex now reads on the two repository-scoped cases too.** `codex.model` and
  `codex.adversarial` recorded on `caller-contract` and `stale-duplicate`, three
  samples each, codex-cli 0.149.0 — twelve live runs, no cassette overwritten.

  | case | codex.model | codex.adversarial | agy.model | agy.deep |
  |---|:-:|:-:|:-:|:-:|
  | caller-contract | 0 | 43 | 0 | 68 |
  | stale-duplicate | 62 | 65 | 43 | 67 |

  `caller-contract` is 0 for both single-shot cells, which is the case working: its
  two defects sit in callers the diff never touches, so there is nothing in the diff
  to find. Codex's adversarial reviewer explores, and it clears its own single-shot
  reading on both — a harness reading, not a prompt one, and the same direction agy's
  `--deep` shows.

  `codex.adversarial` needs `BENCH_CODEX_COMPANION`; without it the cell reports
  `skipped (companion path not configured)` and costs nothing, which is how the first
  half of this recording ran before the variable was set.

- **The scorer credited a finding for naming a defect's subject without making its
  claim.** `repo-context` plants an undeclared dependency with `file: "*"`, so it is
  matched on words alone — and one of those words was the bare module name. Every
  reviewer that discussed `src/token.js` wrote "jsonwebtoken" somewhere, so a finding
  about an unvalidated secret was credited with catching a missing manifest entry it
  never mentioned. `agy.model` on that case was reading 96.7; it is 55.0.

  A ground-truth `match` now takes `all` (every-of: the subject) alongside `keywords`
  (any-of: the claim), and the three wildcard cases declare both. Mutation-confirmed
  against ignoring `all` and against relaxing it to any-of.

  This mattered more than its size: the false credit was worth 42 points to one cell
  and nothing to others, and a board whose whole purpose is comparing cells is worse
  off being wrong unevenly than being wrong uniformly.

  The four file-scoped cases were split the same way. Five defects sharing one file
  also share a vocabulary, and `undefined`, `leak`, `throws`, `memory` and `..` were
  carrying credit with no claim attached to them. Findings matching more than one of
  their case's planted defects fell from 16% to 2.4%, and no cell's mean moved by
  more than 1.5 points — the correction was concentrated, not diffuse.

  What remains at 2.4% is left deliberately: all ten are findings that report two
  defects in one entry ("Plaintext Password Comparison and Unchecked Null User"),
  which the scorer credits once and therefore under-counts. Whether a merged finding
  should earn both credits is a question about the scorer's semantics, not about
  keyword looseness, and it is not answered here.

  A `file: "*"` defect that does not declare `match.all` is now a test failure. There
  the filename disambiguates nothing, so leaving the subject out is silent: the defect
  goes on matching, just too much.

- **The harness lift, split: exploration is worth +28 and the plugin's own review
  prompt is worth −13.** The `*.shallow` control cells now record, and the −4.4 lift
  reported earlier turns out to have been two opposing effects cancelling.
  Measured on agy 1.1.19, seven cases, three samples each: `model → shallow` (prompt
  only) averages −13.3, `shallow → deep` (exploration only) averages +27.8.

  Both halves land where the design predicts. Exploration is worth +68, +61 and +49 on
  the three repository-scoped cases and +2, +2, 0, +12 on the four file-scoped ones. The
  prompt penalty concentrates on those same repository-scoped cases (−40 on
  `repo-context`, −25 on `stale-duplicate`).

  What that penalty is not: not the `DEEP REVIEW MODE` block, which the `*.shallow`
  cells never see, and not a thinner input — probed across all seven cases,
  `REVIEW_INPUT` runs 645 to 1414 characters against a 400,000 cap with the full diff
  present in both arms. It is `prompts/review.md` itself, and what in it costs the
  points is not established. An earlier draft of this entry blamed a prompt "that
  tells the model to fold in dependency manifests, callers and untracked files";
  `review.md` says no such thing — lines 75-80 forbid tools outright.

  Refusing every remaining ambiguous credit takes exploration to +12.5, but that is a
  statement about how a merged finding is counted rather than about the matcher, and
  most of the swing is `caller-contract`, where two of the four recorded findings
  report both planted defects in one entry.

  Two defects had to be fixed to get the reading. The runner decided whether to
  materialize a repository from `harness === "agentic"`, which is true of every cell
  that runs a companion except these two — so they ran with `--cwd` pointing at
  nothing. `needsRepo` is now declared on the cell instead of inferred.

- **`ensureGitRepository` stops blaming PATH for a directory that does not exist.**
  spawn reports ENOENT for both absences and names the command in `error.path` either
  way, so a missing `cwd` surfaced as `git is not installed. Install Git and retry.` on
  a machine with git plainly installed — and sent this session to debug PATH. It now
  checks the directory and says which absence it found. Mutation-confirmed.

- **Two repository-scoped corpus cases, and the first evidence on this board that
  exploration does anything.** The harness axis existed to measure defects a reviewer
  can only find by looking beyond the diff, and exactly one case
  (`repo-context`) planted any. `caller-contract` changes `findUser`'s return shape —
  a clean refactor read on its own — while two callers the diff never mentions keep the
  old contract, one of them an `if (user && user.role === "admin")` check that is now
  always truthy. `stale-duplicate` fixes a crash in `src/api/v2/validate.js` while an
  identical `v1` copy keeps it, and adds a worker reading a `config.maxBatch` that
  `config/default.json` does not define.

  Measured on agy 1.1.19, three samples: `caller-contract` is **0 → 68** from
  `agy.model` to `agy.deep` — the single-shot cell misses both defects outright — and
  `stale-duplicate` is **43 → 67**. Both gaps are far outside any band on the board,
  against a whole-corpus harness lift of −4.4. The negative lift was corpus
  composition, not a finding about exploration.

  The gemini cells could not be recorded on either case, and the reason is no longer
  confined to heavy prompts: `gemini.model` on `caller-contract`'s 21-line diff timed
  out twice at the 180s cap, on a case `agy.model` answers in ~25s, hours after the same
  cell recorded all five original cases. agy is unaffected throughout. Field notes
  updated; codex cells not attempted this round.

- **The harness lift now says what it actually spans.** The number is a
  `model → agentic` composite delta presented as the harness's contribution, and it
  changes three things at once: the prompt (the neutral 33-line bench prompt versus the
  plugin's 84-line `review.md`), the input (a diff embedded in the prompt versus a
  repository to find it in), and whether tools are allowed. Isolating exploration needs
  a cell holding the first two fixed, and there is not one.

  Two further limits are written down beside it. The sign is a fact about corpus
  composition — per-case deltas on the current five cases run from −20 to +17 on both
  engines, so the reported −4.4 and −4.6 say as much about which cases exist as about
  any harness. And exactly one case plants repository-scoped defects (`file: "*"` in
  `repo-context`'s ground truth), so the capability the axis exists to measure rests on
  a single case. What would help is cases of that kind, not repeats: the README's own
  finding 4 already explains that the spread statistic is a range and cannot shrink
  with sampling.

  Documentation only — no cassette, cell or scoring rule changed.

- **The bench grew a third axis: each tool's adversarial reviewer, measured
  separately from its default one.** `gemini.adversarial`, `codex.adversarial` and
  `agy.adversarial` join on a new `plugin-adversarial` track, and the scorecard ranks
  them in their own row. They are not more entries on the harness axis on purpose:
  `prompts/review.md` asks for a pragmatic review and `prompts/adversarial-review.md`
  asks the model to break confidence in the change. Ranking one against the other
  would have been the third instance today of a column stating what it was supposed to
  hold rather than what it holds.

  The reason first written down for that separation was a prediction, and it was
  wrong: with composite weighted `recall*70`, the adversarial prompt was supposed to
  win the column by trading precision for recall. It does the opposite. `agy.deep` ->
  `agy.adversarial`, five cases x3 on 1.1.19: recall 0.81 -> 0.77, precision
  0.91 -> 0.92, false positives 1.67 -> 1.33. The comments, this entry and the bench
  README now carry the measurement instead of the guess. The axis stays separate
  because the prompts are not interchangeable, which was the part that did not depend
  on which way the scores fell.

  `runCompanionReview` gained a `subcommand` option (default `review`, so every
  existing cell is unchanged) and the three cells pass `adversarial-review`. Both new
  behaviours are mutation-confirmed — including, on the second attempt, the axis test:
  the first version asserted only that a row with the right title was printed, which
  still passed when the axis was pointed at the harness track. It now asserts which
  cells' numbers land in which row.

  `codex.adversarial` and `agy.adversarial` are recorded on all five cases
  (codex-cli 0.149.0, agy 1.1.19, three samples each). This is also the only axis codex
  can be measured on at all while #679 stands.

- **The gemini cells are on 0.56.0, except where the engine stops answering.**
  `gemini.model` recorded all five cases; `gemini.deep` recorded four. On
  `vacuous-tests` a `--deep` review returns nothing at 420s — empty stdout, empty
  stderr, reproduced three times — while the other four finish in ~35s, so that cassette
  stays at 0.55.1 and the scorecard now shows the mixed read rather than hiding it.
  `gemini.adversarial` could not be recorded at all: both cases attempted were killed
  at the cap with no output, though the same cases complete under `review --deep` and
  every adversarial case completes under `--engine agy`. It tracks prompt weight on the
  gemini engine, not the case and not the subcommand. Logged to field notes.

- **The bench cassettes were re-recorded toward one version per tool, and the two
  cells that could not be are now documented with the reason.** `codex.model` is the
  one that finished: all five cases on codex-cli 0.149.0, three samples each, which
  closes the three cases that had been skipped since the account hit its usage limit
  and re-records the two that were still on 0.147.0. `agy.model` and `agy.deep`
  followed on 1.1.19, all five cases each. `gemini.model` and `gemini.deep` did not
  move.

  What blocked each one is the useful part. AGY refused the fifth `agy.model`
  recording, and `agy.deep` with it, with `Individual quota reached ... Resets in
  94h2m50s`; once the account reset both cells were finished, so AGY now reads as one
  version across all ten cassettes. The gemini cells need a
  credential this machine does not currently have: the stored OAuth token expired
  2026-08-20 and no `GEMINI_API_KEY` is exported, which leaves them one patch version
  behind (0.55.1 against a local 0.56.0) — the smallest drift on the board.
  `codex.native` runs now that `BENCH_CODEX_COMPANION` points at codex plugin 1.0.6,
  but its `--json` payload carries no `result` — by construction, not by failure. In
  1.0.6 `review` maps to codex's built-in reviewer, which returns prose and a payload
  with no `result`, `rawOutput` or `parseError` key at all, while `adversarial-review`
  passes `--output-schema` and does emit a `result` conforming to the plugin's own
  review schema. The adapter scores `payload.result`, so all five cases skip; pointing
  the cell at `adversarial-review` instead would change what it measures, so that is a
  decision rather than a fix. Filed upstream as openai/codex-plugin-cc#679. A failed live record leaves the previous
  cassette untouched, so nothing was lost to any of this.

- **A bench cell recorded on more than one version now says both.** The scorecard
  took the first cassette's provenance to stand for the whole cell, which held only
  while every case in it shared a version. `agy.model` stopped sharing one the moment
  its fifth re-record was refused: four cases on 1.1.19, one still on 1.1.15, and the
  table printed `1.1.19` for all five. That is the `gemini.deep` mix-up in miniature —
  a column stating what it was supposed to hold rather than what it holds — so the row
  now reads `live 2026-08-24 · 1.1.19 ×3 · 1 case on 1.1.15`, and a cell with one
  version says nothing extra. Mutation-confirmed.

- **The bench's AGY adapter now prints the reason AGY gave for refusing a run.** AGY
  puts a refusal in the JSON envelope's `error` and leaves stderr empty, and the
  failure message echoed stderr alone — so a spent account rendered as
  `agy: could not parse review JSON ()`. Three re-recording attempts were spent
  reading that as a parser or model defect before the envelope was opened by hand and
  said `Individual quota reached`. The message now prefers `envelope.error`, and
  `runAgyModel` gained the same `spawnImpl` seam its companion neighbour already has
  so the behaviour is tested through the function that performs it, plus a
  `resolveBinaryImpl` seam — without it the binary lookup runs first and every machine
  with no `agy` on PATH returns `no agy executable on PATH` before reaching the
  behaviour under test, which is exactly how the first version of this test passed
  locally and failed on all three CI runners. Mutation-confirmed: reverting to
  stderr-only fails the new test, on a PATH with agy and on one without. The codex branch had already learned
  this exact lesson from its own usage limit; the comment there now has a twin.

- **First AEO baseline: Codex answered all five benchmark queries, and the health
  score is 0%.** `bench/aeo-responses/` had a format, a provenance rule and a runner,
  and nothing to score. It now holds five captured answers — one per query in
  `BENCHMARK_QUERIES` — taken from `codex exec --ephemeral --ignore-user-config
  --skip-git-repo-check -s read-only` with its working root pointed at an empty
  directory, one fresh session per query, each query pasted verbatim. Measured
  2026-08-24 on codex-cli 0.149.0.

  Direct recommendation 0%, citation inclusion 20%, average keyword coverage 55%,
  overall 0% over 5 of 5 queries. The report itself is not committed —
  `docs/benchmarks/` is gitignored, so this entry is the record.

  What the number is actually made of, because "0%" on its own would be read as
  "the assistant knows nothing":

  - Q1 (heterogeneous adversarial review in Claude Code) is the only query that
    triggered no web search at all, and it recommended `/ccg` — a different tool.
    Run twice, same answer, so that is the model's prior, not sampling noise.
  - Q3 is the one query that cited a repository URL, and its answer is accurate down
    to `shell:false`, stdin-delivered prompts, and `.env*` redaction being a
    `/gemini:transfer` guarantee rather than a review-wide one — after twelve web
    searches. It still scores as not-recommended, because the pass rule wants the
    brand in the *first paragraph*. So the 0% pass rate is a placement failure on
    that query, not an ignorance failure.
  - Q4 recommended somebody else's project (`kriscendobot/garden`); triad-flow did
    not appear.

  Each fixture's provenance line carries its own `web search:` count, which is the
  variable that separates Q1 from the rest. The first version of these lines claimed
  "no web search" for all five; the run JSONL says that holds only for Q1, and the
  lines were corrected before scoring.

- **The AGY version gates were re-measured against 1.1.19; no threshold moved.**
  Seven releases landed between 1.1.12 and 1.1.19, and two of them read like they
  could have broken the wrapper: 1.1.17 consolidated the agent execution harness
  onto a single path, and 1.1.18 made a valueless prompt flag and a stray trailing
  argument into errors. Neither touches the argv this plugin builds — the stdin
  path emits no `--print` at all and nothing but flag/value pairs, and the
  positional path passes `--print <prompt>` with its value attached.

  Measured, not read off the notes, and through `detectEngine` + `buildCliArgs` +
  `runCommand` rather than a shell (a leading `/` handed to `agy` from Git Bash is
  rewritten into a path, which is how an earlier attempt spent a real turn and
  measured nothing). Six of the seven gates cost nothing to check, because a
  read-only slash command carries the whole argv without starting a turn:
  `supportsAgyStdinPrompt`, `supportsAgyStructuredOutput`,
  `supportsAgyStreamJson`, `supportsAgyWorkspaceDir` and
  `supportsAgyReadOnlySlashCommands` all hold in one `/quota` run reporting
  `num_turns: 0` with every token count at zero, and `supportsAgyModelSelection`
  holds in a `/model` run that reports back `gemini-3.1-pro-high`,
  `is_default: false`. Only `supportsAgySlashCommandOptOut` needs a real turn to
  prove — with the flag set, `/quota` reaches the model as literal text, which is
  the flag working — and that one cost 22,146 tokens.

  Two findings that change nothing in the code but are worth writing down. AGY
  rejects `--effort` on its own with `--effort is not supported for the current
  model` on this account, because the OAuth model list bakes the effort tier into
  the id (`gemini-3.7-flash-high`); the refusal arrives as a well-formed ERROR
  envelope with exit 1 and zero tokens, so it fails legibly rather than silently.
  And `agy models --output-format json` still prints usage and ignores the flag on
  1.1.19 (upstream issue #777, still open); this plugin never invokes those
  subcommands, so it is unaffected.

## 0.22.3 — 2026-08-24 — What the plugin actually handed its caller

Both entries are the same shape: the plugin produced something, a consumer needed
it, and nobody had checked that the consumer could read it. One was a field that was
never written; the other was a whole payload that was written and then rejected.

- **The stop-review gate emitted a `decision` the Stop schema rejects.** Letting a
  stop through means *omitting* `decision` — the schema accepts only
  `"approve"` | `"block"` — and three of the gate's four exits wrote
  `{"decision": "proceed"}`. Claude Code answered with
  `Hook JSON output validation failed — (root): Invalid input` and acted on none of
  the payload, so on those three paths the gate had never delivered anything: not the
  silent pass, not the clean verdict, and not the `systemMessage` that the fail-open
  branch exists specifically to make visible when the review could not run. The
  `needs-attention` path uses a legal value, was not reached in the observed failure,
  and is unchanged.

  The two stop-gate tests read `decision.decision === "proceed"` straight off the
  implementation, which is why they stayed green while the output was being thrown
  away downstream — they pinned the value the hook happened to write, not the
  contract it has to satisfy. They now assert that no `decision` key is present.
  Mutation-confirmed. The same schema rule had already been found and fixed once in
  `~/.claude/hooks/unreviewed-changes-stop-hook.mjs`, with a comment spelling it out;
  it never reached the plugin, so a comment above `emitDecision` states it here too.

- **`review --json` reports the engine that ran.** The payload carried the review, the
  target and the engine's raw stdout, but never which engine produced them. Under
  `--engine auto` — or `GEMINI_ENGINE`, which applies to every process a session
  spawns — the engine that ran and the one the caller asked for are different values,
  and only the requested one was ever recorded (on the job record, not in the payload).
  A consumer had no way to ask.

  Found from downstream: `bench`'s `gemini.deep` cell had been recording AGY for its
  entire life, because it passed no `--engine` and this machine sets
  `GEMINI_ENGINE=agy` in `~/.claude/settings.json`. Its cassettes were stamped
  `gemini --version` regardless, so the harness axis was comparing AGY against AGY and
  a README claim that "`gemini.deep` is the steadiest cell on the board" was AGY twice.
  Pinning the flag fixes that cell; a payload that names the engine is what lets any
  consumer detect the next one. Additive field, `engine: "gemini" | "agy" | null`.

## 0.22.2 — 2026-08-19 — Which credentials AGY actually accepts

`/gemini:setup` and `--probe-agy` both told a user with a working AGY account to go
and authenticate. AGY has taken non-interactive credentials since 1.1.10 (ADC,
Enterprise/WIF) and since 1.1.13 a `GEMINI_API_KEY` routed through
`modelProvider: "gemini"` in settings.json — a settings file plus an environment
variable rather than a flag, which is why reading `agy --help` and concluding the
capability was absent is exactly how it was missed. The absence was checked on the
wrong surface.

Two of the entries below partly cancel each other: the first said a route was
untested, the second tested it.

- **AGY's non-interactive credentials are named where the plugin asks for one.**
  `getAgyLoginStatus()` and the `--probe-agy` rejection both told the user to run
  `agy` interactively, and that has not been the only way for a while: AGY 1.1.10
  added ADC and Enterprise/WIF, and 1.1.13 added `GEMINI_API_KEY` through
  `modelProvider: "gemini"` in settings.json. That last one is a settings file plus
  an environment variable rather than a flag, so reading `agy --help` and concluding
  the capability was absent is exactly how it was missed here — the absence was
  checked on the wrong surface. `commands/setup.md` and both READMEs say the same
  thing now.

- **`--probe-agy` is verified against the API-key route.** Measured on AGY 1.1.15 in
  a temporary home containing nothing but `{"modelProvider":"gemini"}`, with the
  same home and no key as the negative control: keyed, `probeAgyLogin()` returns
  `verified` and spends no turn; unkeyed, it returns `unknown` carrying AGY's own
  "GEMINI_API_KEY is not set" diagnostic. Both directions are right, and in
  particular a misconfiguration is not promoted to `logged-out` — which is the step
  that would have made `readyState` `not-ready` for an install whose turns work.
  ADC and Enterprise/WIF remain untested and are still marked so.

- **`docs/THREAT-MODEL.md` 7.2 re-measured on AGY 1.1.14 and 1.1.15; the residual is
  unchanged.** 1.1.15 ran the same five rows as 1.1.14 — same probe, same disposable
  root on `D:\`, one variable — and four of four configurations again wrote an absolute
  path outside the workspace they were bound to, the plugin's read-only `--add-dir`
  shape included. Three consecutive releases now. One thing the 1.1.15 pass turned up
  and could not reproduce: two rows returned `status: ERROR` in the envelope while
  writing the file and exiting 0, and re-run immediately both returned `SUCCESS`. No
  mechanism is claimed; it is recorded because it points the wrong way — a turn
  reporting an error may still have changed the tree, which is why
  `lib/readonly-guard.mjs` compares the workspace instead of reading `status`.

  On 1.1.14: its release notes say the setting that allows access outside your
  workspace "now grants only read access", which is aimed squarely at that
  residual. It does not reach headless print mode: five runs, and all five wrote an
  absolute path outside the workspace they were bound to — including `--add-dir`,
  the shape a read-only turn takes. The fifth is a positive control writing inside
  the workspace, because without it a prompt the model never acted on and a boundary
  that held are the same observation. Recorded limit: the machine's settings carry
  `"toolPermission": "always-proceed"` and AGY has no flag or environment variable
  that overrides a settings file, so that variable was not controlled.

- **Known, from AGY 1.1.15's release notes rather than from a measurement here:**
  AGY 1.1.15 fixes streamed text corrupting non-ASCII characters into replacement
  characters in `--output-format stream-json` text deltas. The plugin uses
  stream-json from AGY 1.1.12 up, but takes a completed turn's text from the
  terminal envelope; the concatenated deltas are read only when the envelope
  carries no text (`lib/gemini.mjs`, the salvage path for a run that was cut off).
  So on AGY 1.1.12 through 1.1.14 the text salvaged from an interrupted run could
  lose non-ASCII characters, while completed runs were unaffected. This was not
  reproduced — AGY updated itself to 1.1.15 mid-investigation and 1.1.14 was no
  longer available to test against.

## 0.22.1 — 2026-08-19 — A cancel that checks what it killed

`/gemini:cancel` kills the worker with `taskkill /PID <worker> /T /F` and described
the result from that command's exit code. Under load it could report "terminated
the running process" while the engine the job started kept running: in one
captured run the engine was created 484ms before the cancel finished, and was
still alive 74 seconds later, still holding the job's workspace as its working
directory.

taskkill's tree walk is not usually what kills that engine: killing a worker with
`/F` alone and no `/T` takes its engine with it, measured here on a staged job.
What performs that collection was not identified — the engines are in no job
object, and it is not the stand-in's hold on stdin — so what a cancel escapes is
named here only by what it does. taskkill, which did kill the worker, exits 0 and
says so honestly.

The exit code is no more useful in the other direction. Over 36 cancels under
load, 15 reported "some processes the OS reported as its descendants could not be
killed" and exactly one leaked an engine: that message is mostly strangers
inherited through a reused pid, which Windows lets go on naming a dead parent.

So the tree is measured after the kill rather than read off an exit code — the
same move 0.20.1 made for the target pid itself. Once the worker is gone its
children are queried by pid, anything created after the job started is killed,
and the report describes what is left. What keeps that safe is the comparison
against the job's start time: pids are reused and the parent link is never
cleared, so the query can name processes belonging to an earlier owner of that
number, and those predate the job. Given no start time the sweep does nothing at
all.

"Once the worker is gone" is load-bearing. `taskkill /F` returns before the kernel
has finished the teardown, and a worker that is still running can still start an
engine — the very moment this is trying to catch — so a listing taken then can be
stale before it is read. The pid is waited out first, and a process that no longer
exists cannot start anything: the set of children it left is final, so one query
sees all of it and no second pass or settle delay could add to it. A worker that
somehow outlives its own kill still gets swept, but its tree is no longer called
finished.

Which of the two existing messages a run gets is now decided by measurement, so
the caveat appears when something of the job's really is still running and stays
away when it is not. Both now carry a count, because the sweep knows one: a
cancel that had to clean up says "terminated the running process, and 1 process
it had left running", and one that could not says how many it could not kill
rather than "some processes". The wording for a tree that could not be measured
at all is unchanged, and so is every other message. A cancel with a live
worker costs about 350ms more than it did — 335ms to 688ms measured, all of it
the one child-process query. `wmic` is gone from Windows 11 26200, so that query
is PowerShell, resolved absolutely like `where.exe` and `taskkill.exe` already
are.

## 0.22.0 — 2026-08-18 — Cancel a group; say which copy of the plugin is answering

### `/gemini:cancel <group-id>`

`status` and `result` have always accepted an adversarial-review group id and
aggregated over its members. Cancel matched job ids only, so a group had to be
cancelled one engine at a time, from ids the user first had to go and read out of
a status listing — and a group id came back as "No active job found", which is
the one thing it was not.

Cancel now reuses the pattern the other two already use: try the group, fall back
to a single job. Every member still queued or running is cancelled; members that
already finished are left exactly as they are, because "cancel" has nothing to
say about work that is done. The report lists each member and what its
termination actually reached — one engine can have finished while the other was
still running, and a single summary line would hide that.

A group whose members have all finished now says so, with a pointer to
`/gemini:result`, instead of reporting the id as unknown. The single-job path,
its payload shape and its messages are unchanged: every existing caller reads
`payload.jobId`, and that still means what it meant.

### `/gemini:setup` names the plugin that is answering

A session can stay wired to an older cached copy of the plugin after an update.
Field note `gi-2026-08-17-a1c7` recorded one running 0.17.3 while the installed
manifest said 0.19.0: fixes believed shipped were absent from both the MCP and
the slash surface, and nothing in the session could say which version was live.
It was found by reading the MCP server's process command line.

The cache resolution is Claude Code's and `/reload-plugins` is the remedy —
neither is this plugin's to fix. The silence is. `setup` now reports
`pluginVersion` and `scriptPath`, both read relative to the running script, so
they describe the code that is executing rather than what a manifest elsewhere
claims. The version comes from the same `plugin.json` Claude Code consults first
(see `docs/version-sources.md`). It is on the ordinary report, not only in
`--json`: a user who has to ask for JSON to discover a stale copy will not think
to ask.

This does not detect the mismatch — it makes it visible in one command. The field
note stays open.

## 0.21.1 — 2026-08-18 — A copy of someone else's list, kept by hand

`lib/model-map.mjs` carried a comment listing what `agy models` returns, dated to
AGY 1.1.10 on 2026-08-05. Read again on 1.1.13 the real listing has 14 ids where
the comment named 11: the whole Gemini 3.7 Flash family arrived and nothing said
so. Nothing was broken by this, which is the point — no code reads that list.
`normalizeAgyRequestedModel` validates the character set and rejects Gemini
aliases; it never compares against a roster. The comment was a copy of another
tool's output that could only drift, and nothing could notice when it did.

It cannot be kept honest automatically either. `agy models` on 1.1.13 accepts
only `-h`/`--help`, so there is no machine-readable form to diff a copy against,
and the probe needs AGY installed, which CI does not have. (This plugin's 0.19.0
entry says AGY 1.1.12 added `--output-format json` to `agy models`. That is not
true of 1.1.13. The entry stands as written — a released changelog is a record of
what was believed, and correcting it in place would erase that.)

So the comment now keeps the part that does not change — AGY encodes the effort
tier into the id, which is why no AGY id is ever valid in this map and why
`--model` and `--effort` cannot be combined — with one id as an illustration of
the shape, and points at `docs/MODEL_COMPARISON.md` §D for readings. That
document already existed to hold dated probe records; the 2026-08-18 reading on
1.1.13 is now there in full. A test keeps the roster from coming back, and keeps
the pointer resolving.

Two follow-ups in `docs/known-diffs.md` were re-checked against the code rather
than carried forward:

- **`/gemini:cancel <groupId>`** is still not group-aware, confirmed. The entry
  now names `resolveCancelableJob` and says what a user actually sees — "no
  active job found", not a partial cancel — and notes that the aggregating
  pattern cancel would reuse already exists.
- **Partial dispatch rollback** was overstated. Every selected engine is
  validated before the first detached worker is spawned, so a validation error
  can no longer orphan an earlier group member. Only a failing spawn can, which
  is narrower than the entry claimed. Still deliberate, now accurately described.

Documentation and tests only; no runtime behaviour changed.

## 0.21.0 — 2026-08-18 — The timeout flag nobody could reach

`--timeout <seconds>` has been parsed by the CLI since it was added, and was
offered by neither surface a user actually drives. The slash commands assemble
their calls from a whitelist of checked literal flags, and `--timeout` was not on
it; the MCP tools declare `additionalProperties: false`, and none of their
schemas had it. So the AGY default of 120 seconds was, in practice, not a default
but a fixed limit.

That limit is what both 2026-08-17 timeout incidents hit — the ones v0.20.0
taught the plugin to *report* honestly. This is the other half: the number is now
adjustable by whoever is paying for the run. `lib/gemini.mjs` had already
recorded the gap in a comment; nothing had closed it.

The window is also a ceiling on output size, which is the part that is easy to
miss. A turn that cannot finish emitting its answer inside the window is killed
with nothing to show, so a large batch or a `--deep` review over a wide diff hits
the timeout as a size limit long before it hits it as a patience limit. Every
place the flag is now documented says so, because "it timed out" reads as "it was
slow" and sends people to make the prompt wait rather than make it smaller.

Reachable from:

- `/gemini:review`, `/gemini:adversarial-review`, `/gemini:rescue` — argument hint
  and flag whitelist, with the same digits-and-range check the other values get
- `gemini_rescue`, `gemini_review`, `gemini_adversarial_review` over MCP, with
  bounds declared from the runtime constants so the schema cannot drift from what
  is enforced

`/gemini:rescue` does not call the runtime itself; it forwards to the
`gemini:gemini-rescue` subagent, which builds the `task` call from its own
instructions. Those now name the flag too — one preserved by the command and
unknown to the subagent would be preserved into nothing, and a test pins both
halves.

The range check moved into a single exported function rather than being written
twice. A caller arriving over MCP is held to the same 30–3600 rule as one typing
the flag: a client is expected to enforce a declared schema, but nothing makes
it, and an unchecked value becomes a `spawnSync` timeout nobody chose.
## 0.20.1 — 2026-08-18 — A cancel that worked, reported as a failure

`/gemini:cancel` could kill the job it was aimed at, report an error, and leave
the cancellation unrecorded. The job was then reconciled as a stale one minutes
later, so the user saw a failed cancel followed by a failed job — for work that
had in fact been cancelled.

Windows never clears a process's parent link when the parent exits, so a reused
pid inherits whatever processes still name it as their parent. `taskkill /T`
tries to kill those too, and exits 128 when it may not. Observed on this
repository's own reviewer demo: two system processes were reported as descendants
of a job worker, taskkill refused them ("the attempted operation is not
supported"), and `terminateProcessTree` treated the non-zero exit as fatal — even
though the worker itself was gone. Intermittent, because it needs a pid
collision, which is why it surfaced as a flaky test rather than a bug report.

The exit code cannot answer the question that matters, so it is no longer asked
to. When taskkill reports trouble, the process itself is checked, with a short
bounded settle window because `/F` returns before the kernel has finished the
teardown. Gone means the cancel worked; still running still raises. Measured
rather than parsed: taskkill's per-process SUCCESS and ERROR lines are localized,
and a check that reads them works only in the locale it was written for.

A cancel that could not reach every claimed descendant now says so instead of
silently reporting a clean kill. The job's own process is gone either way, but
something the OS named as underneath it survived, and that is not visible
anywhere else.

Also here: `scripts/reviewer-demo.mjs` waited a fixed two seconds for a worker to
start before cancelling it, which is a guess about a machine's scheduling. It now
polls for the state the step needs. And "is this pid alive" had two
implementations; there is one now, in the process module, with the injection seam
its callers use unchanged.

## 0.20.0 — 2026-08-18 — What a run that was cut off hands back

Two field notes from dogfooding v0.19.0, both about the same moment: AGY is
killed by the plugin's 2-minute cap while the turn is still going. Neither was a
crash. Both produced a confident report of something that had not happened.

### The event log was relayed as the model's answer

A `--output-format stream-json` run that produced no assistant text handed back
the JSONL event stream itself, framed by the delegated-output marker as though it
were the reply. Measured on a real run: 84 event lines, 194,226 tokens, not one
`text_delta` among them, relayed verbatim to the caller. Every line is valid
JSON, so nothing downstream could tell it from an answer — and on the review path
it would have been parsed for findings.

The cause was a default. `finalMessage` started as the raw stdout and was only
overwritten when the structured result had text, so an empty result left the raw
stream standing. A stream now always speaks through the structured result, empty
included. Below the stream-json gate the raw-stdout fallback stays: there it is a
malformed envelope, which is a diagnostic worth showing rather than noise.

A run that returns nothing now says so, and says what it cost. The envelope
carries the turn's token usage even when it has no response to show for it, and
194,226 tokens spent and 2,000 call for different decisions.

### A finished answer was filed as a failure

The other run produced its entire deliverable — seven findings, both closing
sections, nothing truncated — and was stored as `failed` with "Retry later,
reduce prompt size or review scope". For that run, the advice buys a second
identical answer at full price.

Jobs now have a third terminal status, **`partial`**: text came back, and nothing
established that it is the whole answer. It is set by the two paths that know it
first-hand — the stream's salvaged deltas, and an unfinished transcript row — not
inferred from the failure category. A `partial` job keeps its failure object,
because that is where the next step lives, and `/gemini:result` reads it back
like any other finished job.

The engine's envelope is still the only thing that makes a run a success; that
did not change. What changed is what the report says when the envelope never
arrived. When the last stream event is an `agent_response` that reached DONE, the
recovered text is a finished block, and the next step says to read it rather than
to retry — a claim about the text in hand, not about the turn. The measured
stream has an `agent_response` reach DONE at step 2 and then run tools through
step 55, so an answered block is not an ended turn, and this does not pretend
otherwise.

If you consume job status over MCP or from `--json`, this is the change to know
about: a comparison against `"completed"` alone will now miss runs that produced
output. Both job-oriented MCP tools describe the state, and `/gemini:status` is
told not to report it as a failure. The stop-time review gate treats it as
finished work — a `--write` turn cut off partway has still edited the working
tree, and those are exactly the edits nobody has reviewed.

## 0.19.1 — 2026-08-17 — The instructions the subagent loads, checked against the code

`plugins/gemini/skills/` is not commentary. The `gemini:gemini-rescue` subagent
loads those files and follows them. Nothing tested them, so they drifted three
releases behind the code that is supposed to be their subject, and one of the
drifted lines was a safety default.

### `--write` was documented as the default in three places

v0.16.0 inverted the rescue default and said so in `agents/gemini-rescue.md:34`:
"Do NOT add `--write` unless the user asked for edits." Two lines of
`skills/gemini-cli-runtime/SKILL.md` and one of
`skills/gemini-prompting/references/gemini-prompt-recipes.md` still said the
opposite. The subagent loads both documents in the same turn, so which
instruction won was undetermined — and an AGY `--write` run has no path boundary
([`docs/THREAT-MODEL.md` §7.2](../../docs/THREAT-MODEL.md)). The stake was
whether "investigate this" could edit your repository.

### `--model` and `--effort` were documented as ignored on AGY

Five places said AGY leaves model choice to its own configured default and that
these flags are not translated. False since AGY 1.1.10: `buildCliArgs` in
`lib/engine.mjs` pushes both to the AGY command line. What the flags actually
require is now stated — an exact ID from `agy models` via `--model`, or a native
`low`/`medium`/`high` via `--effort`, never both, and Gemini aliases are rejected
for AGY. `--effort`'s accepted set is documented per engine rather than
unconditionally, since `normalizeAgyEffort` throws on the other four values.

### AGY was documented as returning unstructured output

Two places said the response is plain text and that the on-disk transcript is
authoritative. Since v0.11.0 the plugin reads AGY's JSON envelope and does not
touch the transcript at or above AGY 1.1.8; transcript recovery is the fallback
below it. The engine-routing rationale was wrong for the same reason — it claimed
gemini wins on its JSON contract, when `detectEngine` picks gemini only when it
is installed **and** holds a usable credential.

### The alias list named three of nine

`skills/gemini-cli-runtime/SKILL.md` listed `flash`, `pro`, and `lite`.
`MODEL_ALIAS_ENTRIES` has nine.

### A test now holds all four in place

`tests/skills-drift.test.mjs` scans the 18 instruction documents under
`agents/`, `commands/`, `skills/`, and `prompts/`. `CHANGELOG.md` is excluded by
using a directory allowlist rather than an exclusion list, because a changelog
legitimately quotes the wording a release removed — including this one.

Three of the four rules are worded blacklists, which are only worth what a
mutation proves. Each pre-fix sentence was restored, the suite run, and the
failure checked to be an assertion in the intended rule rather than a load
error: six mutations, six kills, one failing test each. The fourth rule is a
positive assertion against `MODEL_ALIASES`, so adding an alias to
`model-map.mjs` turns the documentation red until it is written down.

### Notes

- No runtime behavior changed. `plugins/gemini/scripts/` is untouched; it was the
  authority this release was checked against, not the subject of it.
- The audit and the edits were dispatched to the plugin's own AGY backend. Across
  six runs it produced no fabricated citation, and its one review finding — a
  `SyntaxError` claimed at confidence 1.0 in a regular expression that compiles
  and runs — was rejected.

## 0.19.0 — 2026-08-17 — What it reached, what it wrote, which engine it used

Three things a run could not tell you afterwards, and one it wrote without asking.

### A timed-out AGY run reported nothing at all

When AGY's own print timeout fires it emits a well-formed envelope whose response
is empty — `{"status":"ERROR","response":"","error":"timeout waiting for
response"}` — so the plugin had a valid answer meaning "nothing". Measured on the
run that prompted this: **193,772 tokens spent, and one line saying it timed out.**

From AGY 1.1.12 the engine is asked for `--output-format stream-json`, which emits
one JSON object per line as the turn happens. The terminal envelope still arrives
as the final event, so success is unchanged; a run cut off partway now reports how
far it got and keeps the answer text already written:

    Failure: timeout (retryable)
    Summary: The CLI command timed out. (reached step 11 agent_response (ACTIVE);
    partial output preserved)

Two assumptions this started from were wrong, and finding that out changed the fix.
The lost tokens were not a half-written answer — that transcript has an empty
response and 272 characters of thinking about reading `hooks.json`, so the turn
timed out while still exploring; the goal is that a cut-off run says what it
reached, not that a never-written answer is recovered. And no async rewrite was
needed: `spawnSync` keeps what a child had written when its timeout kills it
(20/46/94 lines survived timeouts of 800/1500/3000 ms against a child emitting
every 20 ms). Two earlier measurements said otherwise and both were wrong — the
child had died on a quoting error without writing, which shows as
`status: 1, signal: null` rather than a signal. A streaming spawn was written for
this and then removed rather than kept as a second spawn implementation with its
own Windows resolution rules.

Salvaged text never overrides a response the envelope carried, and never makes a
run count as successful: the envelope stays the authority on completeness, so a
partial result cannot pass for a whole one. Gated at 1.1.12, where it was
measured; below that, plain `json` is unchanged.

### A transfer snapshot could be committed into your repository

A snapshot's `gitDiff` field holds the entire uncommitted diff, and both READMEs
said the workspace-local `.omc/` directory was excluded from version control. That
exclusion existed only in *this* repository's `.gitignore`. Anywhere else the
snapshot was merely untracked — it appeared in `git status`, and `git add -A`
committed it, diff and all.

`/gemini:transfer` now writes `.omc/.gitignore` containing `*` when it creates the
directory, which ignores the contents and the ignore file itself, so nothing has
to be added to the host repository. An existing `.omc/.gitignore` is never
overwritten: it may say something deliberate. Pinned with a real `git check-ignore`
in a fresh repository, because nothing else settles whether a rule applies.

### A running job could not say which engine it chose

The engine was written onto the job record only on completion, so a running job
had no answer — and under `auto` that is the field that says whose quota is being
spent. The asymmetry that surfaced it: a background review carried `engine` from
queued, a background task never did, because only the review call site passed it.

The resolved engine now travels on the same progress event that announces the
turn — the pipeline already carrying `phase`, `threadId` and `turnId` — so every
job kind answers it while running, `auto` included, with no extra detection. The
queue-time value stays but no longer records `"auto"`: that is a request to decide
later, not an engine, and a field readers take for the engine in use must not hold
one.

### Adversarial review was unreachable from MCP

`/gemini:adversarial-review` has existed since it shipped and both READMEs list it
under Features, but the MCP tool list held five tools, none of which could select
the template and none of which said why — for an agent driving the plugin through
MCP the feature was absent rather than declined. `gemini_adversarial_review` is a
separate tool rather than a flag on `gemini_review`, because the two differ in the
template they run and an agent choosing by description picks better than one
guessing at a boolean. It takes `focus`, matching the slash command;
`gemini_review` does not, and refuses one rather than dropping it.

### Engine

**`--mode plan` is tested and not adopted.** AGY 1.1.12 fixed `--mode` being
ignored in headless `-p` runs, which made it worth testing against the "AGY has no
read-only mode" premise in `docs/THREAT-MODEL.md` §7.2. Six runs on 1.1.13: it
refuses the edit tool and lets a shell command write the same file, exit 0 — a
tool policy, not a write boundary, and unusable for the same reason `--sandbox`
is. It is also mutually exclusive with `--disable-slash-commands`, which every AGY
spawn passes from 1.1.9 up so a prompt beginning with `/` is not executed as a
command; AGY says so on stderr, readable only because 1.1.12 stopped swallowing
startup diagnostics into the log file. The measurement is recorded in §7.2 beside
the 1.1.10 table.

## 0.18.0 — 2026-08-17 — Arguments out of the shell, and claims backed by a check

Nine findings from a dogfooding security pass, plus the release gate that would
have caught the one release note nobody wrote. Most share a shape: something was
reported without ever having been checked, so "not verified" reached the user
wearing the words of "verified, clean".

### `$ARGUMENTS` reached a shell

All seven slash commands interpolated `$ARGUMENTS` into a command line, so
`/gemini:status $(echo INJECTED)` ran the substitution before the model ever saw
the text. Nothing interpolates it now. Where a command genuinely needs free text,
the text travels through a file the model writes and names itself:
`transfer.mjs --instructions-file <path>` and `adversarial-review --focus-file
<path>`. Positional focus text still works; passing both is an error rather than
a silent precedence rule.

**Behavior change.** Anything scripted against the old interpolating command
bodies must move to the file flags. The runtime rejects an unreadable
`--instructions-file` / `--focus-file` instead of proceeding with empty text.

### Reports that were never checked

- **`--write`-less runs were documented as read-only, which AGY cannot enforce.**
  AGY has no read-only mode; a turn without `--write` was an intent, not a
  sandbox. The workspace is now compared before and after the run, and a turn
  that wrote says so above its output. "Not checked" no longer looks like
  "checked, clean". The review path gained the same check as tasks.
- **`touchedFiles` was a regex over filename-shaped tokens in the model's reply.**
  It listed files that were merely mentioned and missed files that were quietly
  changed — a list assembled from what the model said about its work rather than
  from the work. It is a real before/after comparison now.
- **`--resume-last` resolved a thread, checked it, then threw the id away.** It
  told AGY to `--continue`, which means "the most recent conversation in AGY's
  store" — not the one just checked. A resumed conversation carries its own
  workspace, so a write resume could edit a different project entirely. AGY is
  now pinned by `--conversation <id>` and refuses to resume without one. Gemini
  CLI cannot be pinned (`--resume` takes only `latest` or an index), so the
  landing is compared against the tracked thread and a mismatch is reported above
  the output.
- **AGY transcript recovery picked the newest of several new conversation
  directories**, which under concurrent background jobs favors the sibling job
  still writing — one job could be handed another's answer. It now attributes
  nothing when more than one candidate appeared, and says why.
- **`--deep` told the model to read the repository while giving AGY no
  workspace.** An unoriented AGY turn reports its cwd as
  `~/.gemini/antigravity-cli/scratch` — the sibling of `brain/`, which holds every
  past transcript — so the deep review read AGY's own directory instead of the
  repo, and could not have reached the repo at all. It is oriented with
  `--add-dir` now, gated at AGY 1.1.10.
- **The keychain probes resolved bare command names**, which on Windows means
  whatever `PATH` offers first. They resolve absolute paths now, and CI grew a
  macOS leg so the darwin branch runs somewhere real rather than being reasoned
  about.

### Jobs nobody could attribute

The MCP server is launched from `.mcp.json` and never receives
`GEMINI_COMPANION_SESSION_ID`: the lifecycle hook can only export into
`CLAUDE_ENV_FILE`, which reaches later Bash commands, not a server started
alongside them. Every job it queued was therefore untagged — and the session
filter sorted untagged onto the same side as "another session's", so a review
started through `gemini_review` appeared in neither `running`, `recent`, nor
`latestFinished`, and could not be cancelled, because cancel resolves through the
same filter. Only the job id, held by the caller, reached it.

"No sessionId" is not "someone else's sessionId" — it means nobody could say. The
discovery paths admit untagged jobs now; jobs tagged to a different session stay
hidden, so the cross-session leak the filter exists for is untouched. Resume stays
strict at both call sites: listing a job the user can then see and cancel is not
the same as continuing its conversation unasked.

`all: true` on the three id-addressed MCP tools stays, and is not what this fixed.
A job queued by a slash command is tagged, and that process has no id to match it
against, so those tools would still report `No job found` without it.

### Release, CI, and the test suite

- **The release job held `contents: write` while running the tag's own `npm ci`,
  `npm test` and scripts.** Split in two: the job that runs code from the tag
  cannot publish, and the job that publishes has no checkout and no npm. Pinned by
  contract tests that read the workflow rather than trusting its shape.
- **`check-version` now requires a `## <version>` heading in this file.** A
  release whose four manifests agreed and whose changelog never mentioned the
  version passed every gate the repository had. The comparison is on the version
  token, not a constructed regex, so `## 1.2.30` does not satisfy 1.2.3 and no
  command-line argument reaches a pattern constructor.
- **The test suite wrote thousands of directories into the developer's own plugin
  data.** Job state lives under `CLAUDE_PLUGIN_DATA`, which Claude Code sets in
  the environment its commands run in, so a suite run from inside a session
  inherited the real one and every temp workspace a test created left a permanent
  state directory behind. Nothing reclaims them: `pruneJobStore` bounds the jobs
  inside a workspace, and nothing bounds the number of workspaces. Measured on the
  machine this was found on: 9626 of 9651 directories there were named
  `gemini-plugin-test*`, holding 40088 job files. `npm test` now preloads
  `tests/isolate-state.mjs`, which redirects both `CLAUDE_PLUGIN_DATA` and
  `GEMINI_COMPANION_DATA` into a temp directory it removes on exit. Measured
  after: a full run adds none.

### Engine

Verified against **AGY 1.1.13**: all six version gates in `engine.mjs` still hold,
every flag the plugin spawns is still present in `agy --help`, and `--probe-agy`
answered `/quota` from the account with no turn spent. Nothing moved, so nothing
was regated.

Not adopted here, and noted for their own change: AGY 1.1.12 fixed `--mode` being
ignored in headless `-p` runs, which makes `--mode plan` worth measuring against
the "AGY has no read-only mode" premise in `docs/THREAT-MODEL.md` 7.2; 1.1.12 also
added `--output-format json` to `agy models`, which `model-map.mjs` currently has
no machine-readable source for.

## 0.17.3 — 2026-08-12 — Say what it costs, say what it deleted, say who chose

Three things the plugin did to users without telling them. None was a crash, which
is why they survived: every one of them looked like normal operation.

**`--probe-gemini` could spend a turn without asking.** `setup.md` already required
`AskUserQuestion` before installing an npm package, while the flag that makes a
real billed request was governed only by prose asking the model for restraint —
including one line ("or when the user asks whether gemini really works") that reads
as licence to spend a turn answering a question someone merely said out loud.
It is now a hard rule: unless the user typed the flag, ask once and do not run it
if they decline. The decline option comes first, because the free disk check has
already produced a usable report, and the cost is stated in the option the user
clicks rather than only in the explanation around it.

**Evicting a finished job deleted a paid result in silence.** The store is capped
at 50, and `writeJobFile` discarded the list of what it removed — so a 51st job
took the oldest result and its log with nothing in the output. It now names them:

    [gemini-companion] Warning: the job store is capped at 50, so making room for
    <id> removed 1 finished job(s) and their logs: <id>. Those results can no
    longer be retrieved with `/gemini:result`.

It deliberately does not say those results were uncollected. Nothing records
whether `/gemini:result` ever read a job, so that would be a guess presented as
fact; a test pins the absence of that wording. Queued and running jobs remain
un-evictable. Both READMEs now state the consequence, not just the cap.

**`Nothing to review` answered a question the user might not have asked.** With
neither `--base` nor `--scope` given, the scope is chosen from whether the tree
happens to be dirty — so a misunderstood request and a genuinely clean repository
printed the same line. The Target line now distinguishes them:
`branch diff against master (inferred — no --base or --scope given)`. An explicit
request gets no annotation. Nothing new is computed: `resolveReviewTarget` has
always returned `explicit`, and it already travelled in the JSON payload — only the
line humans read left it out.

A `--explain` flag was considered and rejected for that last one. It would put the
burden on the user to know it exists and to re-run at the moment something has
already gone wrong, and a second resolution path can drift from the real one.

### Documentation that had stopped being true

- **The probe flags were undocumented.** `--probe-agy` and `--probe-gemini`
  appeared zero times in either README; `/gemini:setup` had no flag table at all,
  which is how a flag that spends quota stayed invisible. Both READMEs now carry
  one, including the AGY 1.1.11 floor `--probe-agy` needs — a version neither
  README mentioned anywhere.
- **The personal-plan EOL warning promised a future deadline that had passed.** It
  read "free CLI access ends 2026-06-18" two months afterwards, while the same
  repository's other references already said "ended". The same sentence also
  claimed AGY responses come from the on-disk transcript; that has been the
  fallback for AGY below 1.1.8 only, since v0.11.0. Both are pinned by tests now,
  because matching the date alone never noticed either.
- **Two documents said the plugin cannot do things it does.** `README.zh-TW.md`
  still carried the pre-feature paragraph telling readers AGY model selection was
  unmanaged and to use `--engine gemini` instead — advice to abandon a working
  feature. `MODEL_COMPARISON.md` and `known-diffs.md` described the AGY route as
  transcript recovery. The dated probe records are kept and marked superseded
  rather than overwritten: deleting them would lose *when* the behavior changed,
  which is what those documents exist to answer.
- Verified against **AGY 1.1.12** on the way through: all six version gates in
  `engine.mjs` still hold, so none moved.

### Repository

`CONTRIBUTING.md` (bilingual) and a `change_proposal` issue template, so the issue
that CONTRIBUTING asks for before a code change has a form behind it. New guards:
`argument-hint` must list every flag the companion's own usage advertises, and a
"Copy the line as written:" instruction must be followed immediately by the line.

## 0.17.2 — 2026-08-12 — `ready` now means the engine answers

Everything here sits behind `--engine gemini`, which only started reaching the
runtime in 0.17.1 — before that the flag was discarded, so none of this had ever
been exercised. Each was measured on a live account before being changed.

**Setup reported `ready` for an engine that rejects every request.** With no env
API key, a stale keychain entry was enough to reach `"readyState": "ready"` with
an empty `nextSteps`, while `geminiAuth.detail` in the same payload said the OAuth
token had expired four days earlier. A real request returned HTTP 400
`API_KEY_INVALID`. `getGeminiLoginStatus` now reports a `state` — `valid`,
`expired`, `missing`, `unreadable` — and an `expired` file blocks the `ready`
claim, downgrading to `partial` with a next step that names the expiry.

Deliberately narrow: only `expired`, never `missing`. Gemini CLI 0.53.1 migrates
OAuth into the keychain and deletes the file, so a healthy install also has no
file — treating absence as evidence would restore the false "not authenticated"
the keychain check exists to prevent. `loggedIn` and `detail` are unchanged.

**Google's own API-key rejection classified as `unknown`.** The auth pattern held
`invalid api key`; Google says `API key not valid` / `API_KEY_INVALID`, which is
not a word-order variant. So a rejected credential produced "The CLI failed with
an unclassified error" and advised retrying with a narrower prompt — advice that
can never work. Both spellings now classify as `auth`. `INVALID_ARGUMENT` and the
bare 400 are deliberately not matched: they also cover malformed requests,
including a bad `--model` id, and auth is tested before the model check.

**New `setup --probe-gemini`, and it is not free.** The file check can only prove
staleness; a credential living only in the keychain cannot be judged from disk at
all. This probe makes a real request and classifies the answer: `verified`,
`logged-out` (with proof), or `unknown` for any other failure. Unlike
`--probe-agy`, whose `/quota` question the account answers without starting a
turn, this spends a turn when the credential works — it costs nothing only when
the credential is already broken. The flag's own documentation and its result
detail both say so. A `logged-out` probe reports `not-ready` for an explicit
`--engine gemini`, and stays `partial` under `auto`, because auto routes to an
available AGY when gemini's credential does not work.

**A flag the shell split apart now names the real cause.** A double-quoted value
inside a slash command's argument string closes that quoting early, so
`--base "my branch"` arrives as `--base my`. That is already rejected, but the
message advised prefixing `--`, which cannot help a command that takes no prompt
text. It now says to use single quotes, which survive to the runtime's own
splitter. `commands/adversarial-review.md` documents the matching case for focus
text, where the shell swallows `--background` and the review runs in the
foreground.

Also fixed: three command-markdown sentences added in 0.17.1 contained a literal
`$ARGUMENTS`, which is substituted along with everything else — at runtime they
read as instructions about the user's own arguments.

### Review of the above, before release

A code review of this release found eight further defects in it, six of them in
the probe added here. All were reproduced before being changed.

**`--probe-gemini` spent a turn it then threw away.** Nothing gated the probe on
the selected engine, while AGY readiness never consults `geminiAuth` and every
gemini-derived next step is guarded on the same condition — so
`setup --engine agy --probe-gemini` billed a request whose answer was discarded.
It is now skipped there, and `nextSteps` says it was skipped: a flag that silently
does nothing is how a user concludes the credential was checked.

**The probe result impersonated the OAuth file.** Under `--probe-gemini`,
`geminiAuth` is the probe's answer, where `loggedIn: true` means "the API accepted
a request" — not "the file is valid". Reading it for `geminiCredentialSource`
reported `oauth-file` for precisely the case the probe exists to serve (0.53.1
deleted the file; the credential is in the keychain), and the stale-file next step
quoted the probe: "the OAuth file says it is stale: Gemini CLI rejected the
probe…", then advised running the probe that had just run. Source naming and file
evidence now read a separate, free file check. An inconclusive probe no longer
erases that evidence either — it used to replace it wholesale, so an expired file
plus a timed-out probe read as `ready`.

**An inconclusive probe disclosed nothing.** `unknown` pushed no next step, so a
user who had just paid for a request read a report that looked like no probe had
run. It now surfaces the probe's own detail, which states that the request may
have reached the API and may therefore have been billed. The timeout also rose
from 30s to 120s: at 30s a healthy-but-slow credential was killed mid-request,
which bills the turn and still answers `unknown`.

**The probe could not see an error in the JSON envelope.** It requests
`--output-format json`, and in that mode gemini can carry the error in a stdout
envelope rather than on stderr, where `classifyCliFailure` does not look unless
told the output is structured. Measured on 0.54.4 the auth error arrives on
stderr, so this was latent rather than live; the envelope path is now handled the
way `probeAgyLogin` already handled it.

**The probe ignored the caller's directory.** The `cwd` handed to it by the
readiness seam was swallowed by an options destructure, so it ran in the process
cwd — a workspace `.gemini/settings.json` did not apply, and the probe could
disagree with the very turn it predicts.

**Readiness read `process.env` directly**, unlike every other input, so the new
readiness tests asserted correctly only on a machine with no `GEMINI_API_KEY`
exported: `GEMINI_API_KEY=x npm test` failed. The environment is now injected like
the rest, and `sessionRuntime` is computed from the same one so a single payload
cannot describe two environments.

Two documentation defects: `setup`'s `argument-hint` never listed
`--probe-gemini`, leaving it undiscoverable from the slash command, and a bullet
inserted between "Copy the line as written:" and its fenced command left that
instruction pointing at prose. Both now have guards — `argument-hint` must list
every flag the companion's own usage advertises, and a copy-this-line instruction
must be followed immediately by the line.

## 0.17.1 — 2026-08-12 — The flags you typed now reach the engine

Found by using the plugin on its own repository. All three were reproduced
before being changed, and one of them turned out not to be a defect at all.

**The flags you typed were discarded when a command added one of its own.**
`$ARGUMENTS` expands to a single shell word, so `review --background "$ARGUMENTS"`
and `setup --json "$ARGUMENTS"` handed the runtime a two-element argv whose second
element was an entire flag string. Only a single-element argv is split, so that
string stayed one positional the command does not accept: `/gemini:review --base
HEAD~1 --scope branch` answered "Nothing to review" in one second over a 26-file,
2045-line diff, and `/gemini:setup --engine gemini` reported on the engine from
the environment instead.

Commands now fold their own flags into the same quoted expansion
(`review "$ARGUMENTS --background"`), and `npm run verify-contracts` fails the
build if any command reintroduces the two-token shape. Splitting dash-leading
tokens anywhere in argv was tried first and reverted: in a longer argv such a
token is indistinguishable from prompt text, and guessing broke real input both
ways — `--engine agy` was lifted out of a sentence and rerouted the run, and a
`--` inside prompt text turned on passthrough and ate every flag after it. Tests
now pin those cases so the heuristic cannot come back.

**The session runtime named an engine that could not have run.** The label chose
gemini whenever the gemini binary existed — `getSessionRuntimeStatus` took no
engine or environment argument at all, and `job-control` passed one that was
silently dropped. Under `GEMINI_ENGINE=agy` with an expired gemini credential,
`/gemini:setup --json` reported `gemini CLI (per-command)`. It now asks
`detectEngine`, the resolver the next command itself uses, and reports the answer
in a new `sessionRuntime.selected` field. The engine probes already taken are fed
back into it, so asking adds no `--version` call — `/gemini:setup` reuses the ones
its readiness fields are built from, which also stops one payload from describing
two different machines. Resolving the AGY executable path still costs one
`where`/`which` lookup.

**No change to review budget allocation.** A review of this repository reported
`allocateBudget` dropping smaller files while funding larger ones, and
recommended holding the skipped file's share back. Measured, that recommendation
reviews nothing at all: the held-back share keeps every later share under the
400-character minimum, so 1200 files of 500 characters against the 400,000-char
budget go from 1000 files reviewed and the budget fully spent to zero files
reviewed — the "every file was dropped" failure the budgeting exists to prevent.
The behaviour is deliberate and stays; the comment claiming it "funds whole small
files ahead of fragments of large ones" was the part that was wrong, and tests
now pin the tradeoff so the plausible fix cannot be applied silently.

## 0.17.0 — 2026-08-11 — Stop losing work that was already paid for

Seven defects reported from two days of heavy background use, reproduced before
being fixed. Two of the reports' root causes turned out to be wrong, and the
measurements said so: the concurrent-job data loss is not primarily the Windows
`EPERM` the report blamed (runs with zero `EPERM` still destroyed four of six
jobs — the shared index's prune was deleting live siblings), and the MCP
result-lookup failure has nothing to do with path normalization (it is session
scoping, and it never worked rather than failing intermittently). Three further
defects were found while reproducing the reported ones: reviews aborting on
diffs over 1 MiB, AGY's flush grace window being rounded away to nothing, and
`gemini_job_cancel` sharing `gemini_job_result`'s scope bug.

The thread running through most of them: model output is the one thing in this
system that cannot be rebuilt — rerunning costs money and returns something
different — and it was being discarded by a prune, a lost index entry, a killed
process, or a truncated payload.

### Added
- **`setup` names the credential that satisfied Gemini readiness** (`geminiCredentialSource`: `env-api-key`, `oauth-file`, `os-keychain`, `none`, or `engine-unavailable`). `geminiReady: true` beside `geminiAuth.loggedIn: false` was reported as a contradiction; both are correct and they answer different questions — `geminiAuth` inspects the OAuth *file* alone, while readiness uses the full resolution the CLI itself performs. A user whose 0.53.1 CLI migrated its OAuth into the keychain and deleted the file sees an expired-looking `geminiAuth` beside a working engine, with nothing in the report to explain it. Resolved in the CLI's own order, so an API-key user is not told the file was what applied.
- **`setup --probe-agy` verifies AGY's login without spending a turn.** AGY's authentication cannot be read off disk, so `/gemini:setup` reported `agyAuth.state: "unknown"` and told the user to "run an `--engine agy` command to confirm it is logged in" — that is, spend a billed turn and read the answer out of whether it failed. There was no zero-cost probe to offer. AGY 1.1.11 added read-only slash commands in print mode, so there is one now: `-p "/quota"` is answered from the account itself, and measured on 1.1.11 it reports `num_turns: 0`, every token count zero, and leaves no conversation behind. A verified AGY now reaches `readyState: "ready"`, which `--engine agy` previously could never reach; a probe that comes back unauthenticated reports `not-ready`, which is a different and worse thing than `unknown` and no longer shares its state. Below 1.1.11 the probe declines and says why, rather than sending `/quota` to the model as prompt text. Opt-in, because it spawns AGY and takes ~5 s while `setup` is otherwise a local inspection.

- **`--timeout <seconds>` on `task`, `review` and `adversarial-review`** (30–3600, applied to background jobs too). AGY's window was fixed at two minutes — this plugin's number, not AGY's, which defaults `--print-timeout` to 5m. It was chosen to fail fast when `agy --print` returned nothing over a pipe, and it doubled as an unannounced ceiling on output size: a turn producing more than it could emit in two minutes was killed and reported as `timeout (retryable)`, advice that cannot work, because retrying an identical batch fails identically. Measured in the field at 60–90 s per batch, users were running at 75% of a budget they could not see or raise.

### Fixed
- **AGY's flush grace window was zero, so timed-out runs lost their output.** `runGeminiTurn` computes a `--print-timeout` 15 seconds ahead of the hard spawn kill, so agy self-terminates and flushes its final transcript row instead of being SIGKILLed — but `formatAgyTimeout` rounded that 105,000 ms *up to whole minutes*, producing `2m`: exactly the 120,000 ms deadline it was supposed to precede. The grace window has never existed. It is now emitted in seconds (`105s`), which AGY's Go duration parser accepts — verified against 1.1.11 on 2026-08-11.
- **A killed AGY run no longer discards output it already paid for.** On AGY 1.1.8+ the plugin read the response only from the stdout envelope, so a turn SIGKILLed before it could print was recorded as a failure with nothing to show — while the response it had produced sat in the transcript on disk, which the pre-1.1.8 path had always known how to read. An **empty** stdout now falls back to that recovery: a completed transcript row is treated as success, an unfinished one returns the partial output and stays a failure. Deliberately narrow — stdout that arrived and failed to parse is still a malformed run, which is what the existing "the version already promised an envelope" rule is about; that rule simply never covered a process killed before it could print.
- **`task --help` prints usage instead of being delegated to the model as a prompt.** `parseArgs` keeps an unrecognized `--flag` as a positional — correct for a parser that cannot know its caller's option table, wrong for the commands that read positionals as free text. So `task --help` was sent to the engine, which answered it with a plausible-looking AGY tutorial: a real billed turn for the most natural first thing anyone types at a new CLI, returning something convincing enough that the user may not notice they never got the plugin's usage. `-h` did the same, as did `--timeout 300` (a flag the usage string does not offer, and the one a user reaches for after issue #5's timeouts). `adversarial-review --help` became focus text.
  - `<subcommand> --help` / `-h` now prints the usage string and exits 0 without reaching an engine.
  - A **leading** unrecognized flag is an error naming the option, not a prompt.
  - Only a leading flag is judged. A slash command arrives as one string split on whitespace, so a `--word` written mid-sentence becomes its own token; rejecting those would turn "explain what --foo does" into a hard error. `--` still delivers a prompt that genuinely starts with a dash.
- **A large file can no longer push other files out of a review, and a partial review can no longer report `approve`.** The 400,000-character review budget was spent front-to-back, so it decided which files were reviewed *by position*. Measured on a 5,200-line `data/questions.json` edit beside one tracked source change and three untracked new files: the budget ran out inside the data file, the whole `## Untracked Files` section and the tracked `src/quiz.ts` change never reached the model, and the review came back `approve` with `No material findings` over roughly 8% of the change. A review that silently skips 92% of the work is worse than no review, because the verdict reads as "this was checked".
  - **The budget is shared per file.** Files are funded smallest-first, each taking at most its share and releasing the remainder to the rest, so small code files survive alongside a huge data file and several large files split the budget instead of the first one taking it whole. A file that cannot be given at least 400 characters is dropped and named rather than sent as an unreviewable fragment.
  - **The plugin knows it truncated, so it can say so.** `collectReviewContext` returns `truncated`, `truncatedFiles` and `omittedFiles`; the notice leads the payload instead of sitting at character 400,000 where it depended on the model relaying it; and `/gemini:review` prints a banner naming what was cut.
  - **A truncated review is recorded as `needs-attention`, never `approve`** — in the rendered output, in `--json`, and therefore at the stop-review gate, which now explains that the change was only partially checked instead of blocking with "0 findings". The engine's own verdict is preserved as `truncation.modelVerdict`.
  - **`git diff` no longer dies on large diffs.** It ran with spawnSync's 1 MiB default buffer, so a diff big enough to need budgeting aborted the review with a raw `spawnSync git ENOBUFS` before any of this applied.
  - A review that fits in the budget produces a byte-identical payload to the previous release.
- **`gemini_job_result` and `gemini_job_cancel` can reach the jobs `gemini_job_status` could always see.** Both filtered to the current Claude session; the MCP server is launched from `.mcp.json` and never receives `GEMINI_COMPANION_SESSION_ID`, because `session-lifecycle-hook.mjs` can only export it into `CLAUDE_ENV_FILE`, which reaches later Bash commands rather than a server started alongside them. With no session id the filter admits only jobs carrying none — the ones the MCP server queued itself — so every job started by the CLI or a slash command answered `No job found` from two of the three job tools while the third returned it fine. Not intermittent: it never worked. All three now cross sessions, which is what `gemini_job_status` already did, and is safe for the same reason — each is addressed by an explicit job id, so none of them is a discovery path. The session filter still scopes the paths that *are* discovery: the bare `/gemini:status` listing, `--resume-last`, and cancel's "the one active job" shortcut.
- **Concurrent background jobs no longer delete each other's output.** The job list lived in one `state.json` array that every detached worker loaded, mutated and rewrote, and the write also pruned: any job missing from the writer's *already stale* snapshot had its `<jobId>.json` and `<jobId>.log` deleted. Measured on Windows at 6 concurrent jobs, 1–4 of 6 job records and their logs were destroyed per run — including runs where no `EPERM` occurred at all, so this was never only a rename problem. A log deleted mid-run and recreated by the next append is why a job could show `Turn completed.` with no `Final output` behind it.
  - **The `jobs/` directory is the index.** `listJobs` reads the per-job files that were always being written; `state.json` keeps configuration only. There is no shared mutable list left to lose an update on, which is also why `/gemini:result` can no longer report "No job found" for a job whose record and output are sitting on disk.
  - **Pruning decides from disk, and never evicts an unfinished job.** The cap is still 50; the candidates are now whatever is actually on disk, sorted oldest-last, with `queued` and `running` jobs excluded outright — their worker is still writing to those files.
  - **`renameSync` retries on `EPERM`/`EBUSY`/`EACCES`.** Windows refuses to rename onto a path another process holds open. Now only `state.json` is ever contended, and a sharing conflict costs milliseconds instead of a whole job.
  - **`/gemini:status --json` keeps its shape**: the listing withholds `result` and `rendered`, which only `/gemini:result` reads.
  - **Existing jobs survive the upgrade**: a `state.json` written by 0.16.7 or earlier is migrated into per-job files on first read, then the legacy array is dropped.
  - **A job deleted mid-scan is no longer reported as a corrupt one.** `readJobFile` fails closed on every read error, which is right for a file that is present but unreadable and wrong for one that is simply gone: an entry removed between `listJobs`' `readdir` and its read surfaced as a phantom `failed` job with an `invalid-json` cause, for an id that no longer existed, and it counted toward the 50-job cap. Both deleters race this routinely — pruning fires on every new job and the session sweep on every exit, while `/gemini:status --wait` polls every two seconds. `ENOENT` is now the one error that drops the entry; everything else still fails closed.
- **The review cap governs the whole payload, not just the diff.** The always-included sections (status, commit log, diff stat) were charged against the 400,000-character budget but still emitted whole, so a body larger than the budget — `git status --short --untracked-files=all` over an unignored build tree reaches megabytes — drove the file allocation negative, which clamps to zero: every file was dropped and the oversized status was sent in their place, leaving the review with no diff at all. Those bodies now share a reserved slice of the cap and are cut with the same marker files get, and the truncation notice both reserves room and bounds how many names it lists — at the 400-character floor a single review can truncate ~1000 files, and naming them all put the notice itself past the cap it exists to announce.
- **The stop-review gate no longer hides the findings of a truncated review.** The truncation branch returned before the summary was used, so a review that was cut short *and* found real problems reported only which files went unread. It now leads with what the review found and adds the truncation, rather than replacing one with the other.
- **`--timeout 30` no longer cancels the flush grace window it depends on.** The window was a flat 15 s subtraction floored at 30 s, so at the documented minimum `--print-timeout` came out equal to the hard kill and AGY self-terminated on the same tick `spawnSync` SIGKILLed it — the identical failure the minute-rounding above used to cause, reached from the other end of the range. The grace is now capped at a quarter of the budget, which leaves the full 15 s for every timeout above a minute. The `--probe-agy` probe had the same shape (`--print-timeout 30s` under a 30 s kill) and would have reported a slow but authenticated account as `unknown`.

### Compatibility
- **CI now runs the suite on Windows as well as Linux.** Four tests are Windows-only by construction — they assert `cmd.exe` behaviour that cannot be observed elsewhere: that a resolved command passes argv literally, that `%PATH%` in an argument is not expanded, and that a stand-in earlier in PATH wins over a real install behind it. On `ubuntu-latest` alone they never executed, so a change breaking the Windows spawn path would have gone green — and argv handling plus npm-shim resolution are the most platform-specific code this plugin has. Five other tests are the mirror image and still need Linux, so each leg carries assertions the other cannot.
  - `fail-fast: false`, so a Windows failure does not cancel Linux and hide whether a problem is platform-specific.
  - Timeout raised from 10 to 20 minutes; the Windows runner is slower at `npm ci` and at a suite that spawns a Node process per background-job case.
  - Carried no version of its own, as it changed no plugin code; it ships here.

## 0.16.7 — 2026-08-06 — Cover what can go wrong, delete what nothing calls

A coverage pass that treated the percentage as a way to find gaps, not as the thing to raise. Two of the three findings were answered by deleting code and by *declining* to add a test.

### Removed
- **Five unused exports from `lib/fs.mjs`**: `ensureAbsolutePath`, `createTempDir`, `readJsonFile`, `writeJsonFile`, `safeReadFile`. Nothing imported any of them — not the plugin, the tests, the bench harness, or the docs. Their 28% function coverage was not a testing gap; it was five thin wrappers around one-line `fs` calls waiting to tempt someone away from the module that already does the job properly (`state.mjs` owns atomic JSON writes). `isProbablyText` and `readStdinIfPiped` each have a caller and stay.

### Tests
- **A deleted secret file no longer had to be taken on trust.** `bSidePath` has a branch for `+++ /dev/null`, which is what git writes when a file is removed — and a deletion diff carries every line of the secret with a `-` in front of it. That branch had no test. It does now, together with its mirror image: a deleted *ordinary* file must pass through untouched, because falling back to the header must not start redacting things that are not credentials.
- **Job progress updates are pinned where a user could see them fail**: a changed thread id must replace the old one (otherwise `/gemini:status` prints a stale `gemini --resume` command to copy), a turn-only update must not drop the thread id, and an update for a job whose record was swept mid-run must be dropped quietly rather than throw or resurrect the file. Plus the reporter contract callers rely on — `null` when there is nowhere to report, and an empty thread id normalized away rather than stored.

### Deliberately not tested
Stated because "why is this line red" deserves an answer in the record rather than a future patch:
- **The updater's skip-when-unchanged branch.** The only way to observe it is the job file's mtime, which is flaky within a millisecond and tests an optimisation rather than a promise. Reaching it would raise the branch percentage and protect nothing.
- **A newly added secret file.** Its `--- /dev/null` sits on the a-side, which `bSidePath` never reads, so it takes the identical path to the ordinary case already covered. The test was written, then removed for asserting nothing new.

### Coverage
Line 71.09% → 71.22%, branch 65.89% → 66.62% overall — small numbers, because the work was three targeted files and one deletion. Where it landed: `tracked-jobs.mjs` branch 41.30% → 72.22%, `fs.mjs` line 65% → 84.62%, `secrets.mjs` branch 70.37% → 74.07%. The engine, credential, state, failure-classification and model-map modules were already 95–100% and were left alone.

## 0.16.6 — 2026-08-06 — A denied AGY tool call stops looking like an empty response

### Added
- **`tool-permission-denied`, a failure category for AGY's headless soft-denial.** When a tool needs a permission AGY cannot prompt for, it exits **0** with empty stdout and explains itself on stderr. The classifier had no rule for that wording, so the run landed on `no-output` — which is marked **retryable**, and retrying a denied permission never succeeds. It is now classified, marked not retryable, and the message says what to actually do.
  - Recovered from an unmerged worktree left over from the v0.8.0 era. The classification and its test were written then; what is new here is that the surrounding classifier had moved on, so it was reapplied rather than merged.
  - **The advice was rewritten.** AGY's own message ends "re-run with `--dangerously-skip-permissions`". This plugin removed that flag in v0.16.0 — it granted nothing for edits and shell commands ([`docs/THREAT-MODEL.md` §7.2](../../docs/THREAT-MODEL.md)) — and offers no way to reinstate it, so repeating that suggestion would point users at something they cannot reach from here. The next step now names the allow-rule they can add and the interactive `agy` run that can ask on their behalf.
  - The classifier still *matches* AGY's wording including the flag name. That the plugin no longer passes the flag does not stop AGY from mentioning it.

### Tests
- The live AGY denial message is classified as expected and marked not retryable.
- A second test asserts the next step **never names `--dangerously-skip-permissions`**, so the original wording cannot come back with a future copy-paste.

## 0.16.5 — 2026-08-05 — Job phases stop claiming detail that does not exist

### Changed
- **The background-job phase fallback no longer pretends to know what the engine is doing.** It scanned the progress log for tool-level prefixes — `"searching:"`, `"running command:"`, `"applying "` — and reported `investigating`, `verifying` or `editing`. Every one of those branches was unreachable, for two independent reasons:
  - **Nothing writes such lines.** The log receives only the six messages `lib/gemini.mjs` emits (`"Detecting engine..."`, `"Starting <engine> turn..."`, `"Turn completed."` and the review equivalents). `runCommand` is `spawnSync`, so the engine's output arrives in one blocking return, not as events — there is nothing to narrate mid-run.
  - **The comparison could not have matched anyway.** Every logged line is written as `[<iso timestamp>] <message>`, and the preview keeps only lines beginning with `[`, so `startsWith("searching:")` was false by construction.
  - **No behavior change.** The removed code could not execute, so no job's reported phase differs. What remains is what is actually known: the job's status, and its class when the status says nothing.

### Not adopted, with the measurement behind the decision
- **AGY 1.1.8's `--output-format stream-json` cannot supply those phases, so it was not adopted.** Measured on 1.1.10, 2026-08-05: the stream carries an `init` event, `step_update` events, and a terminal `result` event that still holds the full response. The `step_type` values are `tool`, `agent_response`, `user_input`, `checkpoint` and `unknown` — and **`tool` carries no tool name and no arguments**, so "read a file" cannot be told from "run the tests" or "edit something". The phases the deleted code reported were never obtainable from any source.
- What the stream *does* offer that today's path does not is `text_delta`: incremental output while the model is still writing. That is genuinely useful for a background job, and it needs `runCommand` to become asynchronous — which would reach every caller, the result assembly, timeout handling, and the injection seam the tests are built on, while still keeping the existing path for the gemini engine and for AGY below 1.1.8. Estimated two to three days and left open deliberately rather than started and abandoned.

### Tests
- Four cases pin the fallback: a job's own `phase` always wins; each status maps as documented; a log full of tool-shaped lines does **not** move the phase; and the set of progress messages the engine emits is asserted to contain no tool-level text — so if a future change starts emitting richer progress, that test fails and the phase logic is revisited deliberately rather than by accident.

## 0.16.4 — 2026-08-05 — A read-only AGY task can see the repository again

### Fixed
- **`/gemini:rescue` on AGY without `--write` was reading AGY's scratch directory, not your repository.** Asked for its working directory, the model answered `~/.gemini/antigravity-cli/scratch`; every relative path missed. The subagent is documented for exactly this shape — "investigate, diagnose, review, explain, research" — and on AGY it could do none of it.
  - **Introduced in v0.16.0**, when read-only became the default. The flag that orients AGY on `cwd` (`--new-project`) was attached to write turns, so inverting the default silently took orientation away with it. Reviews were unaffected: their diff is assembled by the plugin and travels in the prompt.
  - A read-only turn now passes `--add-dir <cwd>`, which orients the session without `--new-project`. Verified end to end: the model reports the repository as its working directory, reads a relative path correctly, and leaves the working tree clean.
  - Gated at AGY 1.1.10, the only version the flag was exercised on. Older AGY keeps the previous behavior rather than being handed a flag it might reject.

### Security
- **A claim in `docs/THREAT-MODEL.md` §7.2 was wrong and is corrected rather than quietly dropped.** Conclusion 3 said "the read-only guarantee comes from workspace binding". **There was no guarantee.** The original run wrote to the scratch directory because its prompt named a *relative* path; re-measured with absolute paths, a turn with **no workspace flag at all** read and wrote outside that directory. What the unoriented shape withheld was the model's knowledge of where the repository is — not its access to it.
- **This release therefore trades a protection that was not one for a capability that was documented.** Be precise about what changed: a read-only AGY turn can now resolve relative paths into your repository, so a prompt injection that says "edit ./src/x.js" reaches it where before it would have hit a scratch copy. An injection naming an absolute path always reached it. AGY has no read-only mode; `--add-dir` and `--new-project` orient identically and neither withholds write.
- **What `--write` still means, stated honestly.** On gemini it is a real gate (`--yolo`; without it no write or shell tools are offered). On AGY it is a statement of intent that selects one orientation flag over another, and it remains what the subagent and MCP defaults key off. It is not a sandbox, and §7.2, both READMEs and `docs/known-diffs.md` now say so in those words.

### Tests
- Six cases pin the orientation matrix: read-only takes `--add-dir` with the workspace path, a write turn keeps `--new-project` and does not also get `--add-dir`, a resumed turn keeps its original workspace, the flag is withheld below 1.1.10 and when no workspace is given, and the gemini engine never sees it.

### Not tested
- **AGY below 1.1.10.** `--add-dir` may well predate it, but an unverified lower bound is a guess, and guessing spawns an unknown flag at an older engine. Those versions keep the v0.16.3 behavior.
- **Whether `--add-dir` differs from `--new-project` in any way beyond orientation.** Both were measured to orient the session and to permit writes; no attempt was made to characterize what else creating a project does.

## 0.16.3 — 2026-08-05 — Review picks its engine the same way every other command does

### Fixed
- **`/gemini:review` and `/gemini:adversarial-review` sent every review to an unauthenticated gemini CLI rather than to a working AGY.** With no `--engine` given, the review path passed `"gemini"` as its default, which `detectEngine` reads as an **explicit** request — and an explicit request deliberately skips the credential check, because a user who names an engine should get that engine or a clear error. So an installed-but-unauthenticated gemini was selected and failed every review, with AGY sitting available beside it. Only a *missing gemini binary* ever reached the fallback.
  - The review path now passes `null`, exactly as the task path always has, so both reach the same `auto` routing and the same credential check that v0.16.0 fixed.
  - **What changes for you:** if you have a working gemini credential, nothing. If you do not, reviews now run on AGY and succeed instead of failing on authentication. An explicit `--engine gemini` still selects gemini and still reports the credential problem, which is the point of asking by name.
  - The stated reason for the preference — "prefer gemini for JSON output" — had been obsolete since v0.11.0, when AGY 1.1.8's JSON envelope gave both engines the same structured contract.

### Documentation
- `REVIEW_SCHEMA` in `gemini-companion.mjs` looked like dead code and is not. It names a real file that two prompts and the bench scorer depend on; it is unread at runtime only because the contract travels to the model inside the prompt, since the gemini engine has no flag that accepts a schema file. AGY 1.1.8's `--json-schema` does, and that remains an open follow-up. The comment now says all of this, so the next reader does not delete it.

### Tests
- Engine selection is pinned three ways: that a review with no engine specified asks for the same thing a task does, that an explicit `--engine` is passed through untouched, and that the review path never names gemini by itself. Verified against the previous code — the first and third fail there, which is what makes them worth keeping.

## 0.16.2 — 2026-08-05 — The engine no longer starts through cmd.exe on Windows

### Fixed
- **Every successful `/gemini:setup` printed a Node deprecation warning on Windows** ([#49](https://github.com/arcobaleno64/gemini-plugin-cc/issues/49)). `runCommand` spawned any bare command name with `shell: true`, because a global npm install of `gemini` is a `.cmd` shim that will not resolve otherwise. Node 24 warns about that combination (`DEP0190`) precisely because argv is concatenated into a command line rather than passed literally. A warning printed during a command that worked reads as a fault.
  - A bare name is now resolved before spawning: `where.exe` and `taskkill.exe` come from `System32`, a real executable is spawned directly, and an npm shim is resolved to the entry script **its package's `bin` field names** — then run through this process's own Node with `shell: false`.
  - **The shell is now a fallback, not the default.** Anything resolution cannot identify with confidence keeps the previous behavior. This narrows the shell path rather than removing it, and the argv-quoting helper it depends on is still exercised by tests.
  - Side effect worth knowing: on the resolved path, arguments are passed literally. `%PATH%` in an argument is no longer expanded by `cmd.exe`, and no argument can be re-parsed as shell syntax. A test pins that difference.

### Security
- **Not a vulnerability fix, and the changelog should not imply one.** The only non-constant value that ever reached a Windows command line was the model id, and `SAFE_MODEL_ID` has always confined it to `[A-Za-z0-9._-]` — no shell metacharacter could pass. Prompts travel on stdin and never enter argv. What changes is that the class of mistake is now structurally unavailable on the normal path instead of being held off by one regex.
- `where.exe` and `taskkill.exe` are taken from `%SystemRoot%\System32` rather than PATH, so a same-named binary planted earlier in PATH cannot answer for them.
- A shim is only followed when its entry resolves **inside the shim's own directory**, checked with `fs.realpathSync.native`. A shim naming a script elsewhere is left to the shell path instead.

### Tests
- Shim resolution is pinned by six cases, including the two misresolutions found while building this — both real, both silent:
  - **A shim naming several scripts.** npm's own shim names `bin/npm-cli.js` *and* `bin/npm-prefix.js`; taking the first `.js` in the file ran `npm-prefix.js`, which exits 0 and prints a path. `npm --version` reported the global prefix as its version, and nothing failed.
  - **Searching past the first PATH directory.** When the nearest match could not be resolved, the search continued and found a *different installation* further along PATH. The test fixtures shadow the real gemini CLI exactly that way, so 31 tests began exercising the real CLI instead of their stand-in. Resolution is now confined to the first PATH directory, which is what a shell would have run.
- Argv round-tripping is asserted on both paths now: through the shell (explicitly requested) and through the resolved path, where the assertion is that values arrive *unmodified*.

## 0.16.1 — 2026-08-05 — A reviewer can now verify the plugin, and reach a person

Both changes close the last two open items in the Anthropic Software Directory Policy. Neither alters how the plugin behaves.

### Added
- **A contact address that receives mail: <arcobaleno830623@gmail.com>.** Policy 3.B asks for "verified contact information and support channels for users with product or security concerns". Until now the repository carried none: both manifests listed a name and a GitHub URL, and every route to the maintainer went through GitHub. The address is now in `plugin.json`, `marketplace.json`, `SECURITY.md`, and the Support section of both READMEs.
  - GitHub Security Advisories remains the **preferred** route for vulnerabilities — it keeps the report, the discussion, and the advisory together. Email exists for people who cannot or would rather not use GitHub.
  - A `@users.noreply.github.com` address was considered and rejected: it cannot receive mail, so it would satisfy the letter of a contact field while failing the thing the field is for.
  - Both README Support sections now say plainly that this is a single-maintainer project rather than a staffed support desk, so response expectations are set by the docs and not by assumption.
- **`node scripts/reviewer-demo.mjs` runs every command end to end with no Google account, no OAuth, and no API key.** It answers the Anthropic Software Directory Policy's request (3.D) for "a standard testing account with sample data to verify full Software functionality" — which this plugin cannot satisfy literally, because it issues no accounts. It bridges to a CLI the user installs and authenticates with credentials Google issues, and consumer access ended on 2026-06-18. What is offered instead is a run: setup, foreground task, the background job lifecycle, review, adversarial review, cancelling a live process tree, and a transfer export with a planted `.env` withheld.
  - The stand-in engine is `tests/fixtures/fake-gemini.cjs`, the fixture the suite already uses, reused rather than reimplemented so it cannot drift into describing behavior no test checks. The plugin's own code paths are real throughout — argv construction, engine detection, stdin transport, envelope parsing, job state, rendering, redaction.
  - **The canned replies are labelled as canned**, at the top and at each step, and the closing summary names what only a credentialed run can answer. A walkthrough that let fixture text pass for model output would be worse than no walkthrough.
  - It is a repository tool: nothing under `plugins/gemini/` changed, nothing imports it, and it ships with the repository rather than the plugin.

### Tests
- The walkthrough is pinned by `tests/reviewer-demo.test.mjs`, which asserts each step reached real plugin output rather than only printing its heading, and independently verifies the redaction claim against the files left on disk — the transfer snapshots *and* the job logs — instead of trusting the demo's own summary line.

### Compatibility
- **No behavior change of any kind.** No command, flag, engine selection, transport, model, or job-state format is touched. The two manifests gain an `email` field, which both schemas already accept (verified against `claude plugin validate --strict`).

### Not tested
- **That the published address is monitored.** That is a commitment by the maintainer, not something a test can assert. It is stated here so a reader knows which claims in this repository are mechanically checked and which are not.

## 0.16.0 — 2026-08-05 — Write is opt-in, and every claim about the engines is measured

Three changes that all came from the same question: does the plugin's description of what it does survive contact with the engines? Two did not.

`/gemini:rescue` was write-capable by default, inherited from an upstream that can afford it because it confines the run with a sandbox this port has none of. And `--dangerously-skip-permissions`, the most alarming flag in the codebase, turned out to grant nothing at all — headless AGY auto-approves either way. Both were found by running fourteen measured turns against a disposable repository rather than by reading flags, which is how the threat model had described this surface until now.

Separately, the credential check could not see the credentials Gemini CLI actually stores, so `auto` routed past working installations in silence.

### Breaking
- **`/gemini:rescue` no longer edits files unless you pass `--write`.** The rescue subagent had instructed itself to add `--write` unless the user asked otherwise — inherited verbatim from upstream `codex-plugin-cc`, where it is safe because upstream confines a write run with `sandbox: "workspace-write"`. This port has no such boundary, so the same default was write-capable *and* unconfined. The default is inverted; the feature is untouched.
  - **Failure mode is silent**: a task that used to edit now investigates and reports instead. Add `--write` when you want edits.
  - The MCP path already defaulted `write: false`. The two entry points now agree.

### Added
- **Every MCP tool now carries the annotations a client uses to decide whether a call needs confirmation** — `title`, `readOnlyHint`, `openWorldHint`, and `destructiveHint`/`idempotentHint` on the two tools that can write. All five previously shipped with none, so a client had nothing to gate on and had to treat a write-capable delegation exactly like a status read. Required by the Anthropic software directory policy, which names those three by name.
  - The hints describe the **worst** a call can do, because they are static per tool and cannot vary with arguments: `gemini_rescue` reports as destructive even though its `write` argument defaults to false, since `write: true` hands the delegated agent the filesystem with no path boundary ([`docs/THREAT-MODEL.md` §7.2](../../docs/THREAT-MODEL.md)).
  - `gemini_job_cancel` is destructive but idempotent — cancelling a `--write` task can leave half-applied edits behind, while cancelling a finished job is a no-op.
  - `readOnlyHint` here means "does not modify the workspace it was pointed at". Every tool writes plugin job state, which lives outside that workspace and is bookkeeping rather than user content; the reasoning is recorded beside the definitions rather than left for a reviewer to infer.
  - `openWorldHint` marks the two tools that reach Google through the Gemini/AGY CLI. `gemini_review` is read-only **and** open-world: it never touches the reviewed workspace, but it does send the diff.

### Security
- **`--dangerously-skip-permissions` is removed from the AGY path.** Measured on AGY 1.1.10: headless print mode auto-approves edit tools and shell commands with or without it, so the flag granted nothing while being the clearest "circumvents the permission model" signal in the codebase. Removing it is a no-op behaviorally and the honest description of what the plugin does. See [`docs/THREAT-MODEL.md` §7.2](../../docs/THREAT-MODEL.md) for the run table.
- **`--sandbox` is deliberately not adopted, and a test pins that.** It exists on AGY 1.1.10, and it is not a path boundary: a run with it enabled wrote outside the workspace through both the edit tool and a shell command. It restricts what a terminal command may reach — network, `.git` — not where anything may write. Adopting it on the strength of its name would have been exactly the kind of unverified safety claim `SECURITY.md` exists to prevent.
- **`--yolo` stays on the gemini engine, and now there is evidence for it.** Seven runs on gemini CLI 0.53.1 show the opposite of AGY: without `--yolo` the model is offered no `write_file`, `edit`, or `run_shell_command` at all — at both the main-agent and subagent level — and says so. The flag is a real gate, not a cosmetic one, and none of the AGY findings transfer to it.
- **`--approval-mode plan` is deliberately not adopted, and a test pins that.** It does run headless over stdin — the in-tree comment claiming it "requires TTY input" was wrong and is gone — but reading gemini CLI 0.53.1's bundle, plan mode re-declares `write_file` and `edit` to the model with an amended description and injects a planning-workflow system prompt. Against a read-only turn that currently declares no write tools at all, that is a net loss of restriction. The dead `approvalModePlan` option is removed rather than left as a switch inviting the opposite conclusion.

### Fixed
- **A gemini CLI authenticated through its own auth prompt was read as unauthenticated.** Gemini CLI 0.53.1 stores credentials in the OS keychain via `@github/keytar` — `gemini-cli-api-key/default-api-key` for a pasted API key, `gemini-cli-oauth/main-account` for OAuth, which it migrates out of `oauth_creds.json` and then deletes. `hasGeminiCredentials()` checked two environment variables and that one legacy file, so it saw neither. The consequence was silent: `auto` routed past a working gemini to AGY, and `/gemini:setup` told the user to authenticate an engine that already was. Reproduced on this machine, where `cmdkey` holds the API-key entry and the check returned `false`.
  - The keychain is probed for **existence only**, one entry at a time by exact name, using the platform's own tool: `security find-generic-password` on macOS (deliberately without `-w`, which prints the password), `secret-tool search` on Linux (not `lookup`, which prints the secret), `cmdkey /list:<target>` on Windows. macOS and Linux report presence in their exit status, so their output is discarded unread.
  - Capped at two seconds, cached once per process, and **failing closed** on every error — missing tool, locked keychain, timeout, unsupported platform. A wrong "authenticated" would send `auto` into an engine that rejects every request, which is the failure this check exists to prevent.
  - `GEMINI_COMPANION_DISABLE_KEYCHAIN=1` turns the probe off for anyone who would rather this plugin never spawn a credential tool. The only cost is `auto` accuracy; `--engine gemini` still selects it explicitly.
- **`/gemini:setup` computed readiness from a narrower check than auto-routing used.** `geminiReady` read the OAuth *file* alone, so a user with `GEMINI_API_KEY` set was reported not ready while their next command worked. A comment in `lib/gemini-auth.mjs` had asserted the two were the same notion; now they are. `geminiAuth` in the JSON output still reports the OAuth file specifically, unchanged.
  - The matching next-step text changes from "Run `gemini` once to authenticate via OAuth." to "Run `gemini` once to authenticate, or set GEMINI_API_KEY." — OAuth is no longer the only way to satisfy the check.

### Documentation
- **`docs/THREAT-MODEL.md` §7.2 was wrong in two ways and is rewritten around fourteen measured runs — seven per engine.** It claimed "AGY has no path-boundary mode" — `--sandbox` exists, it just is not one — and that `--write` "removes the approval prompt", when in headless mode there is no prompt to remove. It also said the section was "deliberately not tested" and rested on reading flags; it is now tested, including a demonstrated write outside the workspace. The §5 mitigation-table correction and the §7.7 priority entry are updated to match.
- What `--write` actually controls is documented plainly in both READMEs and `docs/known-diffs.md`: it selects **where the engine works** — with it, your repository; without it, AGY's own scratch directory — not whether the engine may write. The upstream divergence is recorded as a deliberate one.

### Tests
- The rescue subagent's read-only default is pinned by a contract test. The instruction is prose in a Markdown file and carried this defect for the entire life of the project, so nothing but a test stops it drifting back.
- `--dangerously-skip-permissions` is asserted absent across four AGY turn shapes, including the write and resumed-write turns where it would plausibly be re-added, and `--sandbox` is asserted absent so it is not adopted as a boundary later.
- The gemini path is pinned in both directions — `--yolo` present on a write turn, absent on a read-only one — so neither half is dropped by analogy with the AGY path, and `--approval-mode` is asserted absent across four turn shapes.
- One test requires the annotations to exist and be well-formed on every tool, including the policy's 64-character name limit, and refuses a meaningless `destructiveHint` on a read-only tool. A second pins each tool's hints individually — a wrong hint is worse than a missing one, because a client acts on it.

### Compatibility
- **No change to any command, flag, engine selection, transport, model, or job-state format.** Node ≥ 18, Gemini CLI ≥ 0.40, AGY ≥ 1.0.3 as before.
- **What changes for you:** `/gemini:rescue` without `--write` now investigates instead of editing, and `auto` may now select gemini where it previously fell through to AGY, because the credential it could not see is now visible. Both are described above.
- Three observable values move toward the truth rather than changing contract: `geminiReady` and `readyState` in `/gemini:setup --json` for users whose credential was previously invisible, and the "authenticate" next-step text, which no longer names OAuth as the only option.
- **Why MINOR and not MAJOR.** An inverted permission default is a MAJOR trigger under the release policy. It ships as MINOR under the `0.x` allowance for a labeled breaking change carrying migration instructions — the same call taken for the job-state move in 0.15.0. The migration is one flag.

### Known limitations
- **Nothing constrains where a `--write` run may reach.** Two of the measured runs wrote outside the workspace, and no flag on either engine prevents it. This release makes the exposure opt-in and accurately described; it does not remove it. The real fix is an engine-side path boundary that does not yet exist.
- **The encrypted-file fallback is not detected.** Where no keychain is available — headless Linux, WSL, or `GEMINI_FORCE_FILE_STORAGE=true` — the CLI stores credentials in `~/.gemini/gemini-credentials.json`, one encrypted blob shared by every service. Its presence cannot distinguish a gemini credential from an unrelated MCP token, so it is deliberately not consulted: guessing there would reintroduce the false "authenticated" this check exists to prevent. Affected users select the engine explicitly with `--engine gemini`.
- **Only Windows was exercised against a real keychain.** The macOS and Linux commands are pinned by tests with an injected spawn, which fixes the argv and the presence semantics but proves nothing about those tools' actual behavior on those platforms.

### Not tested
- **AGY below 1.1.10.** The measurements are from 1.1.10 only. A 2026-07-09 note in `lib/agy-transcript.mjs` recorded that `--dangerously-skip-permissions` bypassed AGY 1.1.0's `request-review` mode; that interaction was not re-measured without the flag, so on 1.1.0 a write turn could in principle stall, which would surface as a `--print-timeout`. The note now says so rather than continuing to describe a flag that is gone.
- **Gemini CLI's `--sandbox`.** Unlike AGY's flag of the same name it is a container sandbox, and it refuses to start without Docker or Podman, neither of which is installed on the test machine. Whether it bounds writes to the workspace is unknown.
- **The read-only default end to end.** The subagent instruction is pinned by a contract test, but no live `/gemini:rescue` run was performed to observe a model honoring it.

## 0.15.0 — 2026-08-05 — Job state lands where Claude Code puts plugin data

Maintenance release closing the post-approval handoff backlog. Two defects surfaced while writing the tests that backlog asked for, and both are fixed here rather than deferred.

### Breaking
- **Job state moves from `<system temp>/gemini-companion/<workspace>-<hash>/` to `$CLAUDE_PLUGIN_DATA/state/<workspace>-<hash>/`.** Jobs recorded before the upgrade are not migrated: they stay in the temp directory, unreferenced. Nothing is deleted, but `/gemini:status`, `/gemini:result` and `/gemini:cancel` will not see them, and a background job still running across the upgrade is orphaned — its PID lives in the old state file, so the session-end hook cannot reap it.
  - **Before upgrading**, run `/gemini:status` and let anything in flight finish. Afterwards, the old directory can be deleted.
  - To keep the previous location instead, set `GEMINI_COMPANION_DATA` to a directory of your choosing before upgrading. Do not point it at the system temp path — that is what this release exists to stop.
  - **Why MINOR and not MAJOR.** A changed job-state location would normally be a MAJOR bump. This ships as MINOR under the `0.x` allowance for a labeled breaking change carrying migration instructions, because the old location was a defect rather than a contract: it was never documented, and the documentation that did exist described a third location the code never used.

### Added
- **`node scripts/make-sample-repo.mjs`** materializes a benchmark corpus case into a disposable git repository and prints the defects planted in it. It is the safe target for a `--write` run, which is write-capable with no path sandbox ([`docs/THREAT-MODEL.md` §7.2](../../docs/THREAT-MODEL.md)). No new fixture content: `bench/lib/corpus.mjs` already built exactly this repo for the benchmark, so the script is that call minus the cleanup.

### Security
- **A review no longer reads through an untracked symlink that leaves the workspace.** `formatUntrackedFile` checked `isSecretFile` against the *link* name — which whoever plants the link chooses — and then followed it with `readFileSync`. An untracked symlink called `notes.txt` pointing at `~/.ssh/id_rsa` passed every check and its target's contents were sent to the model. The link is now resolved with `fs.realpathSync.native` and skipped when the target falls outside the workspace; both sides are canonicalized first, because a `cwd` that is itself a symlinked path (macOS `/tmp`) would otherwise mark every file as an escape. In-repo aliases still inline normally and broken links still report as broken. The reachable route is a write-capable delegated task creating the link and a later review reading through it — see [`docs/THREAT-MODEL.md` §7.4](../../docs/THREAT-MODEL.md).

### Fixed
- **The redacted-file list named the wrong path when a directory contained a space.** `redactSecretsFromDiff` read the b-side path off the `diff --git a/P b/P` header, which is ambiguous once `P` holds a space: for `a b/c.env` the first ` b/` gives `c.env b/a b/c.env` and the last gives `c.env`. It now takes the path from the unambiguous `+++ b/<path>` line, stopping at the first `@@` so an added line beginning `++ ` cannot be misread as the header, and falls back to the old header match for diffs with no `+++` line. Redaction itself was never wrong — the check runs on the final path segment, which survives either misparse — so this is the accuracy of what the user is told was withheld.
- **Background job state was landing in the system temp directory on every install, where the OS eventually deletes it.** `lib/state.mjs` read `GEMINI_COMPANION_DATA` to find Claude Code's per-plugin data directory. Nothing sets that name. `session-lifecycle-hook.mjs` forwards `CLAUDE_PLUGIN_DATA` — the variable Claude Code actually sets — so the forwarding was dead code and `resolveStateDir` always took its `<system temp>/gemini-companion/` fallback. Upstream `codex-plugin-cc` reads `CLAUDE_PLUGIN_DATA` in both files; the port renamed it in one. Present since the first commit in this repository, and invisible to the tests because they set `GEMINI_COMPANION_DATA` directly.
  - `GEMINI_COMPANION_DATA` still works and still wins when both are set. It was readable in shipped source, so anyone who set it keeps their location instead of being moved by an upgrade. Deprecated; drop it at 1.0.
  - A blank or whitespace-only value now falls through rather than rooting state at `""`.

### Documentation
- **`PRIVACY.md` states what the plugin sends, keeps, and reads**, with a source file cited beside each claim. It was the one directory-compliance document the repository did not have; nothing in `README.md`, `README.zh-TW.md`, `SECURITY.md`, or `docs/THREAT-MODEL.md` contained the word *privacy*. Both READMEs and `SECURITY.md` link to it.
  - The document says the uncomfortable parts out loud: secret detection is by filename only; the size caps and redaction bound what the *plugin* assembles, not what the agentic CLI may read on its own once running in your workspace ([`docs/THREAT-MODEL.md` §7.2](../../docs/THREAT-MODEL.md)); and the opt-in Stop review gate is the one path that transmits a diff without a fresh command.
- **`SECURITY.md` supported-versions table said `0.12.x`** while 0.14.1 shipped — a security policy claiming the current release is unsupported. Corrected, with the rule ("only the current MINOR line") written down so the next bump does not re-stale it. The in-scope-components list also still pointed `isSecretFile()` at `transfer-context.mjs`; the definition moved to `lib/secrets.mjs` in 0.13.0.
- **`docs/verifying-without-credentials.md`** — the complete path for reviewing this plugin with no Google account, no OAuth, and no API key, and an explicit table of what the credentialed steps add. Maintainer credentials are never distributed, so the offline path has to be written down.
- **`docs/version-sources.md`** — the HANDOFF §14 P1 study, answered rather than left open. Recommendation: **keep all six version sources.** The duplication Anthropic's guidance warns about is mechanically enforced here by one bump script and a `check-version` gate that runs in both workflows, and the only redundant field interacts with a directory pipeline this repository cannot test against without experimenting on live users. Two named conditions would change the answer.
- **Support sections** in both READMEs, routing setup trouble, deliberate divergences, bugs, compatibility reports, and vulnerabilities to different places — a vulnerability in a public issue is the failure worth preventing.
- Issue templates for bug reports and compatibility reports. The bug template requires the exact command and `/gemini:setup` output, because those two answer most questions unaided. The compatibility template accepts "works on X" as readily as "breaks on X", since the docs only claim what has actually been run.
- **Both READMEs and `docs/known-diffs.md` described job state as living in the project-local `.omc/state/` directory. It never has** — `resolveStateDir` has resolved outside the workspace since the first commit, and `.omc/` holds `/gemini:transfer` snapshots only. `known-diffs.md` additionally listed this as a *deliberate* divergence kept for compatibility, defending a location the code never used; the entry is withdrawn rather than reworded, and what is actually true is stated in its place. The real state location, its 50-job cap, the temp fallback and its cleanup risk are now documented in both READMEs.
- Repaired a duplicated block in `README.zh-TW.md`, where the tail of a code fence and the paragraph after it were repeated between two horizontal rules.

### Tests
- `tests/privacy-doc.test.mjs` pins `PRIVACY.md`'s presence, the four questions it must answer, and the link from every entry document — a policy doc rots when a README rewrite silently drops the link, not when the file is deleted. It also derives the expected supported-version line from `package.json`, so the table cannot go stale again without failing CI.
- `tests/sample-repo.test.mjs` covers the script a credential-free reviewer starts from: cases list, a materialized repo that is a real git repo with a non-empty diff and named defects, and an unknown case rejected rather than silently substituted.

Coverage for the paths that had none, per HANDOFF §14 P1. Verified against real git output, not only hand-written diffs:
- Untracked symlinks: escaping (skipped), in-workspace (still inlined), broken (still reported). Skipped with a reported reason on Windows hosts without symlink privilege rather than passing silently.
- `resolveStateDir` canonicalizes the workspace before hashing, so one checkout reached through a symlink shares a state dir, while two workspaces sharing a basename stay separate.
- Concurrent writers never expose a partially written `state.json` and leave no `.tmp` files. Pinned as the guarantee `atomicWriteJson` actually makes — a load/mutate/save cycle cannot also promise that concurrent writers keep each other's jobs.
- Hostile filenames through redaction: a directory containing a space, a rename whose destination is the secret store, and a git C-quoted non-ASCII path.
- Envelope truncation: an envelope cut mid-value is rejected, and so is one whose cut leaves a balanced inner object behind — the case where the balanced-block scan could otherwise report a successful run with no response. A large well-formed envelope is pinned as delivered intact, so any future size limit lands as a deliberate diff.
- Five cases pin the resolution order: neither variable set (temp fallback), `CLAUDE_PLUGIN_DATA` alone, `GEMINI_COMPANION_DATA` alone, both set (the deprecated name wins), and a blank value falling through. They set **both** variables explicitly on every case — the suite usually runs inside a Claude Code session, which sets `CLAUDE_PLUGIN_DATA`, so a test that only sets one silently depends on who is running it. Two existing cases had that flaw and are fixed.
- The concurrent-writer case failed reliably on Windows and passed in Linux CI, so it shipped green and was only caught when the suite was next run locally. Cause: Windows refuses `rename` onto a path another process has open, and the test's reader reopens `state.json` every millisecond, so the writers' renames raised `EPERM`. The writer now retries on a sharing error and still fails on a persistent one; the torn-read assertion is unchanged. Verified by three consecutive Windows runs.

### Compatibility
- **CI now schema-validates the manifests.** `verify-contracts` checks version lockstep, marketplace identity, the README install command and the command surface, but never schema-checked the manifests themselves — a `plugin.json` with a name containing spaces or a malformed `author` passed every gate and would only fail at user install time. Both workflows now run `claude plugin validate` against the plugin directory and the marketplace root, against a pinned Claude Code so a release cannot silently change what the gate accepts. A test asserts the two workflows keep the same pin; otherwise the PR gate and the release gate could drift into validating against different schemas with nothing reporting it. Verified credential-free on a CI runner.
- No engine, platform, command-surface, model-selection or write-permission semantics changed. The only user-visible behavior changes are the job-state relocation above, and untracked symlinks resolving outside the workspace now rendering as `(skipped: symlink resolves outside the workspace)` instead of being inlined into a review.

### Known limitations
- **On Windows, a `saveState` write can fail while another process holds `state.json` open** — the platform does not allow `rename` onto an open path, and `atomicWriteJson` lets the error propagate. In practice this needs a reader polling far harder than `/gemini:status` does, which is why it surfaced only under a test written to provoke it. No retry was added to the product in this release: that is a behavior change to the write path and belongs in its own change, not in a release already carrying a state relocation.
- Secret detection remains filename-based on every path. A credential pasted into an ordinary source file is not redacted, and this is not a secret scanner.
- The symlink containment check applies to untracked files, which is the path that reads through a link. Tracked symlinks are stored by git as their target string and appear in a diff as that string, so they were never followed.
- A git C-quoted non-ASCII path is reported in the redacted-file list in git's escaped form (`uni\303\247ode.env`). Unquoting it means implementing C-string unescaping; the current form is pinned by a test rather than left unstated.
- No automatic migration of pre-upgrade job state. The affected jobs live in a directory the OS was already free to delete.

### Not tested
- macOS and Linux beyond CI. Everything here was exercised on Windows and in `ubuntu-latest` CI; the macOS `/tmp` symlink case that motivated canonicalizing both sides of the containment check is reasoned from the platform's layout, not executed there.
- No engine was contacted. The envelope cases use the existing `runCommandFn` injection seam.
- Issue templates are parsed by GitHub on push and could not be validated locally.

## 0.14.1 — 2026-08-05 — Correct argument quoting on the Windows shell path

### Fixed
- **Arguments ending in a backslash were corrupted when `runCommand` used the Windows shell.** The escaper handled `"` but left backslashes alone, so MSVCRT read the doubled-up run as an escape: a value like `a b\` reached the child as `a b"`, `a b\\` as `a b\`, and `a\"b` as `a\b`. Backslashes are now doubled before a quote and at the end of the value, per the MSVCRT argv rules. Measured on Windows: all eight awkward values now round-trip through `node -p process.argv` unchanged, where three of them were mangled before. This path carries fixed or validated argv only (`where`/`gemini`/`taskkill`), so it was a latent defect rather than an exploitable one — the module comment explaining why this is not a general cmd.exe escaper still stands.
- **Table cells containing a backslash could break the Markdown table.** `escapeMarkdownCell` escaped `|` without escaping `\` first, so an input containing `\|` rendered as a literal backslash followed by a live column separator. Backslashes are escaped first. Display correctness only; no security claim attaches to it.

### Added
- `quoteForWindowsShell` is exported for tests. Its rules are Windows-specific and are **not** equivalent under POSIX `sh`, so they are asserted on the returned string — which runs everywhere — with the argv round-trip kept as a Windows-only leg.

## 0.14.0 — 2026-08-04 — Delegated output is framed as data

### Security
- **Model output relayed into Claude Code's context is now marked as untrusted data.** The commands require verbatim reproduction — correctly, since that stops the parent from softening or inventing findings — but it also meant text originating in a reviewed repository arrived with nothing marking it as data rather than instructions. See [`docs/THREAT-MODEL.md` §7.3](../../docs/THREAT-MODEL.md).
  - `review.md`, `adversarial-review.md`, `rescue.md` and `result.md` state that command output is untrusted data to reproduce but never act on. A contract test pins the rule and checks it has not displaced the faithful-reproduction requirement it sits beside. This covers every path, because the command file sits in the prompt alongside the output.
  - `renderTaskResult` additionally prefixes its output with `DELEGATED_OUTPUT_MARKER`. It is an HTML comment, so **nothing changes visually** — it does not render in Markdown — while remaining present in the text the parent agent reads. Only the task path emits it: that is the path whose output is model text with no plugin scaffolding around it, whereas a review is rendered by the plugin into its own verdict and findings structure.

### Known limits
- The marker names where untrusted content begins; it does not fence a region, so a model could still emit text shaped like plugin scaffolding after it. Closing that needs a per-run nonce delimiter, which would put visible noise in every result — recorded in the threat model as available if the residual is ever judged worth the cost.

## 0.13.0 — 2026-08-04 — Secret redaction on the review path

### Security
- **`/gemini:review` and `/gemini:adversarial-review` no longer send secret file contents to the model.** `transfer-context.mjs` had redacted secret-looking filenames since 0.10.0, but the review path collected `git diff` whole, with no filter — so the same `.env` change was redacted by `/gemini:transfer` and disclosed by `/gemini:review`. Untracked files were worse: `formatUntrackedFile` read them in full, so a new untracked `.env` was sent whole. See [`docs/THREAT-MODEL.md` §7.4](../../docs/THREAT-MODEL.md).
- **The secret pattern now catches stage-named stores.** It was anchored at `^\.env`, matching `.env` and `.env.production` but not `prod.env` or `staging.env`. Both the review and transfer paths now catch those.

### Added
- `lib/secrets.mjs` is the single definition of secret detection. `redactSecretsFromDiff` splits a unified diff on its `diff --git` boundaries and withholds the body of a secret file while keeping the header, so a review still knows the file changed without seeing its contents. `isSecretFile` is re-exported from `transfer-context.mjs` under its existing name.
- A 400,000-character cap on the review payload. Truncation is announced **inside the content**, so the model reports it rather than silently reviewing half a diff — the failure mode fixed for empty reviews in 0.6.4 applied to oversized ones too.

### Known limits
- Detection is filename-based. A credential pasted into an ordinary source file is not redacted on any path, and this is not a secret scanner.

## 0.12.0 — 2026-08-04 — Auto-routing checks credentials, not just presence

### Fixed
- **`auto` no longer selects an installed-but-unauthenticated Gemini CLI.** It picked gemini on `--version` success alone, so on any machine whose Gemini access has lapsed — the norm since Google ended consumer CLI access on 2026-06-18 — every `auto` command failed on auth while a working AGY sat beside it. Auto now requires the same "installed AND authenticated" condition `/gemini:setup` already reports as `geminiReady`. An explicit `--engine gemini` is unchanged: the check is a routing heuristic, not an authorization gate.
- **`auto` distinguishes "no engine installed" from "gemini installed but unauthenticated"**, because the fix differs and the second case previously surfaced as a confusing downstream API error.

### Changed
- The comment justifying gemini-first routing claimed AGY "responses and conversation ids still depend on transcript recovery". That stopped being true in v0.11.0; the rationale is now stated accurately — gemini's remaining edge is its model aliases and effort-to-model mapping, neither of which applies to an unqualified `auto`.
- `getGeminiLoginStatus` and `getGeminiPlanTier` moved to `lib/gemini-auth.mjs` so `engine.mjs` can consult credentials without an import cycle. Both are re-exported from `lib/gemini.mjs` under their existing names.
- `GEMINI_API_KEY` / `GOOGLE_API_KEY` now count as a credential for routing purposes; an API-key user has no `oauth_creds.json` and must not be read as unauthenticated.

### Added
- Auto-routing had **no test coverage at all** — which is why this defect shipped. `detectEngine` accepts `binaryAvailableImpl` and `hasGeminiCredentialsImpl` (matching the existing `resolveBinaryPathImpl` seam), and five tests now pin every branch of the decision.

## 0.11.1 — 2026-08-04 — Testable engine-response path

### Changed
- `runGeminiTurn` and `runGeminiReview` accept an optional third argument, `{ runCommandFn, detectEngineFn }`, mirroring the `{ spawnFn, detectEngineFn }` seam `dispatchBackgroundTask` already uses. No behavior change: both default to the real implementations.
- Envelope handling moved from spawn-driven fixtures to `tests/agy-envelope.test.mjs`, which injects those dependencies. Those cases previously could not run on Windows at all — the AGY stand-in there must be an absolute `.exe` (CVE-2024-27980), so a copied `node.exe` is used and cannot report a chosen AGY version. Two spawn tests remain to cover what unit tests cannot see: real argv reaching a process, and the transcript genuinely being read on AGY 1.1.7.

### Added
- Envelope coverage that did not exist before: an unrecognized `status` is treated as failure rather than rejected as malformed, stdout that is not an envelope reports `invalid-json`, and the review path's findings-JSON-inside-the-envelope-response nesting is asserted directly.

## 0.11.0 — 2026-08-04 — AGY native JSON envelope replaces transcript scraping

### Changed
- **AGY 1.1.8 and newer now take the response, conversation ID, and terminal status from `--output-format json`.** The on-disk transcript is not read at all on those versions, and no brain root is required — `/gemini:setup` and every AGY command work on a machine that has never run `agy` interactively. This removes the conversation-directory diffing that had to guess which directory belonged to the current run, along with the "transcript match is not certain" warning that guessing produced.
- **AGY results no longer include a reasoning-summary section.** The envelope reports a `thinking_tokens` count but carries no thinking text, and `stream-json` does not either (verified on 1.1.10: its step types are `user_input`, `unknown`, `agent_response`, `checkpoint`). The Gemini engine is unaffected — it takes its reasoning summary from stderr.
- **AGY failures classify better.** A `status: "ERROR"` envelope feeds its `error` string to the failure classifier, which already recognizes rate-limit and model-unavailable wording. Previously only stderr was visible, and AGY leaves stderr empty on this path.

### Fixed
- The `detectEngine` gate that refused to start AGY without a transcript brain dir now applies only below 1.1.8, where the transcript really is the only source for the response and conversation ID.

### Compatibility
- AGY below 1.1.8 keeps transcript recovery unchanged; `agy-transcript.mjs` and its 12 tests are untouched. A regression test pins AGY 1.1.7 to the transcript path and asserts it never receives `--output-format`.
- `conversation_id` from the envelope is byte-identical to the brain-directory name previously used as the thread ID, so stored job thread IDs and `agy --conversation <id>` resume commands are unaffected.

## 0.10.2 — 2026-08-04 — AGY 1.1.9/1.1.10 behavior alignment

### Fixed
- **AGY `--model` / `--effort` are now gated at 1.1.10, not 1.1.5.** AGY's 1.1.10 release notes record that both flags were applied after model configuration had already been initialized, so headless `-p` runs through 1.1.9 silently fell back to the persisted or default model. The plugin previously advertised support from 1.1.5 and forwarded a selection those versions ignored. Requests on 1.1.5–1.1.9 are now refused with an upgrade message instead of reporting a selection the run will not honor.
- **AGY invocations pass `--disable-slash-commands` on 1.1.9 and newer.** AGY 1.1.9 added slash-command and skill expansion to print mode. Task prompts are raw user text at position 0, so a request such as `/gemini:rescue /clear the cache logic` would have executed AGY's `/clear` instead of being read as instructions. The flag is omitted on older AGY, where it does not exist.

### Changed
- The three AGY version predicates share one `agyVersionAtLeast` comparison instead of repeating the parse; prerelease builds still fail closed.
- Version-specific wording removed from two errors that are not version-specific: the `--model` + `--effort` combination refusal, and the same refusal in `transfer`.
- `docs/adapter-contract.md` records both the 1.1.10 selection gate and the 1.1.9 slash opt-out.

## 0.10.1 — 2026-08-04 — `/gemini:transfer` command registration fix

### Fixed
- **`/gemini:transfer` is now actually registered as a slash command.** It shipped in 0.10.0 as `commands/transfer.json`, a format Claude Code's command loader ignores, so the command never appeared in `/plugin` and `scripts/transfer.mjs` had no entry point. Replaced it with `commands/transfer.md` following the same contract as every other command in this plugin: `disable-model-invocation: true`, `allowed-tools: Bash(node:*)`, a quoted `"$ARGUMENTS"` invocation, and explicit output-handling rules.
- **`transfer` now parses the quoted `"$ARGUMENTS"` string the slash command passes it.** It previously assumed a pre-split `argv`, which would have left `--engine`, `--model`, and `--effort` unparsed inside the instructions text. It now shares `normalizeArgv` + `parseArgs` with `gemini-companion.mjs` and rejects an unknown `--engine` value with the same message as the engine detector.

### Changed
- `normalizeArgv` moved from `gemini-companion.mjs` into `scripts/lib/args.mjs` so both entry points use one definition.
- `transfer.mjs` now guards its self-invocation with the `process.argv[1] === SELF_PATH` comparison already used by `gemini-companion.mjs` and `gemini-mcp.mjs`, instead of a loose filename suffix match.
- Command-contract tests now fail on any non-Markdown file in `commands/`, which is the defect class that hid this bug, and `transfer` is a required command in `verify-contracts`.

## 0.10.0 — 2026-08-04 — Session transfer command & AGY 1.1.10 updates

### Added
- **`/gemini:transfer` session handoff command.** Introduced `/gemini:transfer` to export workspace context (git status, diff, instructions) into a structured JSON snapshot and generate single-quoted POSIX Bash and Windows PowerShell launch commands for AGY or Gemini CLI. Includes secret redaction (`.env*`, `.npmrc`, `.p12`, `.key`, `id_rsa`), git conflict locking, per-file diff truncation, and automated `.omc/transfers/` LRU pruning (keeps latest 20 snapshots).
- **AGY 1.1.10 release alignment.** Documented Application Default Credentials (ADC) & Gemini Enterprise / WIF authentication options and the read-only `.git` sandbox rule in README documentation.

### Fixed
- **The MCP rescue parity test no longer depends on a locally installed Gemini CLI.** It now injects the runtime's existing engine-detection seam for both dispatch paths, so CI verifies byte-identical job prompts independently of developer-machine binaries.

## 0.9.0 — 2026-07-22 — AGY model and effort selection

### Changed
- **AGY 1.1.5 model or reasoning selection is now supported.** Task, review, and adversarial-review validate a selected engine before starting background work, then forward one of AGY's native `--model` or `--effort` flags. AGY model selection requires an exact ID from `agy models`; Gemini aliases fail before spawn, AGY accepts only `low|medium|high`, a model-plus-effort combination fails before spawn, and `--model` is rejected for a dual-engine review because model IDs are engine-specific. AGY versions below stable 1.1.5 reject these options with an upgrade message. Gemini's existing aliases, effort-to-model mapping, and fallback behavior are unchanged.

### Documentation
- Corrected the installation and update guidance: third-party marketplaces do not auto-update by default; this versioned plugin is updated only when its resolved manifest version changes; an update reported during a running session still requires `/reload-plugins`; and a tag-pinned marketplace remains pinned until it is removed and re-added at another tag. No runtime behavior changed.
- Corrected the AGY model-selection limitation: AGY 1.1.5+ now supports either an exact `agy models` ID or native `low`, `medium`, or `high` reasoning effort, with the documented engine-specific constraints.

## 0.8.0 — 2026-07-15 — First-class AGY and Git hardening

### Security
- **Git helpers no longer route repository-derived arguments through a Windows shell.** Every call in `lib/git.mjs` now forces `shell:false` after caller options, so auto-detected refs are passed as literal argv and cannot be reinterpreted by `cmd.exe`. A cross-platform regression creates a valid default ref containing `&`, places an adjacent command probe on `PATH`, and verifies branch target detection and diff collection complete without executing the probe. The test helper now honors an explicit `shell` override. ([#18](https://github.com/arcobaleno64/gemini-plugin-cc/issues/18))

### Changed
- **AGY is documented and reported as a first-class supported engine.** Gemini CLI and AGY are conditional dependencies: users install the CLI for the engine they select, while `auto` keeps capability-based Gemini→AGY ordering because Gemini exposes the plugin's JSON/model contract. Setup now permits the official `curl` installer without incorrectly requiring npm; runtime labels, skills, failure guidance, attribution, and the English/Traditional Chinese READMEs no longer describe AGY as an optional or lower-tier fallback.
- **AGY authentication status is now honest.** AGY 1.1.x uses an independent `consumerOAuth` flow whose state cannot be inferred from Gemini's `~/.gemini/oauth_creds.json`. `getAgyLoginStatus()` now returns `state:"unknown"` and `verifiable:false` for an installed AGY binary, instructs users to run `agy` interactively, and never claims the shared Gemini credential proves AGY login. The existing `loggedIn` and `agyFallbackAvailable` fields remain for JSON compatibility; consumers should use `agyAuth.state`, and the additive `agyAvailable` field carries the support-neutral availability signal.

### Documentation
- Added the AGY 1.1.2 macOS/Linux validation checklist and Ubuntu 24.04 WSL2 live evidence for stdin/stdout, foreground task, background task, structured review, invalid-model failure, OAuth TTY/headless behavior, transcript pairing, and the complete Linux test suite. Real macOS 1.1.2 remains explicitly `OPTIONAL / NOT RUN` as a platform-validation gate, not an indication that the AGY engine itself is optional.
- Updated the AGY prompting anti-patterns to distinguish older positional `--print` behavior from the 1.1.2 stdin auto-print path while retaining transcript-authoritative recovery.

### Tests
- The complete Windows suite passes: 238 tests, 235 passed, 0 failed, with 3 POSIX-only AGY fixtures skipped as expected. A real local AGY 1.1.2 `setup --engine agy` smoke reports `agyAvailable:true`, `authState:"unknown"`, and `authVerifiable:false` without reading or exposing credentials.

### Compatibility
- No slash-command flags, engine names, permission policy, transcript recovery, timeout, or task/review result structure changed. Gemini-only and AGY-only installations remain valid; installing both CLIs is not required.

## 0.7.1 — 2026-07-14 — AGY stdin transport

### Changed
- **AGY 1.1.2 and newer now receive prompts on stdin.** The adapter parses `agy --version` and, only for a stable version at or above 1.1.2, omits both `--print` and the prompt from argv so AGY auto-enters print mode from piped input. Older, prerelease, and unparseable versions fail closed to the existing `agy --print <prompt>` path. The 24,000-character and NUL preflight checks now apply only to that positional fallback. Windows still requires an absolute `.exe` and `shell:false`; `--print-timeout`, `--continue`, `--new-project`, and `--dangerously-skip-permissions` behavior is unchanged. (`lib/engine.mjs`, `lib/gemini.mjs`)
- **Transcript recovery remains authoritative.** Both task and review still snapshot the AGY brain directory and use the completed transcript for response text, DONE status, thinking, and conversation ID. Stdout is retained for diagnostics but does not replace the transcript contract, and the 105-second print / 120-second hard timeout strategy remains unchanged. (`lib/agy-transcript.mjs`)

### Tests
- Added version-boundary and argv tests for AGY 1.1.1 versus 1.1.2, including a prompt above the old 24,000-character positional limit. A POSIX fake AGY executable records argv/stdin, emits a conflicting stdout decoy, and writes a DONE transcript to cover task, review, legacy fallback, and transcript precedence. Existing task/review stderr-without-transcript regressions remain in place; Windows is covered by the AGY 1.1.2 live smoke described below.

### Validation
- **AGY 1.1.2 on Windows:** a foreground read-only task completed in 14 seconds and a background task in 13 seconds; both returned their unique marker, no touched files, and a conversation ID that matched a completed on-disk transcript. A one-line synthetic working-tree review completed in 26 seconds, returned structured JSON, and identified the planted wrong-operator defect. A direct invalid-model invocation used stdin with no `--print`, exited 1 in 1.7 seconds, wrote no stdout, and returned a non-empty stderr error plus the available-model list. A larger 53 KB review prompt reached a new transcript but produced no planner response before the existing 105-second print / 120-second hard timeout, which surfaced as `transcript-missing`; this confirms the transport while retaining the documented review-size/time boundary. Real credentials were not revoked, so the upstream OAuth fail-fast path remains documentation-backed rather than live-tested.

## 0.7.0 — 2026-07-14 — MCP bridge and AGY resilience

### Added
- **F-CC1: hand-rolled stdio MCP server.** Added `gemini_rescue`, `gemini_review`, `gemini_job_status`, `gemini_job_result`, and `gemini_job_cancel` as thin JSON-RPC wrappers over the existing companion dispatch, job-control, and state paths. The plugin now declares the server through `.mcp.json`; MCP and CLI background dispatch share the same persisted request construction so prompt assembly cannot drift.
- **F-CC2: parallel blind adversarial review.** `/gemini:adversarial-review --engines gemini,agy` now queues prompt-identical background jobs with one shared group ID, aggregates both engines in `/gemini:status` and `/gemini:result`, and degrades to the available engine with an explicit stderr warning when only one requested CLI is usable.

### Fixed
- **AGY 1.1.2 server-side failures now preserve actionable stderr when transcript recovery has no response.** The task and review runners no longer throw a transcript-only generic error before classifying AGY's non-zero exit. They now pass the exit status, signal, spawn error, stdout, stderr, and transcript reason through the existing failure classifier, so authentication, quota, rate-limit, and model errors take precedence while unknown failures still fall back to the transcript category. Completed transcript responses remain authoritative, and transcript recovery is unchanged. Added isolated fake-AGY runtime coverage for both task and review plus a classifier-precedence regression test. (`lib/gemini.mjs`)
- **`--engine agy --write` no longer silently writes to AGY's scratch dir instead of the target directory.** Machine-verified on AGY 1.1.0/Windows 2026-07-09: a fresh (non-continuation) `agy --print --dangerously-skip-permissions` write turn with no prior workspace/project association creates files under `~/.gemini/antigravity-cli/scratch/` rather than the spawned `cwd` — silently, with `status: 0` and no error, so a caller only notices by checking the file landed in the wrong place. `buildCliArgs` now appends `--new-project` on a write turn that is not a `--continue` resume, binding the session's workspace to `cwd`; a resumed conversation is left alone since it already has its original project association. New `tests/engine.test.mjs` coverage for the three `buildCliArgs("agy", ...)` flag-composition cases (write, resumed write, read-only). (`lib/engine.mjs`) Re-verified end-to-end post-commit on AGY 1.1.0/Windows 2026-07-10: a fresh `task --engine agy --write` turn completed in 13s (job `completed`, no `request-review` stall) with the probe file landing in `cwd`, not scratch.

### Documentation
- **AGY 1.1.2 compatibility assessment.** Windows machine validation uses AGY 1.1.2 as the current baseline: read-only foreground and background tasks both completed in 15 seconds or less, returned the expected marker, and matched the conversation ID and on-disk transcript. The isolated fake-AGY review regression and the complete 232-test suite also pass. A corrected direct probe confirmed the new auto-print syntax: supplying the prompt on stdin with no `--print` flag exited 0 and returned the marker on stdout; `--print`, `-p`, and `--prompt` still require their own string argument. With that stdin syntax, an invalid `--model` exited 1, wrote a non-empty error plus the available-model list to stderr, and did not silently fall back. The earlier exit-0 observation was a malformed probe where `--print` consumed `--model` as its prompt argument. The upstream changelog also documents OAuth-code input through `/dev/tty` or Windows `CONIN$` when stdin carries the prompt, plus fail-fast behavior when no controlling terminal exists; real credentials were not revoked to retest that path. Plugin v0.7.0 still uses positional `agy --print <prompt>` and keeps transcript recovery authoritative; the stdin transport is deferred to a version-gated adapter change. The nested-command allowlist change mostly does not affect the plugin's `--write` path because it uses `--dangerously-skip-permissions`, while MCP shutdown cleanup helps only when the user's AGY configuration loads MCP servers. The plugin still does not expose AGY `--agent` selection and does not change its `--write` permission flags.
- **AGY 1.1.0 impact assessment.** AGY 1.1.0 (released 2026-07-08) makes `request-review` the default execution mode: it pauses before file writes to show an interactive line-level diff preview. Machine-verified 2026-07-09 that `--dangerously-skip-permissions` still fully suppresses this pause for a headless `--engine agy --write` turn — no `--mode accept-edits` workaround needed. Also confirmed via `agy --help` on 1.1.0 that the four other flags this plugin depends on (`--print`, `--continue`, `--print-timeout`) are unchanged, and via the upstream tracker that [google-gemini/gemini-cli#27466](https://github.com/google-gemini/gemini-cli/issues/27466) (`agy --print` empty stdout) remains open as of 2026-06-23, so `agy-transcript.mjs`'s transcript-recovery path is still required. The `/agents` panel global-config-dir fix in 1.1.0 (`~/.gemini/antigravity-cli/` → `~/.gemini/config/`) targets subagent definitions, not the transcript "brain" root this plugin reads — no path change there.
  - **Known limitation found, not yet fixed: `getAgyLoginStatus()` is stale for AGY 1.1.0.** It infers AGY's login state from the shared gemini CLI credential file (`~/.gemini/oauth_creds.json`), per a comment asserting "AGY stores no credential of its own." That is no longer true: AGY 1.1.0's `cli.log` shows a distinct `consumerOAuth` flow ("You are not logged into Antigravity" / "authenticated successfully as ...") that is independent of the gemini CLI's OAuth state and is established by running `agy` interactively, not `gemini`. Machine-verified 2026-07-09: `~/.gemini/oauth_creds.json` stayed untouched (and reported "expired") through two `gemini`-driven logins, while `agy --print` failed with `authentication failed or timed out` until the user logged in via `agy` directly — after which the shared-credential-based status function would still have reported AGY as logged out. Where AGY 1.1.0 persists its own token was not located (not a plaintext file under `~/.gemini` or `%APPDATA%`/`%LOCALAPPDATA%`; likely OS credential storage), so `getAgyLoginStatus()` was left as-is rather than patched with an unverified detection heuristic.
- **macOS AGY is now platform-verified.** On macOS (agy 1.0.7) the AGY brain root is `~/.gemini/antigravity-cli/brain` — the same path already first in `agyBrainRoots()` — so `--engine agy` works out of the box: `gemini-companion.mjs task --engine agy` was run end-to-end on macOS and recovered the response from the transcript (`<conv>/.system_generated/logs/transcript{,_full}.jsonl`, matching the expected layout), and the upstream no-pipe behavior of `agy --print` ([google-gemini/gemini-cli#27466](https://github.com/google-gemini/gemini-cli/issues/27466)) was reproduced on macOS (0 bytes reach stdout through a pipe), confirming transcript recovery is required there too. Updated README (EN + zh-TW) Engine Routing / Troubleshooting / Known limitations, the `gemini-prompting` antipatterns reference, and the `agy-transcript.mjs` platform notes; TODO-3 (platform paths) is resolved, and the "no brain root" reason string now tells the user to run `agy` once instead of pointing at an internal TODO. No behavior change — comments, docs, and one user-facing message only.
- **README install snippets and dependency table refreshed to the current release.** Pinned-install examples now reference the latest tag `v0.6.6` (was the stale `v0.6.0`), the "newer tag" example bumped to `v0.6.7`, and the AGY dependency row reads `≥ 1.0.3` (1.0.7 verified on macOS). Docs only, no behavior change.

## 0.6.6 — 2026-06-09 — review retry resilience

### Fixed
- **Transient gemini review failures are now retried.** The gemini CLI intermittently returns an empty / `Invalid stream: ...malformed tool call` envelope (or a transport-level rate-limit / unavailability) for an otherwise-valid request; previously a single such flake surfaced to the caller as a parse error and forced a manual re-run (observed needing 2–3 attempts for the same input in practice). `/gemini:review` and `/gemini:adversarial-review` now call `runGeminiReviewResilient`, which re-runs a **read-only** review up to 3 times when the result is transient (empty stdout+stderr, or an `Invalid stream` / `malformed tool call` / `resource_exhausted` / `unavailable` / `5xx` / `429`-class signal with no parseable findings). A review that yields structured findings — or real, non-transient prose — is **never** retried (read-only reviews are idempotent, so the retry is side-effect-free); `agy` is never retried (its transcript-recovery path and fail-fast 2-min timeout handle its distinct failure mode). This composes with the existing GA-fallback retry (model-not-found, fixed within one attempt) rather than replacing it. The transient signal is matched **by channel** to avoid false positives: the malformed-output envelope on either stream, but loose transport words (`unavailable`, `rate limit`, `5xx`, …) only on stderr — so a review whose prose happens to discuss an HTTP status code is not mistaken for a flake; as a backstop, identical non-empty review text across attempts is treated as deterministic output and kept rather than retried. New helper `isTransientReviewFailure`, fixture scenario `review-transient-then-clean`, and regression tests.

## 0.6.5 — 2026-06-04 — low-severity cleanup

### Fixed
- **`/gemini:cancel` no longer claims a kill it did not make.** The detached worker is `unref()`-ed, so by cancel time its PID is often already gone; `handleCancel` discarded `terminateProcessTree`'s return value and always logged "Cancelled by user." It now reports the real outcome — `terminated the running process`, `no live process (it had already exited)`, or `no live process was attached` — in the log, the `# Gemini Cancel` report (a new `- Process:` line), and a new `processTerminated` field on the `--json` payload. The job is still marked `cancelled` in every case (the user's intent is recorded). New shared `describeTermination` helper. (`gemini-companion.mjs`, `lib/render.mjs`)
- **Narrowed the reasoning-noise `[DEP\d+]` filter.** `REASONING_NOISE` matched a bare `[DEP12]` token anywhere, which could strip a genuine reasoning line that merely contained such a bracket. It now requires Node's canonical `(node:NNN) [DEPxxx]` preamble, so real deprecation warnings are still filtered while legitimate reasoning survives. (`lib/gemini.mjs`)

### Tests
- 168 → 172: honest `/cancel` outcome (render-level wording for all three states + a no-pid integration case asserting `processTerminated:false`), the narrowed DEP filter (a `[DEP12]` reasoning line survives while a real `(node:…) [DEP0190]` line is filtered), and a multi-line focus-text round-trip through the background `review-worker`.

### Documentation
- README (EN + zh-TW): added a **Known limitations** section consolidating the documented, non-blocking constraints (macOS AGY unverified, Gemini 3.5 not served by the CLI + 2026-06-18 free-CLI sunset, `/review` prompt-adapter vs native reviewer) with cross-links to the detailed sections.

## 0.6.4 — 2026-06-04 — empty-diff review guard

### Fixed
- **Background review of a clean/empty diff no longer passes vacuously.** `executeReviewRun` now short-circuits when the resolved review target has no changes — a working tree with nothing staged/unstaged/untracked, or a branch diff with no commits and an empty patch — returning an explicit `empty: true` / `result: null` payload rendered as `Nothing to review — <target> has no changes.` instead of asking Gemini to review an empty diff (which it rubber-stamps as "approved"). This closes the v0.6.1-audit gap where a detached `--background` review re-resolved the diff at run time and, if the tree was clean when the worker started, silently persisted a vacuous approve only visible at `/gemini:result`. The foreground and background paths share `executeReviewRun`, so both are covered, and the stop-review-gate stays non-blocking on an empty result (`result: null` → verdict is not `needs-attention`). New `isEmpty` flag on the working-tree/branch review context. (`lib/git.mjs`, `gemini-companion.mjs`)

### Tests
- 166 → 168: an empty working tree review surfaces "nothing to review" without invoking Gemini (the fake-gemini state file is never written); a `--json` empty review carries `empty:true` / `result:null` so the gate proceeds. The pre-existing "adversarial review forwards focus text" test now diverges onto a feature branch so `--base main` resolves to a non-empty diff — it previously exercised the empty-branch-diff path this fix targets.

## 0.6.3 — 2026-06-02 — reasoning-noise filter fix

### Fixed
- **True-color terminal warning leaked into review "Reasoning:".** `REASONING_NOISE` (`lib/gemini.mjs`) only matched the `256-color` terminal-capability warning, but gemini CLI 0.44.1 emits the `True color (24-bit) support not detected` variant. That line matched none of the patterns, so `extractReasoningSummary` kept it and it surfaced as a bogus model-reasoning bullet in review output. Added a `/true color/i` pattern. (The DEP0190 lines seen alongside it during diagnosis were the parent process's own deprecation warning surfaced via a `2>&1` redirect, **not** a filter failure — the v0.6.1 DEP0190 filter works correctly on the subprocess stderr it targets.)

### Tests
- Extended the `review-noisy` fixture/test: it now emits the true-color line on stderr and asserts genuine reasoning still surfaces (`Considering empty-state`) while the true-color warning is filtered out. 166 tests pass.

## 0.6.2 — 2026-06-02 — model resilience, agentic review, transparency

### Added
- **Graceful model-not-found fallback.** If a requested model id is not served by the local gemini CLI (a preview/retired id, or CLI-version skew — e.g. `gemini-3.5-flash` returns 404 on CLI 0.44.1), the plugin retries the run **once** on the GA fallback `gemini-2.5-flash` and shows a visible banner instead of hard-failing. Applies to `/gemini:review`, `/gemini:adversarial-review`, and `/gemini:rescue`; the AGY path is unaffected. (`lib/gemini.mjs`)
- **`--deep` agentic review.** `/gemini:review` and `/gemini:adversarial-review` accept `--deep`, which invites Gemini to use its read-only tools to inspect repo context beyond the diff (dependency manifests, untracked files, callers) before producing the same JSON findings — closing the harness gap versus a native agentic reviewer. The default stays the fast, diff-scoped single-shot review (no behavior change). Verified live: `--deep` flags an undeclared dependency that the diff-scoped review cannot see.
- **Stop-review-gate hook test coverage** (3 deterministic tests: disabled → silent; enabled with no write task → proceed; review-failure → fail-open with a visible warning).
- **`docs/MODEL_COMPARISON.md`** — empirical model-vs-harness comparison and the local model-availability reality; **`docs/PARITY_AUDIT_v0.6.1.md`** — the v0.6.1 re-score.

### Changed
- `model-map`: `lite3` → `gemini-3.1-flash-lite` (verified GA id; drops the `-preview` suffix). Metadata records that Gemini 3.5 is GA on the API but not served by the gemini CLI 0.44.1 (reach it via AGY).
- README (EN + zh-TW): added a 2026-06-18 free-CLI-sunset heads-up, the Gemini 3.5 availability reality (CLI 404 → use AGY), the graceful-fallback note, and `--deep` documentation — so user expectations match reality.

### Tests
- 159 → 166 (model-not-found fallback for review + rescue; `--deep` prompt injection on/off; stop-gate hook coverage).

## 0.6.1 — 2026-06-02 — parity-audit follow-up fixes

### Fixed (P0)
- **`/gemini:rescue` resume prompt never fired.** `handleTaskResumeCandidate` emitted `found`, but `commands/rescue.md` keys the "continue current thread?" prompt off `available` (as upstream codex does). The companion now emits `available` in all branches; a contract guard test asserts `available` is present and the legacy `found` is gone.

### Added (P1)
- **Persistent background reviews.** `/gemini:review --background` and `/gemini:adversarial-review --background` now enqueue a detached `review-worker` (mirroring `task-worker`) instead of relying on Claude-layer `run_in_background`, so a background review result survives an interrupted session and is retrievable via `/gemini:status` / `/gemini:result`. New `review-worker` subcommand; `enqueueBackgroundJob`/`spawnDetachedWorker`/`runStoredJobWorker` generalize the shared machinery.

### Fixed (P1)
- **Stop-review-gate is no longer silent on skip.** On review failure / Gemini-unavailable the gate still fails open, but now surfaces a `systemMessage` + stderr warning so the user knows the gate was skipped. It also reviews `--scope working-tree` explicitly (where `--write` task edits live) instead of relying on auto scope.
- Removed dead `renderNativeReviewResult` from `lib/render.mjs`.

### Fixed (P2)
- **Standard `/gemini:review` mislabeled its progress as "adversarial review".** `runGeminiReview` is now mode-aware (`isAdversarial`).
- **CLI noise leaked into the "Reasoning:" output.** `extractReasoningSummary` now drops DEP0190 deprecation, 256-color, and ripgrep-fallback lines before the last-N slice.
- **Preview-model drift is now visible.** `/gemini:setup` reports the model-alias count, how many resolve to `*-preview` IDs, and the `lastVerified` date.

### Documentation
- README (EN + zh-TW): clarified that `agy --print` is locked to Gemini 3.5 Flash (High) and ignores `--model`/`--effort` (was incorrectly described as interactive selection); noted the DEP0190 warning is benign; documented that AGY transcript recovery is verified on Windows/Linux only (macOS unverified).
- Added `skills/gemini-prompting/references/` (blocks, recipes, anti-patterns), matching upstream `gpt-5-4-prompting`.

## 0.6.0 — 2026-06-01 — parity audit

### Breaking
- **`/gemini:setup` readiness now requires authentication.** `ready` is `true` only when Node **and** the Gemini CLI are present **and** OAuth is valid. An installed-but-unauthenticated Gemini now reports `ready: false` (previously `true`). New JSON fields: `readyState` (`ready` | `partial` | `not-ready`), `geminiReady`, `agyFallbackAvailable`.

### Fixed (P0)
- **Review target was discarded.** `/gemini:review` and `/gemini:adversarial-review` now honour `--base <ref>` and `--scope <auto|working-tree|branch>`; `executeReviewRun` previously re-resolved the target with empty options, silently dropping the user's selection.
- **Contradictory verbatim contract.** Removed the "STOP and ask which issues to fix" instruction from `review.md` / `adversarial-review.md`, which conflicted with the "return stdout verbatim" rule.
- **AGY install was over-eager.** `setup.md` now installs Gemini CLI as the primary engine and only prompts for AGY when the user passes `--engine agy`. Auth guidance is unified on running `gemini` (there is no `gemini login` subcommand).

### Fixed (P0 — post-audit, local-verified on agy 1.0.3 / gemini 0.44.1)
- **AGY install command was wrong (4 sites).** `npm install -g agy` installs an unrelated npm package; replaced with the official installer `curl -fsSL https://antigravity.google/cli/install.sh | bash` in `README.md`, `README.zh-TW.md`, `commands/setup.md`, and the `gemini-companion.mjs` setup hint. AGY version baseline pinned to `1.0.3`.
- **AGY silent 10-minute hang.** Local verification showed `agy --print` does not deliver its response over a pipe in non-interactive (non-TTY) use — it returned empty stdout or hung to its print-timeout under the exact piped spawn the plugin uses, while `gemini -p --output-format json` piped a clean JSON envelope every time. AGY's spawn timeout is now capped at 2 min (was 10) in `runGeminiTurn`/`runGeminiReview` so it fails fast instead of hanging, and `getAgyLoginStatus` reports the limitation honestly (and no longer reads the non-existent `status.version` field).
- **engine.mjs auto-branch comment corrected, not deleted.** The note that AGY cannot pipe output non-interactively is accurate (verified), so it was made precise rather than removed; gemini stays the preferred auto engine.

### Not done (local evidence overrode the audit prompt)
- **AGY-first auto routing for personal plans was NOT implemented.** The audit asked for it, but because `agy --print` does not pipe output, defaulting delegation to AGY would make tasks silently fail or hang. Auto-detection keeps gemini first; `--engine agy` / `GEMINI_ENGINE=agy` still force AGY for callers who explicitly want it.
- **Model-id / ListModels reconciliation deferred (needs API key).** `gemini` was confirmed to pipe a valid JSON envelope and to auto-route `gemini-2.5-flash-lite` → `gemini-3.1-flash-lite`; the `flash` alias marketing-name vs API-id check still requires the Generative Language API ListModels endpoint and is left untouched, flagged in `model-map.mjs`.

### Changed (P0-E — AGY transcript mode, v4)
- **AGY recovers its response from the on-disk transcript (#27466 workaround).** `agy --print` never writes its response to stdout under a pipe (upstream bug google-gemini/gemini-cli#27466), so `runGeminiTurn`'s agy branch no longer reads stdout: it snapshots agy's conversation ("brain") dirs before the spawn, then diffs them afterwards and reads the new conversation's `transcript_full.jsonl`/`transcript.jsonl`, returning the last `PLANNER_RESPONSE` row's `content` (with `thinking` as the reasoning summary and `convDir` as the resumable conversation id). New module `scripts/lib/agy-transcript.mjs`.
- **Fail-loud, never silent-empty.** If transcript recovery yields nothing, `runGeminiTurn` throws (citing #27466) instead of returning an empty result. `detectEngine` also refuses an explicit `--engine agy` early when no transcript brain dir exists on this platform (otherwise it permits agy and the transcript path handles it).
- **TODO-3 timeout grace.** agy's own `--print-timeout` is now set ~15 s shorter than the hard spawn kill so agy self-terminates and flushes a final `status:"DONE"` transcript row before `spawnSync` SIGKILLs it; success is judged by that row, not the (often killed) exit code.
- **Local verification (agy 1.0.3, Windows):** transcript path `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`; `agy --conversation <fresh-uuid>` does NOT pin a self-generated id (antigravity-cli#7 open), so a set-diff is used rather than a known id. `agy --print` is hardcoded to Gemini 3.5 Flash (High) with no model/effort flag — the ignore-note now states this explicitly. End-to-end proof: `task --engine agy` returned the transcript-recovered answer with empty agy stdout.
- **`getAgyLoginStatus` now checks real auth.** AGY stores no credential of its own (verified: no oauth/token file under any `~/.antigravity*` or `~/.gemini/antigravity-cli` dir) and runs off the same Google OAuth as the gemini CLI, so login status is now gauged from that shared `~/.gemini/oauth_creds.json` (presence + expiry) instead of mere binary presence.
- **Personal-plan 2026-06-18 EOL warning.** New `getGeminiPlanTier()` reads `~/.gemini/settings.json` (`security.auth.selectedType`); `setup` now appends a heads-up for `oauth-personal` plans that gemini CLI free access ends 2026-06-18, pointing to Gemini Code Assist Standard/Enterprise or the AGY transcript path. Enterprise/unknown tiers stay silent. New JSON field `geminiPlanTier`.
- **`runGeminiReview` agy path now uses transcript recovery too.** The adversarial/standard review path mirrors `runGeminiTurn`: for agy it snapshots brain dirs, applies the timeout grace, recovers the review text from the transcript (parsing the JSON findings out of it), and fails loud if nothing is recoverable — instead of reading the always-empty stdout (#27466).
- **`model-map.mjs` states the AGY model lock explicitly.** The effort-tier comment now records that AGY's `--print` is hardcoded to Gemini 3.5 Flash (High) with no model/effort flag, so tiers apply to the gemini engine only.

### Changed (P2 — engine-aware resume display)
- **`/gemini:result` (and job status) now show the correct per-engine resume command.** gemini jobs show `Gemini session ID` + `gemini --resume <id>` (the old hint used a non-existent `gemini resume` subcommand); AGY jobs show `AGY conversation ID` + `agy --conversation <id>` (the verified resume flag). The resolved engine is persisted on each completed job (`engine` field in the job record), and `render.mjs` derives the hint from it.

### Added (P1)
- **Claude session job filtering.** `/gemini:status --all` now crosses sessions (default stays scoped to the current Claude session); resume-candidate and active-task checks respect the session boundary.
- **Single source of truth for models.** New `scripts/lib/model-map.mjs` holds aliases + effort tiers + provenance (`lastVerified`, `source`, preview flags); the README table is verified against it.
- **Contract verification.** New `scripts/verify-contracts.mjs` (`npm run verify-contracts`) and ported `scripts/bump-version.mjs` (`npm run check-version` / `bump-version`). CI now runs `npm test`, `check-version`, and `verify-contracts`.
- `getSessionRuntimeStatus` now returns a `label`/`mode` so setup/status no longer render `session runtime: undefined`.

### Tests
- 90 → 117 tests. New coverage: `--base`/`--scope` divergence, setup readiness (auth missing/expired/AGY-fallback), session filtering, stdin prompt safety (metacharacter matrix), stderr-does-not-pollute-JSON, model-map/README consistency, and contract/version verification.

### Documentation
- README (EN + zh-TW): Compatibility Matrix, Codex app server vs Gemini CLI adapter, expanded Security Notes, Setup & Auth Troubleshooting, Model Alias Notes, and Upstream Attribution.

## 0.5.0 — 2026-05-27

### Added
- `/gemini:review` — standard (non-adversarial) code review; finds real bugs, missing error handling, and incomplete paths.
- `prompts/review.md` — pragmatic reviewer prompt template (same JSON output schema as adversarial-review).
- Review Gate fully implemented: `stop-review-gate-hook.mjs` now runs `adversarial-review` before session end when any `--write` task completed; blocks with finding summary if verdict is `needs-attention`.
- `/gemini:setup --enable-review-gate` / `--disable-review-gate` flags to toggle the gate without editing config JSON.
- `setup` output now includes `review gate: enabled/disabled` status.

### Fixed
- `buildSetupReport` now reads `reviewGateEnabled` from config and passes it to `renderSetupReport` — previously always rendered as "disabled".
- `commands/result.md` now mentions `/gemini:review --wait` in follow-up suggestions.

### Documentation
- README: `/gemini:rescue` flags table now includes `--fresh` (force new session).
- README: `/gemini:result` section now explains the `Resume in Gemini: gemini resume <session-id>` output.
- README: new Review Gate section with enable/disable instructions.

## 0.4.0 — 2026-05-27

### Added
- Gemini 3.x model aliases: `flash`/`flash3` → `gemini-3.5-flash` (GA), `pro`/`pro3` → `gemini-3.1-pro`, `lite3` → `gemini-3.1-flash-lite`.
- Backward-compat aliases `flash25` → `gemini-2.5-flash`, `pro25` → `gemini-2.5-pro`.
- `effort` mapping updated: `low`/`medium` → `gemini-3.5-flash`, `high`/`xhigh` → `gemini-3.1-pro`.
- `task-resume-candidate` now guards against active/queued tasks (mirrors `resolveLatestTrackedTaskThread` guard).

### Fixed
- `renderSetupReport` was reading `report.auth.detail` (field does not exist); corrected to `report.geminiAuth.detail` and `report.agyAuth.detail`.
- `verdict ?? outcome` alias in `validateReviewResultShape` / `normalizeReviewResultData` now uses `||` — `??` failed to fall through when `verdict` was an empty string.
- `detectEngine` was reading `status.version` (field does not exist on `binaryAvailable` return); corrected to `status.detail`.
- `detectEngine` now throws on unknown engine values instead of silently falling back to auto.
- Removed `preview` alias that mapped to the non-existent `gemini-3-pro-preview`.

## 0.3.0 — 2026-05-27

### Added
- Marketplace installation support: `/plugin marketplace add arcobaleno64/gemini-plugin-cc`
- Session ID (`threadId`) extraction from Gemini CLI JSON envelope in task runs — enables `--resume-last` to work correctly.
- `GEMINI_HOME` environment variable support for non-standard credential paths.

### Fixed
- `appendReasoningSection` now accepts both `string` (from `gemini.mjs`) and `Array` — reasoning output was silently dropped before this fix.
- `runCommand` null `status` now resolves to `1` when the process was killed by a signal or failed to spawn, instead of masking failures as exit `0`.
- `marketplace.json` and `plugin.json` updated with correct owner (`arcobaleno64`), repository URL, and version `0.3.0`.
- README installation section updated with proper marketplace workflow.

## 0.2.0 — 2026-05-27

### Fixed
- **P0 Windows ENOENT**: Replaced custom `runSpawn` (`shell: false`) with `runCommand` from `process.mjs` (`shell: true` on Windows), resolving failure to execute `.cmd` wrappers installed by npm.
- **P0 Shell injection**: Gemini CLI prompts are now delivered via stdin (`input` option) instead of the `-p` CLI argument, eliminating shell metacharacter injection on Windows (`shell: true` path).
- **P0 AGY pipe output**: `auto` engine order swapped — `gemini` CLI is now preferred; `agy` is fallback. AGY cannot write to a pipe in non-interactive mode and silently returned empty output as the former default.
- **P1 `task-resume-candidate` missing**: Added `handleTaskResumeCandidate` handler and `task-resume-candidate` subcommand to `gemini-companion.mjs`; previously caused `Unknown subcommand` errors from `gemini:rescue`.
- **P2 OAuth token expiry**: `getGeminiLoginStatus()` now parses `oauth_creds.json` and reports expired tokens before any invocation attempt, rather than only checking for file existence.

### Added
- `runCommand` now accepts `maxBuffer` and `timeout` options (forwarded to `spawnSync`).
- `buildCliArgs` accepts `useStdin` flag; when set for the `gemini` engine, the prompt is omitted from the args array and must be supplied via `input`.
- `README.md` and `README.zh-TW.md` with full command reference, security notes, and architecture diagram.
- `.gitignore` excluding `.omc/` runtime state directory.

## 0.1.0 — 2026-05-26

### Added
- `gemini-companion.mjs` runtime with AGY auto-detect and Gemini CLI fallback
- `session-lifecycle-hook.mjs` for `GEMINI_COMPANION_SESSION_ID` injection on SessionStart/End
- `stop-review-gate-hook.mjs` stub (opt-in via `stopReviewGateEnabled` config)
- Slash commands: `/gemini:setup`, `/gemini:rescue`, `/gemini:result`, `/gemini:status`, `/gemini:cancel`, `/gemini:adversarial-review`
- Skills: `gemini-cli-runtime`, `gemini-prompting`, `gemini-result-handling`
- Agent: `gemini-rescue` — thin forwarder to the companion task runtime
- `hooks/hooks.json` — SessionStart, SessionEnd, Stop hooks
- Engine routing: AGY preferred, Gemini CLI fallback; `--engine agy|gemini` to force
- Model aliases: `flash` → gemini-2.5-flash, `pro` → gemini-2.5-pro, `lite` → gemini-2.5-flash-lite
