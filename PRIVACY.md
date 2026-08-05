# Privacy and Data Handling

This document states exactly what `gemini-plugin-cc` reads, what it sends, where it
sends it, and what it keeps. Every claim here is checkable against the source
files cited beside it. If you find a statement that the code does not support,
that is a bug — report it as described in [`SECURITY.md`](SECURITY.md).

Applies to plugin version 0.14.x.

---

## 1. The plugin operates no service

- **No remote endpoint of its own.** The plugin makes no HTTP requests, opens no
  sockets, and performs no DNS lookups. There is no `fetch`, `http`, `https`,
  `net`, or `dns` call anywhere in `plugins/gemini/scripts/`. The only URLs in
  the source are install instructions inside error messages
  (`scripts/gemini-companion.mjs`).
- **No telemetry, analytics, crash reporting, or update check.** None exists to
  disable.
- **No dependencies.** `package.json` declares neither `dependencies` nor
  `devDependencies`; everything runs on the Node standard library. There is no
  third-party package that could collect anything.
- **Nothing is sent to the maintainer.** The maintainer receives only what you
  choose to put in a GitHub issue or a security advisory.

---

## 2. What leaves your machine

Data leaves your machine on exactly one path: the plugin spawns the **Gemini CLI
or Antigravity CLI (`agy`) binary you installed**, and that binary sends your
prompt to Google. The plugin is the thing that assembles the prompt; Google's CLI
is the thing that transmits it.

Transport is argv or stdin on a `shell: false` child process — never a shell
command line. See [`SECURITY.md`](SECURITY.md) for the process-boundary details.

What gets assembled depends on the command:

| Command | Repository data included | Limits and redaction |
|---|---|---|
| `/gemini:rescue` | Your instruction text only | — |
| `/gemini:review`, `/gemini:adversarial-review` | `git status`, staged and unstaged diffs or a branch diff, and the contents of untracked files (`scripts/lib/git.mjs`) | Secret-file contents withheld; 400,000-character total cap; untracked files skipped above 24 KB, and skipped entirely if binary, a directory, or a broken symlink |
| `/gemini:transfer` | `git status -s` plus a per-file diff (`scripts/lib/transfer-context.mjs`) | Secret-file contents withheld; 5,000 characters per file; 25,000 characters total |

Truncation is announced **inside** the content that is sent, so the model reports
that it saw a partial diff rather than reviewing half a change silently.

**The table describes what the plugin assembles, not the ceiling on what Google
receives.** Gemini CLI and AGY are agentic: they run in your workspace directory
and can read files on their own initiative while working on the prompt. For
`/gemini:rescue` in particular, the plugin sends your instruction and nothing
else, but the CLI may then read whatever it judges relevant — including files no
redaction rule here ever saw. The limits and redaction above bound the plugin's
contribution; they do not sandbox the engine, and neither AGY nor Gemini CLI
offers a path-boundary mode the plugin could impose. This is documented as a
known, unmitigated gap in
[`docs/THREAT-MODEL.md` §7.2](docs/THREAT-MODEL.md). If a workspace contains
material that must not reach Google, do not run a delegated task in it.

### Secret-file redaction

Files whose names look like credential stores — `.env` and `.env.*`, `*.env`,
`*.pem`, `*.key`, `*.p12`/`*.pfx`/`*.crt`/`*.keystore`, `.npmrc`,
`credentials.json`, `*_creds.json`, `secret(s).json|yml|yaml|env`, anything
matching `id_rsa` — have their contents replaced with a placeholder before the
prompt is built. The diff header is kept, so the review still knows the file
changed. One definition covers both the review and transfer paths
(`scripts/lib/secrets.mjs`).

**Known limit, stated plainly:** detection is by filename only. A credential
pasted into an ordinary source file, hardcoded in a config, or embedded in a
test fixture is **not** redacted on any path. This is not a secret scanner, and
it has never been one. Treat the diff you are about to review as the thing you
are sending.

