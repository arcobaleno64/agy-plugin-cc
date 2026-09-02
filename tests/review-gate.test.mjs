import test from "node:test";
import assert from "node:assert/strict";

import { buildBlockReason } from "../plugins/gemini/scripts/stop-review-gate-hook.mjs";

// ---------------------------------------------------------------------------
// The block reason is the only part of a gated review the user reads. Everything
// the review produced is retrievable via /gemini:result, but nothing tells them
// to look there, so whatever this string omits is effectively lost.
// ---------------------------------------------------------------------------

const TRUNCATION = {
  truncated: true,
  truncatedFiles: ["src/big.ts"],
  omittedFiles: ["src/dropped.ts"]
};

// The defect this pins: the truncation branch returned early, before the summary
// was used. A truncated review that found three real problems reported only
// which files went unread — the findings were never shown.
test("a truncated review still reports what it found", () => {
  const reason = buildBlockReason({
    result: {
      verdict: "needs-attention",
      summary: "Unvalidated user input reaches the query builder.",
      findings: [{}, {}, {}]
    },
    truncation: TRUNCATION
  });

  assert.match(reason, /Unvalidated user input reaches the query builder\./);
  assert.match(reason, /3 findings/);
  assert.match(reason, /too large to review in full/);
  assert.match(reason, /src\/dropped\.ts/);
});

// The case the truncation branch was written for, which must keep working:
// no findings, blocked anyway, and the user needs to know why.
test("a truncated review with no findings explains the block", () => {
  const reason = buildBlockReason({
    result: { verdict: "needs-attention", summary: "", findings: [] },
    truncation: TRUNCATION
  });

  assert.match(reason, /too large to review in full/);
  assert.match(reason, /src\/big\.ts/);
  assert.match(reason, /src\/dropped\.ts/);
});

test("an untruncated review reports the summary and the count", () => {
  const reason = buildBlockReason({
    result: { verdict: "needs-attention", summary: "Race in the job writer.", findings: [{}] }
  });

  assert.match(reason, /Race in the job writer\./);
  assert.match(reason, /1 finding\b/);
  assert.doesNotMatch(reason, /too large to review in full/);
});

// ---------------------------------------------------------------------------
// Which jobs arm the gate. The question is "did a write task finish", not "did
// it succeed": a --write turn cut off partway through has still edited the
// working tree, and those are exactly the edits nobody reviewed. Adding the
// `partial` status without adding it here would have quietly opened a hole that
// did not exist before it.
// ---------------------------------------------------------------------------

import { hasCompletedWriteTask, pendingGateWriteTasks } from "../plugins/gemini/scripts/stop-review-gate-hook.mjs";

const writeTask = (status) => ({ write: true, status, jobClass: "task" });

test("a completed write task arms the gate", () => {
  assert.equal(hasCompletedWriteTask([writeTask("completed")]), true);
});

test("a partial write task arms the gate — its edits are in the tree either way", () => {
  assert.equal(hasCompletedWriteTask([writeTask("partial")]), true);
});

test("a running or failed write task does not arm the gate", () => {
  assert.equal(hasCompletedWriteTask([writeTask("running")]), false);
  assert.equal(hasCompletedWriteTask([writeTask("failed")]), false);
});

test("a partial job that is not a write task leaves the gate alone", () => {
  assert.equal(hasCompletedWriteTask([{ write: false, status: "partial", jobClass: "task" }]), false);
  assert.equal(hasCompletedWriteTask([{ write: true, status: "partial", jobClass: "review" }]), false);
});

// ---------------------------------------------------------------------------
// Consuming the trigger. The gate reads the whole workspace job store on
// purpose (an MCP-queued write task carries no session id, so a session-scoped
// predicate would leave those edits ungated) — but without a consumption mark
// that same job re-arms the gate on EVERY turn forever, because SessionEnd only
// evicts jobs that carry a session id. These pin the mark, not the scope.
// ---------------------------------------------------------------------------

const stamped = (status, { completedAt, gateReviewedAt }) => ({
  id: "task-1",
  write: true,
  status,
  jobClass: "task",
  completedAt,
  gateReviewedAt
});

test("a write task already reviewed by the gate does not arm it again", () => {
  const job = stamped("completed", {
    completedAt: "2026-09-02T00:00:00.000Z",
    gateReviewedAt: "2026-09-02T00:00:05.000Z"
  });
  assert.equal(hasCompletedWriteTask([job]), false);
  assert.deepEqual(pendingGateWriteTasks([job]), []);
});

