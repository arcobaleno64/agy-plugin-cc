import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { makeTempDir } from "./helpers.mjs";
import { readJobFile, resolveJobFile, saveState, setConfig, upsertJob, writeJobFile } from "../plugins/gemini/scripts/lib/state.mjs";
import { cancelJob } from "../plugins/gemini/scripts/gemini-companion.mjs";
import { buildStatusSnapshot, resolveResultJob } from "../plugins/gemini/scripts/lib/job-control.mjs";
import { runTrackedJob } from "../plugins/gemini/scripts/lib/tracked-jobs.mjs";

test("buildStatusSnapshot surfaces the stop-review-gate flag", () => {
  const cwd = makeTempDir();
  setConfig(cwd, "stopReviewGateEnabled", true);
  const snapshot = buildStatusSnapshot(cwd);
  assert.equal(snapshot.needsReview, true);
});

test("buildStatusSnapshot reports an empty job list for a fresh workspace", () => {
  const cwd = makeTempDir();
  const snapshot = buildStatusSnapshot(cwd);
  assert.equal(snapshot.needsReview, false);
  assert.deepEqual(snapshot.running, []);
  assert.equal(snapshot.latestFinished, null);
});

test("buildStatusSnapshot marks unreadable active job files as failed", () => {
  const cwd = makeTempDir();
  saveState(cwd, {
    version: 1,
    config: {},
    jobs: [
      {
        id: "task-corrupt",
        status: "running",
        pid: 123,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ]
  });
  fs.writeFileSync(resolveJobFile(cwd, "task-corrupt"), "{ not-json", "utf8");

  const snapshot = buildStatusSnapshot(cwd, { isPidAlive: () => true, all: true });

  assert.deepEqual(snapshot.running, []);
  assert.equal(snapshot.latestFinished.id, "task-corrupt");
  assert.equal(snapshot.latestFinished.status, "failed");
  assert.equal(snapshot.latestFinished.failure.category, "invalid-json");
});

test("buildStatusSnapshot marks active jobs failed when their pid is gone", () => {
  const cwd = makeTempDir();
  writeJobFile(cwd, "task-stale", { id: "task-stale", status: "running", pid: 123 });
  saveState(cwd, {
    version: 1,
    config: {},
    jobs: [
      {
        id: "task-stale",
        status: "running",
        pid: 123,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    ]
  });

  const snapshot = buildStatusSnapshot(cwd, { isPidAlive: () => false, all: true });

  assert.deepEqual(snapshot.running, []);
  assert.equal(snapshot.latestFinished.id, "task-stale");
  assert.equal(snapshot.latestFinished.status, "failed");
  assert.equal(snapshot.latestFinished.failure.category, "stale-job");
  assert.match(snapshot.latestFinished.failure.nextStep, /retry|result/i);
});

test("runTrackedJob persists structured failure metadata when the runner throws", async () => {
  const cwd = makeTempDir();

  await assert.rejects(
    runTrackedJob(
      {
        id: "task-failed",
        title: "Gemini Task",
        workspaceRoot: cwd,
        jobClass: "task"
      },
      () => {
        throw new Error("429 Too Many Requests: rate limit exceeded");
      }
    )
  );

  const snapshot = buildStatusSnapshot(cwd, { all: true });
  const stored = readJobFile(resolveJobFile(cwd, "task-failed"));

  assert.equal(snapshot.latestFinished.failure.category, "rate-limit");
  assert.equal(snapshot.latestFinished.failure.retryable, true);
  assert.equal(stored.failure.category, "rate-limit");
});

// A cut-off run that produced text is a third terminal state. These pin the
// mapping and, more importantly, that /gemini:result can still read it back —
// the state exists so a user is not told to re-buy an answer they already have,
// which fails if the answer becomes unreachable.
test("runTrackedJob stores a cut-off run that produced text as partial", async () => {
  const cwd = makeTempDir();
  await runTrackedJob(
    { id: "task-partial", title: "Gemini Task", workspaceRoot: cwd, jobClass: "task" },
    () => ({
      exitStatus: 1,
      partial: true,
      payload: { rawOutput: "the whole deliverable" },
      rendered: "the whole deliverable",
      summary: "done-ish",
      failure: { category: "timeout", retryable: true, summary: "cut off", nextStep: "Read it first." }
    })
  );

  const stored = readJobFile(resolveJobFile(cwd, "task-partial"));
  assert.equal(stored.status, "partial");
  assert.equal(stored.phase, "partial");
  assert.equal(stored.failure.nextStep, "Read it first.", "the failure is where the next step lives");
});

test("a partial job is retrievable through the same path as a completed one", async () => {
  const cwd = makeTempDir();
  await runTrackedJob(
    { id: "task-partial-read", title: "Gemini Task", workspaceRoot: cwd, jobClass: "task" },
    () => ({ exitStatus: 1, partial: true, payload: { rawOutput: "text" }, rendered: "text", summary: "s" })
  );

  const { job } = resolveResultJob(cwd, "task-partial-read", { all: true });
  assert.equal(job.id, "task-partial-read");
  assert.equal(job.status, "partial");
});

test("a successful run is completed even if the runner also set partial", async () => {
  const cwd = makeTempDir();
  await runTrackedJob(
    { id: "task-zero", title: "Gemini Task", workspaceRoot: cwd, jobClass: "task" },
    () => ({ exitStatus: 0, partial: true, payload: { rawOutput: "ok" }, rendered: "ok", summary: "s" })
  );

  const stored = readJobFile(resolveJobFile(cwd, "task-zero"));
  assert.equal(stored.status, "completed");
  assert.equal(stored.failure ?? null, null);
});

// ---------------------------------------------------------------------------
// `/gemini:cancel <groupId>` used to answer "No active job found": status and
// result both accept a groupId and aggregate, and cancel alone matched job ids,
// so an adversarial-review group had to be cancelled one engine at a time from
// ids the user had to go and read out of a status listing.
// ---------------------------------------------------------------------------

function seedGroup(cwd, groupId, members) {
  for (const member of members) {
    const record = { jobClass: "review", title: "Adversarial Review", groupId, ...member };
    upsertJob(cwd, record);
    writeJobFile(cwd, record.id, record);
  }
}

function stubTerminate() {
  const killed = [];
  const fn = (pid) => {
    killed.push(pid);
    return { attempted: true, delivered: true, method: "taskkill" };
  };
  fn.killed = killed;
  return fn;
}

test("cancelling a group cancels every active member", () => {
  const cwd = makeTempDir();
  seedGroup(cwd, "review-group-1", [
    { id: "review-agy", status: "running", pid: 4001, engine: "agy" },
    { id: "review-gemini", status: "running", pid: 4002, engine: "gemini" }
  ]);

  const terminateProcessTreeFn = stubTerminate();
  const result = cancelJob({ cwd, jobId: "review-group-1", all: true }, { terminateProcessTreeFn });

  assert.equal(result.groupId, "review-group-1");
  assert.deepEqual(terminateProcessTreeFn.killed.sort(), [4001, 4002]);
  for (const id of ["review-agy", "review-gemini"]) {
    assert.equal(readJobFile(resolveJobFile(cwd, id)).status, "cancelled", `${id} was left running`);
  }
});

test("a group cancel leaves members that already finished alone", () => {
  const cwd = makeTempDir();
  seedGroup(cwd, "review-group-2", [
    { id: "review-done", status: "completed", pid: null, engine: "agy" },
    { id: "review-live", status: "running", pid: 4003, engine: "gemini" }
  ]);

  const terminateProcessTreeFn = stubTerminate();
  const result = cancelJob({ cwd, jobId: "review-group-2", all: true }, { terminateProcessTreeFn });

  assert.deepEqual(result.payload.cancelled.map((entry) => entry.jobId), ["review-live"]);
  assert.equal(readJobFile(resolveJobFile(cwd, "review-done")).status, "completed", "a finished job is not re-labelled");
});

test("cancelling one job of a group by its own id still cancels only that one", () => {
  const cwd = makeTempDir();
  seedGroup(cwd, "review-group-3", [
    { id: "review-first", status: "running", pid: 4004, engine: "agy" },
    { id: "review-second", status: "running", pid: 4005, engine: "gemini" }
  ]);

  const terminateProcessTreeFn = stubTerminate();
  const result = cancelJob({ cwd, jobId: "review-first", all: true }, { terminateProcessTreeFn });

  // The single-job shape is what every existing caller reads — the slash
  // command, the MCP tool, and renderCancelReport.
  assert.equal(result.groupId ?? null, null);
  assert.equal(result.payload.jobId, "review-first");
  assert.deepEqual(terminateProcessTreeFn.killed, [4004]);
  assert.equal(readJobFile(resolveJobFile(cwd, "review-second")).status, "running", "its group peer was cancelled too");
});

test("a groupId whose members have all finished says so instead of \"no job found\"", () => {
  const cwd = makeTempDir();
  seedGroup(cwd, "review-group-4", [
    { id: "review-old-a", status: "completed", pid: null },
    { id: "review-old-b", status: "failed", pid: null }
  ]);

  assert.throws(
    () => cancelJob({ cwd, jobId: "review-group-4", all: true }, { terminateProcessTreeFn: stubTerminate() }),
    /group review-group-4 has no active jobs \(2 already finished\)/,
    "the group exists; saying it was not found sends the user after an id they gave correctly"
  );
});
