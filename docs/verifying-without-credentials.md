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
repository is the credential-free part; the engine call is not.

---

## 4. What needs credentials, and what that buys

| Step | Needs auth | What it adds |
|---|---|---|
| `npm test`, `verify-contracts`, `check-version` | no | every contract and regression assertion |
| `claude plugin validate` | no | manifest schema conformance |
| `npm run bench` | no | scoring against planted defects, replayed |
| `npm run bench:live` | **yes** | re-records cassettes from real engine runs |
| `/gemini:review`, `/gemini:rescue`, `/gemini:transfer` end to end | **yes** | an actual delegated run |

To authenticate for the live paths, use **your own** account: run `gemini` once
for the Gemini engine, or `agy` once for AGY. Note that Google ended consumer
Gemini CLI access on 2026-06-18, so a personal account authenticates but every
request fails — AGY is the practical engine for a live check.

`npm run bench:live` overwrites the committed cassettes. Run it on a branch, and
follow the honesty rules in `bench/README.md`: never present a seeded cell as a
measured one, and never merge live and replayed numbers into a single figure.
