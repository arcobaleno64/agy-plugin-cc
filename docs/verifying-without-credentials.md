# Verifying this plugin without credentials

Everything in this document runs offline, with no Google account, no OAuth flow,
and no API key. It exists so a reviewer can check the plugin's claims without
being handed anyone's credentials — which will never happen, no matter who asks.

Requirements: Node.js 18 or newer, `git` on `PATH`. Nothing else.

---

## 1. The full gate, offline

```bash
npm ci
npm test
npm run check-version
npm run verify-contracts
```

`npm test` spawns no engine. Where a test needs the CLI to answer, it injects a
stand-in through the `runCommandFn` / `detectEngineFn` seams, or spawns a copied
`node` binary that plays the part. Tests that genuinely cannot run on the current
platform call `t.skip()` with the reason printed, rather than passing silently.

`npm run verify-contracts` is offline by construction — it reads the manifests,
the README install command, and the command files from disk.

Add the manifest schema check if you have the Claude Code CLI:

```bash
claude plugin validate ./plugins/gemini --strict
claude plugin validate . --strict
```

Both work with no login. CI proves it: the `ci` job installs the CLI into a
fresh runner with no credential of any kind and both commands exit 0.

---

## 2. The benchmark, replayed from cassettes

```bash
npm run bench
```

This replays recorded engine responses from `bench/cassettes/` and scores them
against the planted defects in `bench/corpus/*/ground-truth.json`. No network,
no auth.

Read `bench/README.md` before quoting a number from it. The provenance of every
cassette is stated there, including which cells are **seeded** rather than
live-recorded, and why. A seeded cell is a fixture, not a measurement.

---

## 3. A disposable repository to point commands at

```bash
node scripts/make-sample-repo.mjs --list
node scripts/make-sample-repo.mjs --case auth-basic
```

This builds a throwaway git repository in your system temp directory from a
corpus case: the `base/` tree as a commit, the `head/` tree over it as
working-tree changes. It prints the path, the defects planted in it, and the
`rm -rf` to undo it. Nothing is written outside that directory.

Use it when you want to exercise a command for real without pointing it at code
you care about — in particular a `--write` run, which is write-capable and has no
path sandbox (see [`THREAT-MODEL.md` §7.2](THREAT-MODEL.md)).

Running a command against it does require an authenticated engine. The
repository is the credential-free part; the engine call is not. Section 4 closes
that gap.

---

## 4. Every command, run end to end, with no engine

```bash
node scripts/reviewer-demo.mjs --list    # the steps, without running them
node scripts/reviewer-demo.mjs           # run them
node scripts/reviewer-demo.mjs --keep    # ... and leave the workspace to inspect
```

This is the answer to "provide a standard testing account with sample data for
Anthropic to verify full Software functionality" (Anthropic Software Directory
Policy 3.D). **This plugin issues no accounts.** It is a bridge to a Gemini CLI
or AGY binary that you install and authenticate yourself, with credentials
Google issues — and consumer CLI access ended on 2026-06-18. There is no account
to hand over, so what is offered instead is a run of every command.

It builds a disposable workspace, puts a stand-in engine on `PATH`, and drives
the real commands through their real code paths:

| Step | What it demonstrates |
|---|---|
| `setup` | engine detection, version probe, credential check |
| `task` | foreground delegation, prompt on stdin, read-only default |
| `task --background`, `status`, `result` | the job lifecycle end to end |
| `review` | working-tree diff sent, structured findings parsed back out |
| `adversarial-review` | the same diff with the adversarial prompt and focus text |
| `cancel` | terminating a live process tree, job recorded as cancelled |
| `transfer` | context export, with a planted `.env` withheld |

The stand-in is `tests/fixtures/fake-gemini.cjs` — the same fixture the test
suite uses, reused rather than reimplemented so it cannot drift into describing
behavior the tests do not check. It speaks the real CLI's contract: a version
line on `--version`, and a `{ session_id, response }` JSON envelope with the
prompt arriving on stdin.

**What this proves and what it does not.** The plugin's behavior is real:
argv construction, engine detection, stdin transport, envelope parsing, job
state, rendering, and secret redaction all execute normally. The *text* the
engine returns is canned, and the script says so at the top and at every step.
It cannot tell you anything about model quality, real authentication, quota, or
how a live agentic engine behaves once loose in a workspace.

The redaction step is checkable rather than asserted: run with `--keep`, then
grep the snapshot under `sample-repo/.omc/transfers/` for
`demo-secret-value-do-not-send`. The file is listed as changed; its contents are
not there. `tests/reviewer-demo.test.mjs` makes the same check against the files
on disk, including the job logs, so the claim cannot rot silently.

Nothing is written outside the temp workspace, and it is removed on exit unless
you pass `--keep`.

---

## 5. What needs credentials, and what that buys

| Step | Needs auth | What it adds |
|---|---|---|
| `npm test`, `verify-contracts`, `check-version` | no | every contract and regression assertion |
| `claude plugin validate` | no | manifest schema conformance |
| `npm run bench` | no | scoring against planted defects, replayed |
| `node scripts/reviewer-demo.mjs` | no | every command run end to end against a stand-in engine |
| `npm run bench:live` | **yes** | re-records cassettes from real engine runs |
| `/gemini:review`, `/gemini:rescue`, `/gemini:transfer` end to end | **yes** | an actual delegated run |

To authenticate for the live paths, use **your own** account: run `gemini` once
for the Gemini engine, or `agy` once for AGY. Note that Google ended consumer
Gemini CLI access on 2026-06-18, so a personal account authenticates but every
request fails — AGY is the practical engine for a live check.

`npm run bench:live` overwrites the committed cassettes. Run it on a branch, and
follow the honesty rules in `bench/README.md`: never present a seeded cell as a
measured one, and never merge live and replayed numbers into a single figure.
