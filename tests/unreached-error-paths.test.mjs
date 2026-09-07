// The error paths the suite never executed.
//
// Found by running the whole suite under NODE_V8_COVERAGE — which catches the
// spawned CLI runs too — and asking which `throw` sites no process ever reached.
// 19 of them, on top of the 30 messages no test named. An unexecuted error path
// is either dead code or a state a user can reach that nothing has ever
// checked, and the two are indistinguishable until someone tries to reach it.
//
// Each test below is that attempt. Where reaching the state proved impossible,
// the code was deleted instead (see the positional prompt path in 0.25.0).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildEnvUnavailable, buildEnv, installFakeGemini, installUnavailableEngines } from "./fake-gemini-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { upsertJob, resolveJobFile } from "../plugins/gemini/scripts/lib/state.mjs";
import {
  buildSingleJobSnapshot,
  resolveCancelableJob,
  resolveResultJobs
} from "../plugins/gemini/scripts/lib/job-control.mjs";

const NOW = "2026-09-03T00:00:00.000Z";

// Jobs live as one file each; `listJobs` scans the directory rather than reading
// an array out of state.json. A fixture that writes the state array instead
// leaves an empty store, and then every assertion here passes or fails for the
// wrong reason — which is how the first draft of this file "passed".
function workspaceWith(jobs) {
  const cwd = makeTempDir();
  for (const entry of jobs) upsertJob(cwd, entry);
  return cwd;
}

// Every resolver scopes to the current Claude session by default, and these
// fixtures belong to no session, so each call passes { all: true } — the same
// flag a user reaches for when the job was started from another session.
const ANY_SESSION = { all: true };

function job(id, status, extra = {}) {
  return { id, status, createdAt: NOW, updatedAt: NOW, kind: "task", ...extra };
}

// ---------------------------------------------------------------------------
// job-control: reference resolution
// ---------------------------------------------------------------------------

// Job ids share a `task-` prefix by construction, so a user who types a few
// characters gets several matches. Answering with "the newest one" would run the
// wrong job; answering "not found" would be a lie.
test("an ambiguous job prefix is refused rather than guessed", () => {
  const cwd = workspaceWith([job("task-abc111", "completed"), job("task-abc222", "completed")]);

  assert.throws(
    () => buildSingleJobSnapshot(cwd, "task-abc", ANY_SESSION),
    /ambiguous.*longer job id/i
  );
});

// One character more resolves it, which is what the refusal above promises.
test("a prefix that matches one job still resolves", () => {
  const cwd = workspaceWith([job("task-abc111", "completed"), job("task-abd222", "completed")]);

  assert.equal(buildSingleJobSnapshot(cwd, "task-abc", ANY_SESSION).job.id, "task-abc111");
});

test("an unknown job reference names the command that lists them", () => {
  const cwd = workspaceWith([job("task-real", "completed")]);

  assert.throws(() => buildSingleJobSnapshot(cwd, "task-imaginary", ANY_SESSION), /No job found for "task-imaginary"/);
  assert.throws(() => buildSingleJobSnapshot(cwd, "task-imaginary", ANY_SESSION), /\/gemini:status/);
});

// `/gemini:status` with no argument and an empty store reaches a second,
// separately worded "no job found" — the one inside buildSingleJobSnapshot
// rather than the one in matchJobReference. Never executed, and wrong: it
// interpolated the missing reference and said `No job found for "undefined"`.
test("asking for a job in an empty workspace is a clean refusal, not a crash", () => {
  const cwd = workspaceWith([]);

  assert.throws(() => buildSingleJobSnapshot(cwd, undefined, ANY_SESSION), (error) => {
    assert.match(error.message, /No Gemini jobs found in this workspace yet/);
    assert.doesNotMatch(error.message, /undefined/, "the message must not quote a reference the user never gave");
    return true;
  });
});

