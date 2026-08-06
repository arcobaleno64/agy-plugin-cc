import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { enrichJob } from "../plugins/gemini/scripts/lib/job-control.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// enrichJob reports a phase for the status line. A job carries its own `phase`,
// written by the progress updater; the fallback covers records written before
// that field existed, or one whose event never landed.
//
// The fallback used to also scan the progress log for tool-level prefixes and
// report `investigating` / `verifying` / `editing`. Nothing ever wrote those
// lines, and the tests below exist so the branches are not reintroduced on the
// assumption that something might.

function job(overrides = {}) {
  return { id: "task-1", status: "running", jobClass: "task", logFile: null, ...overrides };
}

test("a job's own phase always wins over the fallback", () => {
  assert.equal(enrichJob(job({ phase: "reviewing" })).phase, "reviewing");
  assert.equal(enrichJob(job({ status: "completed", phase: "done" })).phase, "done");
});

test("the fallback reports status, and class only when the status says nothing", () => {
  assert.equal(enrichJob(job({ status: "queued" })).phase, "queued");
  assert.equal(enrichJob(job({ status: "cancelled" })).phase, "cancelled");
  assert.equal(enrichJob(job({ status: "failed" })).phase, "failed");
  assert.equal(enrichJob(job({ status: "completed" })).phase, "done");
  assert.equal(enrichJob(job({ status: "running", jobClass: "task" })).phase, "running");
  assert.equal(enrichJob(job({ status: "running", jobClass: "review" })).phase, "reviewing");
});

// The removed branches keyed off raw log lines with prefixes like "searching:".
// They could never have matched: every logged line is written as
// `[<iso timestamp>] <message>` (appendLogLine) and the preview keeps only lines
// starting with "[", so `line.startsWith("searching:")` was false by
// construction — not merely unreached for want of a producer.
test("progress log content does not influence the phase", (t) => {
  const logFile = path.join(ROOT, "tests", `.tmp-phase-${process.pid}.log`);
  fs.writeFileSync(
    logFile,
    [
      "[2026-08-05T00:00:00.000Z] searching: src/auth.js",
      "[2026-08-05T00:00:01.000Z] running command: npm test",
      "[2026-08-05T00:00:02.000Z] applying edits to src/auth.js",
      "[2026-08-05T00:00:03.000Z] file changes written"
    ].join("\n") + "\n",
    "utf8"
  );
  t.after(() => fs.rmSync(logFile, { force: true }));

  const enriched = enrichJob(job({ status: "running", jobClass: "task", logFile }));
  assert.equal(enriched.phase, "running", "a log line decided the phase again");
  assert.ok(enriched.progressPreview.length > 0, "the preview is still shown to the user");
});

// The claim the deleted code rested on: that something emits tool-level lines.
// This asserts the actual set of progress messages, so if a future change starts
// emitting richer ones, this test fails and the phase logic can be revisited
// deliberately rather than by accident.
test("the engine emits only coarse progress messages, which is why phases are coarse", () => {
  const source = fs.readFileSync(path.join(ROOT, "plugins", "gemini", "scripts", "lib", "gemini.mjs"), "utf8");
  const messages = [...source.matchAll(/onProgress\?\.\(\{\s*message:\s*(`[^`]*`|"[^"]*"|[^,]+)/g)]
    .map((m) => m[1].trim());

  assert.ok(messages.length > 0, "no progress messages found — the extraction broke, not the code");
  for (const message of messages) {
    assert.doesNotMatch(
      message,
      /searching:|running command:|running tool:|applying |file changes |command completed:/i,
      `a tool-level progress message appeared (${message}); the phase fallback may now be able to do better`
    );
  }
});
