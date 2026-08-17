import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { createJobProgressUpdater, createProgressReporter } from "../plugins/gemini/scripts/lib/tracked-jobs.mjs";
import { resolveJobFile, readJobFile, upsertJob, writeJobFile } from "../plugins/gemini/scripts/lib/state.mjs";

// createJobProgressUpdater writes the fields /gemini:status reads back — phase,
// and the thread and turn ids used to build the `gemini --resume` line a user
// copies.
//
// These cover behaviour a user could observe going wrong: a stale resume
// command, a thread id lost when only the turn changed, a worker throwing
// because its job record was swept while it was still running. The updater also
// skips writing when nothing changed; that branch is deliberately *not* pinned
// here, because the only way to observe it is file mtime — flaky within a
// millisecond, and a test of an optimisation rather than of a promise. Reaching
// it would raise the branch percentage and protect nothing.

function withDataDir(body) {
  const dir = makeTempDir("gemini-tracked-");
  const names = ["GEMINI_COMPANION_DATA", "CLAUDE_PLUGIN_DATA"];
  const previous = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  process.env.GEMINI_COMPANION_DATA = dir;
  delete process.env.CLAUDE_PLUGIN_DATA;
  try {
    return body(dir);
  } finally {
    for (const n of names) {
      if (previous[n] == null) delete process.env[n];
      else process.env[n] = previous[n];
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

function seedJob(cwd, id) {
  upsertJob(cwd, { id, status: "running", title: "T", jobClass: "task" });
  writeJobFile(cwd, id, { id, status: "running", title: "T", jobClass: "task" });
  return resolveJobFile(cwd, id);
}

test("a changed thread id replaces the old one rather than being ignored", () => {
  withDataDir((cwd) => {
    const file = seedJob(cwd, "task-thread-2");
    const update = createJobProgressUpdater(cwd, "task-thread-2");

    update({ message: "first", threadId: "thr_1" });
    update({ message: "resumed", threadId: "thr_2" });
    assert.equal(readJobFile(file).threadId, "thr_2", "the status line would print a stale resume command");
  });
});

// Which engine a run chose was written only when the job finished, so a running
// job could not answer it — and a background task never carried it at queue time
// either, while a background review did, which is how the asymmetry was found.
// Under `auto` this is the field that says whose quota is being spent.
test("a running job reports the engine its run resolved", () => {
  withDataDir((cwd) => {
    const file = seedJob(cwd, "task-engine-1");
    const update = createJobProgressUpdater(cwd, "task-engine-1");

    update({ message: "Detecting engine...", phase: "starting" });
    assert.equal(readJobFile(file).engine, undefined, "nothing is known before detection returns");

    update({ message: "Starting agy turn...", phase: "running", engine: "agy" });
    assert.equal(readJobFile(file).engine, "agy", "a running job must name the engine it is spending quota on");
  });
});

test("turn id is tracked independently of thread id", () => {
  withDataDir((cwd) => {
    const file = seedJob(cwd, "task-turn-1");
    const update = createJobProgressUpdater(cwd, "task-turn-1");

    update({ message: "a", threadId: "thr_1", turnId: "turn_1" });
    update({ message: "b", turnId: "turn_2" });

    const stored = readJobFile(file);
    assert.equal(stored.turnId, "turn_2");
    assert.equal(stored.threadId, "thr_1", "the thread id was dropped when only the turn changed");
  });
});

// The job file can be gone — a session-end sweep, or a pruned record — while the
// worker is still reporting. That must not throw and must not recreate the file.
test("an update for a job whose file has vanished is dropped quietly", () => {
  withDataDir((cwd) => {
    const file = seedJob(cwd, "task-gone-1");
    const update = createJobProgressUpdater(cwd, "task-gone-1");
    fs.rmSync(file, { force: true });

    assert.doesNotThrow(() => update({ message: "still running", phase: "running" }));
    assert.equal(fs.existsSync(file), false, "a deleted job record was resurrected");
  });
});

// createProgressReporter returns null when it has nowhere to report, so callers
// can use `progress?.()` without branching on configuration.
test("a reporter with no destination is null rather than a no-op function", () => {
  assert.equal(createProgressReporter(), null);
  assert.equal(createProgressReporter({}), null);
  assert.equal(typeof createProgressReporter({ onEvent: () => {} }), "function");
});

test("a reporter forwards the normalized event to onEvent", () => {
  const seen = [];
  const report = createProgressReporter({ onEvent: (e) => seen.push(e) });

  report({ message: "  spaced  ", phase: " running ", threadId: "" });
  report("bare string");

  assert.equal(seen[0].message, "spaced");
  assert.equal(seen[0].phase, "running");
  assert.equal(seen[0].threadId, null, "an empty thread id must not be recorded as one");
  assert.equal(seen[1].message, "bare string");
  assert.equal(seen[1].phase, null);
});
