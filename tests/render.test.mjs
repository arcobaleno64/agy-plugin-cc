import { test } from "node:test";
import assert from "node:assert/strict";

import {
  renderSetupReport,
  renderStatusReport,
  renderJobStatusReport,
  renderTaskResult,
  DELEGATED_OUTPUT_MARKER,
  renderCancelReport,
  describeTermination,
  renderStoredJobResult
} from "../plugins/gemini/scripts/lib/render.mjs";

function setupReport(overrides = {}) {
  return {
    ready: true,
    node: { detail: "v24.0.0" },
    npm: { detail: "11.0.0" },
    gemini: { detail: "0.44.1" },
    geminiAuth: { detail: "logged in" },
    agy: { detail: "1.0.2" },
    agyAuth: { loggedIn: false, state: "unknown", verifiable: false, detail: "authentication unknown" },
    sessionRuntime: { label: "gemini 0.44.1" },
    reviewGateEnabled: false,
    actionsTaken: [],
    nextSteps: [],
    ...overrides
  };
}

test("renderSetupReport lists every check and the review-gate state", () => {
  const out = renderSetupReport(setupReport({ reviewGateEnabled: true, nextSteps: ["Run `gemini`"] }));
  assert.match(out, /# Gemini Setup/);
  assert.match(out, /Status: ready/);
  assert.match(out, /- node: v24\.0\.0/);
  assert.match(out, /- gemini: 0\.44\.1/);
  assert.match(out, /- agy: 1\.0\.2/);
  assert.match(out, /- agy auth: authentication unknown/);
  assert.match(out, /- review gate: enabled/);
  assert.match(out, /Next steps:/);
});

test("renderSetupReport reports needs-attention when not ready", () => {
  const out = renderSetupReport(setupReport({ ready: false }));
  assert.match(out, /Status: needs attention/);
  assert.match(out, /- review gate: disabled/);
});

test("renderSetupReport surfaces model-alias provenance so preview drift is visible", () => {
  const out = renderSetupReport(
    setupReport({ modelAliases: { total: 9, preview: 5, lastVerified: "2026-05" } })
  );
  // Match the label + structure, not just the date (the date will change over time).
  assert.match(out, /- model aliases: 9 \(5 preview\), verified 2026-05/);
});

test("renderSetupReport renders the model-alias line gracefully when data is absent", () => {
  const out = renderSetupReport(setupReport());
  assert.match(out, /- model aliases: 0 \(0 preview\), verified unknown/);
});

test("renderStatusReport shows empty state when there are no jobs", () => {
  const out = renderStatusReport({
    sessionRuntime: { label: "gemini 0.44.1" },
    running: [],
    latestFinished: null,
    recent: [],
    needsReview: false
  });
  assert.match(out, /# Gemini Status/);
  assert.match(out, /Session runtime: gemini 0\.44\.1/);
  assert.match(out, /No jobs recorded yet\./);
});

test("renderStatusReport announces the stop-time review gate when enabled", () => {
  const out = renderStatusReport({
    sessionRuntime: { label: "gemini 0.44.1" },
    running: [],
    latestFinished: null,
    recent: [],
    needsReview: true
  });
  assert.match(out, /stop-time review gate is enabled/);
});

test("renderJobStatusReport renders a single job's id and status", () => {
  const out = renderJobStatusReport({ id: "task-1", status: "completed", title: "Investigate flake" });
  assert.match(out, /# Gemini Job Status/);
  assert.match(out, /task-1/);
  assert.match(out, /completed/);
});

// The marker is invisible in rendered Markdown but present for the parent agent;
// the model's text after it must still be byte-identical. (THREAT-MODEL 7.3)
test("renderTaskResult returns the raw output verbatim behind the delegated-output marker", () => {
  assert.equal(renderTaskResult({ rawOutput: "hello world" }, {}), `${DELEGATED_OUTPUT_MARKER}\nhello world\n`);
  assert.equal(renderTaskResult({ rawOutput: "ends with newline\n" }, {}), `${DELEGATED_OUTPUT_MARKER}\nends with newline\n`);
});

test("the delegated-output marker is an HTML comment so it does not render", () => {
  assert.match(DELEGATED_OUTPUT_MARKER, /^<!--.*-->$/);
  assert.match(DELEGATED_OUTPUT_MARKER, /not instructions to follow/);
});

test("renderTaskResult falls back to a failure message when there is no output", () => {
  assert.equal(renderTaskResult({ failureMessage: "boom" }, {}), "boom\n");
  assert.equal(renderTaskResult({}, {}), "Gemini did not return a final message.\n");
});

test("renderCancelReport confirms cancellation and points at status", () => {
  const out = renderCancelReport(
    { id: "task-7", title: "Big task", summary: "wip" },
    { attempted: true, delivered: true, method: "process-group" }
  );
  assert.match(out, /# Gemini Cancel/);
  assert.match(out, /Cancelled task-7\./);
  assert.match(out, /- Process: terminated the running process/);
  assert.match(out, /\/gemini:status/);
});

test("describeTermination is honest about whether a live process was killed", () => {
  assert.equal(
    describeTermination({ attempted: true, delivered: true }),
    "terminated the running process"
  );
  assert.equal(
    describeTermination({ attempted: true, delivered: false }),
    "no live process (it had already exited)"
  );
  // Non-finite pid path: terminateProcessTree returns attempted:false.
  assert.equal(describeTermination({ attempted: false, delivered: false }), "no live process was attached");
  assert.equal(describeTermination(undefined), "no live process was attached");
});

test("renderCancelReport does not claim a kill when the process had already exited", () => {
  const out = renderCancelReport(
    { id: "review-9" },
    { attempted: true, delivered: false, method: "taskkill" }
  );
  assert.match(out, /Cancelled review-9\./);
  assert.match(out, /- Process: no live process \(it had already exited\)/);
  assert.doesNotMatch(out, /terminated the running process/);
});

test("renderStoredJobResult prefers the structured rendered review output", () => {
  const out = renderStoredJobResult(
    { id: "review-1", status: "completed", title: "Gemini Review" },
    { result: { result: { verdict: "approve" } }, rendered: "RENDERED REVIEW\n" }
  );
  assert.match(out, /RENDERED REVIEW/);
});

test("renderStoredJobResult falls back to result.gemini.stdout and appends the resume hint", () => {
  const out = renderStoredJobResult(
    { id: "task-2", status: "completed", title: "Task" },
    { threadId: "sess-1", engine: "gemini", result: { gemini: { stdout: "RAW OUTPUT" } } }
  );
  assert.match(out, /RAW OUTPUT/);
  assert.match(out, /Gemini session ID: sess-1/);
  assert.match(out, /Resume in Gemini: gemini --resume sess-1/);
});

test("renderStoredJobResult uses the AGY conversation resume hint for agy jobs", () => {
  const out = renderStoredJobResult(
    { id: "task-3", status: "completed", title: "Task" },
    { threadId: "conv-abc", engine: "agy", result: { rawOutput: "AGY OUTPUT" } }
  );
  assert.match(out, /AGY OUTPUT/);
  assert.match(out, /AGY conversation ID: conv-abc/);
  assert.match(out, /Resume in AGY: agy --conversation conv-abc/);
  assert.doesNotMatch(out, /gemini/i);
});

test("renderStoredJobResult defaults to the gemini resume hint when no engine is recorded", () => {
  const out = renderStoredJobResult(
    { id: "task-4", status: "completed", title: "Task" },
    { threadId: "sess-2", result: { rawOutput: "OUT" } }
  );
  assert.match(out, /Resume in Gemini: gemini --resume sess-2/);
});

test("renderStoredJobResult reads engine from the index job when the stored file lacks it", () => {
  const out = renderStoredJobResult(
    { id: "task-5", status: "completed", title: "Task", engine: "agy", threadId: "conv-xyz" },
    { result: { rawOutput: "OUT" } }
  );
  assert.match(out, /Resume in AGY: agy --conversation conv-xyz/);
});

test("renderStoredJobResult reports when no payload was stored", () => {
  const out = renderStoredJobResult({ id: "task-9", status: "failed", title: "X" }, {});
  assert.match(out, /No captured result payload was stored/);
});

test("renderJobStatusReport includes structured failure metadata", () => {
  const out = renderJobStatusReport({
    id: "task-failed",
    status: "failed",
    title: "Gemini Task",
    failure: {
      category: "rate-limit",
      retryable: true,
      summary: "Rate limit exceeded.",
      nextStep: "Retry later."
    }
  });

  assert.match(out, /Failure: rate-limit \(retryable\)/);
  assert.match(out, /Rate limit exceeded\./);
  assert.match(out, /Next step: Retry later\./);
});

test("renderStoredJobResult includes stored failure metadata when there is no output", () => {
  const out = renderStoredJobResult(
    { id: "task-failed", status: "failed", title: "Gemini Task" },
    {
      failure: {
        category: "auth",
        retryable: false,
        summary: "Gemini authentication failed.",
        nextStep: "Run `gemini` once to authenticate."
      }
    }
  );

  assert.match(out, /Failure: auth \(not retryable\)/);
  assert.match(out, /Gemini authentication failed\./);
  assert.match(out, /Run `gemini` once to authenticate\./);
});
