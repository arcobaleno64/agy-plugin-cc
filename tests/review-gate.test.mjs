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

import { hasCompletedWriteTask } from "../plugins/gemini/scripts/stop-review-gate-hook.mjs";

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
