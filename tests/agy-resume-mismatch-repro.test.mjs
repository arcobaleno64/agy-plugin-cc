// Repro for a suspected gap (AGY orchestrator review, 2026-11-27): a resumed AGY
// turn that reports a mismatched init.cwd and then dies before printing a result
// envelope returns threadId: null, so the job store cannot attribute the
// mismatch to the thread and resolveLatestTrackedTaskThread's
// newerMismatchForThread check (job.threadId === trackedTask.threadId) never
// sees it. This test pins the first link of that chain only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runGeminiTurn } from "../plugins/gemini/scripts/lib/gemini.mjs";
import { initGitRepo } from "./helpers.mjs";

test("a resumed turn killed after a mismatched init keeps its conversation id", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "resume-mismatch-"));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "resume-elsewhere-"));
  try {
    initGitRepo(repo);
    const result = await runGeminiTurn(
      repo,
      { prompt: "continue", write: true, engine: "agy", resumeLast: true, resumeThreadId: "c-t", resumeWorkspaceVerified: true },
      {
        detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
        runCommandFn: () => ({
          status: null,
          signal: "SIGTERM",
          // init reports a different workspace; no result event ever arrives.
          stdout: `{"event":"init","conversation_id":"c-t","init":{"cwd":${JSON.stringify(elsewhere)},"permission_mode":"default"}}\n`,
          stderr: ""
        })
      }
    );
    assert.equal(result.agyProtection?.workspaceMismatch, true, "the mismatch itself is detected");
    assert.equal(
      result.threadId,
      "c-t",
      "the thread id must survive, or the stored job cannot be matched against the thread it mismatched"
    );
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});
