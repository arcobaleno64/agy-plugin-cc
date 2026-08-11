#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getConfig, listJobs } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPANION_SCRIPT = path.join(SCRIPT_DIR, "gemini-companion.mjs");
const GATE_REVIEW_TIMEOUT_MS = 840_000; // 14 min (hook timeout is 900 s)

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function hasCompletedWriteTask(jobs) {
  return jobs.some(
    (job) => job.write === true && job.status === "completed" && job.jobClass === "task"
  );
}

function runAdversarialReview(cwd) {
  try {
    // The gate fires because a --write task completed; those edits live in the
    // working tree (the plugin never commits), so review the working tree
    // explicitly instead of relying on auto scope (which could resolve to an
    // empty branch diff and pass vacuously).
    const output = execFileSync(
      process.execPath,
      [COMPANION_SCRIPT, "adversarial-review", "--scope", "working-tree", "--json"],
      { cwd, encoding: "utf8", timeout: GATE_REVIEW_TIMEOUT_MS }
    );
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function buildBlockReason(payload) {
  const result = payload?.result;
  if (!result) {
    return "Adversarial review flagged issues. Run /gemini:adversarial-review for details.";
  }
  const summary =
    typeof result.summary === "string" && result.summary.trim() ? result.summary.trim() : "";
  const count = Array.isArray(result.findings) ? result.findings.length : 0;
  const countLabel = count > 0 ? ` (${count} finding${count === 1 ? "" : "s"})` : "";
  // A truncated review is recorded as `needs-attention` even with no findings,
  // so say which files went unreviewed — otherwise this reads as "0 findings,
  // but blocked anyway" and the user cannot act on it.
  const truncation = payload?.truncation;
  if (truncation?.truncated) {
    const unreviewed = [...(truncation.omittedFiles ?? []), ...(truncation.truncatedFiles ?? [])];
    const named = unreviewed.slice(0, 5).join(", ");
    const rest = unreviewed.length > 5 ? `, and ${unreviewed.length - 5} more` : "";
    return `The change was too large to review in full, so it was only partially checked${named ? ` (not fully reviewed: ${named}${rest})` : ""}${countLabel}. Review those files yourself, or narrow the change, before stopping.`;
  }
  return `${summary}${countLabel} — run /gemini:adversarial-review --wait before stopping.`;
}

async function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  let config = {};
  try {
    config = getConfig(workspaceRoot) ?? {};
  } catch {
    // If state is unreadable, skip the gate silently.
    process.exit(0);
  }

  if (!config.stopReviewGateEnabled) {
    process.exit(0);
  }

  const jobs = listJobs(workspaceRoot);
  if (!hasCompletedWriteTask(jobs)) {
    emitDecision({ decision: "proceed" });
    return;
  }

  const payload = runAdversarialReview(cwd);
  if (!payload) {
    // Review failed or Gemini unavailable — fail OPEN (never trap the user at
    // Stop), but make the skip VISIBLE instead of silent so they know the gate
    // did not actually run. `systemMessage` surfaces to the user; stderr is a
    // belt-and-suspenders fallback for hook logs.
    const warning =
      "Gemini review gate skipped: the adversarial review could not run (Gemini/AGY unavailable or errored). Run /gemini:adversarial-review --wait before stopping if you changed code.";
    process.stderr.write(`${warning}\n`);
    emitDecision({ decision: "proceed", systemMessage: warning });
    return;
  }

  const verdict = payload?.result?.verdict;
  if (verdict === "needs-attention") {
    emitDecision({ decision: "block", reason: buildBlockReason(payload) });
    return;
  }

  emitDecision({ decision: "proceed" });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(0);
});