// Unlike result and cancel, this path does not scope by session — it searches
// every job in the workspace — so the refusal must not offer `--all` as a way to
// see more. Pinning that keeps a well-meant "be consistent" edit from adding
// advice for a problem the user does not have.
test("the empty-workspace refusal offers no flag it cannot honour", () => {
  const cwd = workspaceWith([job("task-elsewhere", "completed", { sessionId: "another-session" })]);

  // The other session's job is visible here, which is exactly why there is
  // nothing for `--all` to widen.
  assert.equal(buildSingleJobSnapshot(cwd, undefined).job.id, "task-elsewhere");
  assert.throws(() => buildSingleJobSnapshot(makeTempDir(), undefined), (error) => {
    assert.doesNotMatch(error.message, /--all/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// job-control: cancel
// ---------------------------------------------------------------------------

// Cancelling without a reference is only unambiguous when one job is active.
// With two, picking one silently would stop work the user did not name.
test("cancel refuses to choose between two active jobs", () => {
  const cwd = workspaceWith([job("task-one", "running", { pid: 1 }), job("task-two", "running", { pid: 2 })]);

  assert.throws(
    () => resolveCancelableJob(cwd, null, ANY_SESSION),
    /Multiple Gemini jobs are active.*\/gemini:cancel/s
  );
});

test("cancel with nothing running says so instead of failing obscurely", () => {
  const cwd = workspaceWith([job("task-done", "completed")]);

  assert.throws(() => resolveCancelableJob(cwd, null, ANY_SESSION), /No active Gemini jobs to cancel/);
});

// ---------------------------------------------------------------------------
// job-control: result
// ---------------------------------------------------------------------------

// A review dispatched to several engines is one group. Reading it while a member
// is still running would hand back a partial answer as if it were the whole one.
test("reading a review group that is still running names the job to wait for", () => {
  const groupId = "group-xyz";
  const cwd = workspaceWith([
    job("review-a", "completed", { kind: "review", groupId }),
    job("review-b", "running", { kind: "review", groupId, pid: 4242 })
  ]);

  assert.throws(
    () => resolveResultJobs(cwd, groupId, { all: true, isPidAlive: () => true }),
    (error) => {
      assert.match(error.message, /still running/);
      assert.match(error.message, /review-b/, "the job still to finish is named");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// The command line
//
// These refusals answer a user who typed two things that contradict each other,
// or left out the one thing required. Every one of them was live and unexecuted:
// the suite drives the companion through its exported functions, which skips the
// argument handling entirely. Spawned, because that is the only way to reach it.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "gemini", "scripts", "gemini-companion.mjs");

function cliWorkspace() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeGemini(binDir, "task");
  initGitRepo(repo);
  return { repo, env: buildEnv(binDir) };
}

function refuses(argv, pattern) {
  const { repo, env } = cliWorkspace();
  const result = run("node", [SCRIPT, ...argv], { cwd: repo, env });
  assert.notEqual(result.status, 0, `expected a refusal, got exit 0 for: ${argv.join(" ")}`);
  assert.match(result.stderr, pattern);
  return result;
}

// Two entry points guard the same condition with different words, and the
// difference is real: the foreground path has already consumed stdin and a
// prompt file by the time it checks, while the background dispatcher is handed a
// request object and can still name every way one could have been supplied.
test("a task with neither a prompt nor a resume is refused at both entry points", () => {
  refuses(["task"], /Provide a prompt or use --resume-last/);
  refuses(["task", "--background"], /Provide a prompt, a prompt file, piped stdin, or use --resume-last/);
});

test("adversarial-review focus given twice is refused rather than one silently winning", () => {
  refuses(
    ["adversarial-review", "--scope", "working-tree", "--focus-file", "notes.md", "look", "at", "the", "parser"],
    /either as --focus-file or as positional text, not both/
  );
});

test("an unreadable --focus-file names the file and what the filesystem said", () => {
  const result = refuses(
    ["adversarial-review", "--scope", "working-tree", "--focus-file", "no-such-file.md"],
    /Could not read --focus-file "no-such-file\.md"/
  );
  assert.match(result.stderr, /ENOENT|no such file/i, "the underlying reason is passed through, not swallowed");
});

test("--engine and --engines together are refused, not merged", () => {
  refuses(
    ["adversarial-review", "--engine", "gemini", "--engines", "gemini,agy"],
    /Choose either --engine or --engines, not both/
  );
});

// --engines dispatches background jobs, so there is no foreground run for --wait
// to wait on. Accepting both would return immediately and look like a fast run.
test("--engines with --wait is refused, because there is nothing to wait on", () => {
  refuses(
    ["adversarial-review", "--engines", "gemini,agy", "--wait"],
    /--engines dispatches background jobs and cannot be combined with --wait/
  );
});

test("resuming and starting fresh at once is refused", () => {
  refuses(["task", "--resume-last", "--fresh", "carry on"], /Choose either --resume\/--resume-last or --fresh/);
});

test("an unknown subcommand names itself", () => {
  refuses(["summarise-everything"], /Unknown subcommand: summarise-everything/);
});

// The worker subcommands are spawned by the plugin, never typed — but they are
// on the same command line, and a user (or a stale job file) can reach them.
test("a worker without --job-id says which argument is missing", () => {
  refuses(["task-worker"], /Missing required --job-id/);
});

test("a worker pointed at a job that is not stored says so", () => {
  refuses(["task-worker", "--job-id", "task-does-not-exist"], /No stored job found for task-does-not-exist/);
});

// Resuming picks up the newest task in this session, so an active one is not a
// candidate — continuing a conversation that is still being written would
// interleave two turns. Session-scoped, so the fixture has to claim a session.
test("resuming while a task is still running is refused, naming that task", () => {
  const { repo, env } = cliWorkspace();
  const sessionId = "session-under-test";
  upsertJob(repo, {
    id: "task-busy",
    status: "running",
    jobClass: "task",
    kind: "task",
    pid: process.pid,
    sessionId,
    createdAt: NOW,
    updatedAt: NOW
  });

  const result = run("node", [SCRIPT, "task", "--resume-last", "keep going"], {
    cwd: repo,
    env: { ...env, GEMINI_COMPANION_SESSION_ID: sessionId }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Task task-busy is still running/);
  assert.match(result.stderr, /\/gemini:status/);
});

// Every engine failing to resolve is a different report from one engine failing:
// the user asked for a set, and the answer has to say what went wrong with each
// rather than name only the last one tried.
test("a review whose every engine is unavailable reports each engine's reason", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installUnavailableEngines(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "adversarial-review", "--scope", "working-tree", "--engines", "gemini,agy"], {
    cwd: repo,
    env: buildEnvUnavailable(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /None of the requested review engines are available/);
  assert.match(result.stderr, /gemini \(/, "the gemini failure is named");
  assert.match(result.stderr, /agy \(/, "and so is the agy one");
});

// A job file that lost its request payload is a corrupt store, not a missing
// job, and the worker has to say which — "no stored job found" would send the
// user looking for something that is plainly there.
test("a stored job without its request payload is reported as corrupt, not missing", () => {
  const { repo, env } = cliWorkspace();
  upsertJob(repo, { id: "task-hollow", status: "queued", jobClass: "task", kind: "task", createdAt: NOW, updatedAt: NOW });
  const jobFile = resolveJobFile(repo, "task-hollow");
  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  delete stored.request;
  fs.writeFileSync(jobFile, JSON.stringify(stored), "utf8");

  const result = run("node", [SCRIPT, "task-worker", "--job-id", "task-hollow"], { cwd: repo, env });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Stored job task-hollow is missing its request payload/);
});

// Knowingly untested: readonly-guard.mjs's "Workspace path changed while it was
// being inspected". It fires when a path is replaced between the fstat of an
// open descriptor and a fresh lstat of the same name — a real TOCTOU detector
// with no injection seam to drive it, so provoking it means winning a race
// inside one function. Recorded here rather than covered by a test that would
// only pretend to reach it.