test("a write task that finished again after its review re-arms the gate", () => {
  const job = stamped("completed", {
    completedAt: "2026-09-02T00:10:00.000Z",
    gateReviewedAt: "2026-09-02T00:00:05.000Z"
  });
  assert.equal(hasCompletedWriteTask([job]), true);
});

test("an unreviewed write task still arms the gate", () => {
  const job = stamped("completed", { completedAt: "2026-09-02T00:00:00.000Z", gateReviewedAt: undefined });
  assert.equal(hasCompletedWriteTask([job]), true);
  assert.equal(pendingGateWriteTasks([job]).length, 1);
});

test("pendingGateWriteTasks returns only the jobs that still need reviewing", () => {
  const reviewed = { ...stamped("completed", { completedAt: "2026-09-02T00:00:00.000Z", gateReviewedAt: "2026-09-02T00:00:01.000Z" }), id: "task-reviewed" };
  const fresh = { ...stamped("partial", { completedAt: "2026-09-02T00:05:00.000Z", gateReviewedAt: undefined }), id: "task-fresh" };
  assert.deepEqual(pendingGateWriteTasks([reviewed, fresh]).map((j) => j.id), ["task-fresh"]);
});

// ---------------------------------------------------------------------------
// Through the REAL write path. The literal-object tests above pin the intended
// semantics; this one pins what actually happens on disk, and it is the test
// that catches the version of this fix that compared the mark against
// `updatedAt`: upsertJob stamps `updatedAt` with its own nowIso() on every
// write, so the call that records the mark moves the field it was compared
// against, and the gate re-armed on every turn exactly as before the fix.
// ---------------------------------------------------------------------------

import { makeTempDir } from "./helpers.mjs";
import { listJobs, upsertJob } from "../plugins/gemini/scripts/lib/state.mjs";

test("the mark survives its own write: a marked job stays consumed on re-read", () => {
  const cwd = makeTempDir();
  upsertJob(cwd, {
    id: "task-write-1",
    write: true,
    jobClass: "task",
    status: "completed",
    completedAt: "2026-09-02T00:00:00.000Z"
  });

  assert.equal(hasCompletedWriteTask(listJobs(cwd)), true, "arms the gate before it is reviewed");

  // Exactly what markGateReviewed does: stamp taken before the write, so the
  // write's own updatedAt lands after it.
  upsertJob(cwd, { id: "task-write-1", gateReviewedAt: new Date().toISOString() });

  assert.equal(
    hasCompletedWriteTask(listJobs(cwd)),
    false,
    "a job the gate has already reviewed must not arm it again on the next turn"
  );
});

test("a marked job that finishes again re-arms the gate through the real store", () => {
  const cwd = makeTempDir();
  upsertJob(cwd, {
    id: "task-write-2",
    write: true,
    jobClass: "task",
    status: "completed",
    completedAt: "2026-09-02T00:00:00.000Z"
  });
  upsertJob(cwd, { id: "task-write-2", gateReviewedAt: "2026-09-02T00:00:01.000Z" });
  assert.equal(hasCompletedWriteTask(listJobs(cwd)), false);

  upsertJob(cwd, { id: "task-write-2", completedAt: "2026-09-02T01:00:00.000Z" });
  assert.equal(hasCompletedWriteTask(listJobs(cwd)), true, "new edits, new review");
});

test("the review mark does not reorder the job store's eviction queue", () => {
  const cwd = makeTempDir();
  // An OLD write task, and a NEWER unrelated job. listJobs sorts by updatedAt
  // descending and pruneJobStore evicts from the tail, so if marking the old job
  // moves it to the head, the newer job is the one that gets evicted.
  upsertJob(cwd, {
    id: "task-old",
    write: true,
    jobClass: "task",
    status: "completed",
    completedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });
  upsertJob(cwd, { id: "task-new", jobClass: "task", status: "completed", updatedAt: "2026-09-01T00:00:00.000Z" });

  const before = listJobs(cwd).map((j) => j.id);
  upsertJob(cwd, { id: "task-old", gateReviewedAt: new Date().toISOString() }, { touch: false });
  const after = listJobs(cwd).map((j) => j.id);

  assert.deepEqual(after, before, "marking a job as reviewed must not change its eviction position");
  assert.equal(after[0], "task-new", "the newest job stays at the head");
});