### The one automated send, and how it is gated

The optional Stop review gate (`scripts/stop-review-gate-hook.mjs`) can run an
adversarial review of your working tree without a fresh command from you. It
fires only when **both** conditions hold:

1. you enabled it explicitly (`stopReviewGateEnabled`, set through
   `/gemini:setup`; it defaults to off), **and**
2. a `--write` task has completed in this workspace.

Disable it the same way you enabled it. Nothing else in the plugin transmits
anything without a command you typed.

### Third parties

Whatever the Gemini CLI or AGY sends is then governed by Google's terms and
privacy policy for that product, including any retention or model-training
practices they apply to your plan tier. This project has no control over, and no
visibility into, what happens after the prompt reaches Google:

- Gemini CLI: <https://github.com/google-gemini/gemini-cli>
- Antigravity: <https://antigravity.google/>
- Google Privacy Policy: <https://policies.google.com/privacy>

Review those terms for your plan before sending proprietary code.

---

## 3. What is read from your machine

Beyond the workspace you invoke a command in, the plugin reads three things
outside it — all locally, none transmitted:

| Path | What is read | Why |
|---|---|---|
| `~/.gemini/oauth_creds.json` (or `$GEMINI_HOME`) | The token **expiry timestamp** only | To report Gemini auth status and to keep `auto` routing from selecting an unauthenticated CLI (`scripts/lib/gemini-auth.mjs`) |
| `~/.gemini/settings.json` | The `security.auth.selectedType` string only | To tell a personal plan from a Code Assist plan, which differ in CLI access (`scripts/lib/gemini-auth.mjs`) |
| `~/.gemini/antigravity-cli/brain/` or `~/.antigravity-cli/brain/` | AGY's own conversation transcript for the run it just started | Only on AGY older than 1.1.8, which has no structured stdout; newer AGY returns a JSON envelope and the transcript is not read (`scripts/lib/agy-transcript.mjs`, `scripts/lib/engine.mjs`) |

The token value itself is never logged, copied, or transmitted. `GEMINI_API_KEY`
and `GOOGLE_API_KEY` are checked for presence only; their values are never read
into a prompt.

### What the plugin does not touch

- Claude memory (`~/.claude/`, `CLAUDE.md`, `MEMORY.md`) — never read.
- Claude Code conversation history, transcripts, or summaries — never read.
- Files you uploaded to Claude — never read.
- Your credentials as values — see above.
- Any other home-directory content. The three paths in the table are the whole
  list.

---

## 4. What is stored locally, and where

Nothing is stored remotely. Two local locations, both prunable, both yours:

### Transfer snapshots

`<workspace>/.omc/transfers/transfer-*.json` — written by `/gemini:transfer`,
containing the workspace path, your instructions, `git status`, and the redacted
diff. The 20 most recent are kept; older ones are deleted on each new transfer
(`scripts/lib/transfer-context.mjs`). `.omc/` is in `.gitignore`, so snapshots
are not committed by accident.

### Job state and logs

`$GEMINI_COMPANION_DATA/state/<workspace-slug>-<hash>/`, or
`<system temp>/gemini-companion/<workspace-slug>-<hash>/` when that variable is
unset — containing `state.json`, `jobs/<id>.json`, and `jobs/<id>.log` for
background jobs. The 50 most recent jobs are kept; older records and their log
files are deleted together (`scripts/lib/state.mjs`). The directory name derives
from your workspace path so separate projects do not share state; ending a
Claude Code session removes that session's jobs
(`scripts/session-lifecycle-hook.mjs`).

Delete either directory at any time. The plugin recreates what it needs.

---

## 5. Changes to this document

New data collection, new transmission, new retention, or a new remote service is
a material change: it requires a threat-model review, a `SECURITY.md` update,
this document updated in the same pull request, and at minimum a MINOR version
bump. See [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).
