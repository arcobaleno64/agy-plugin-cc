#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getConfig, listJobs } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SELF_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SELF_PATH);
const COMPANION_SCRIPT = path.join(SCRIPT_DIR, "gemini-companion.mjs");
const GATE_REVIEW_TIMEOUT_MS = 840_000; // 14 min (hook timeout is 900 s)

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

// Letting the stop through means OMITTING `decision`: the Stop hook schema
// accepts only "approve" | "block", and Claude Code rejects the whole payload
// (running no hook output at all) if anything else appears there.
function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

// Exported for test: this predicate decides whether a session that edited the
// repository is reviewed before it ends, so which statuses count is a claim that
// has to be pinned rather than read off the line.
export function hasCompletedWriteTask(jobs) {
  return jobs.some(
    (job) => job.write === true && (job.status === "completed" || job.status === "partial") && job.jobClass === "task"
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

export function buildBlockReason(payload) {
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
    // Lead with what the review actually found. Returning the truncation notice
    // alone discarded the summary, so a truncated review that DID find real
    // problems reported only which files went unread — the findings existed and
    // the user never saw them.
    const found = summary ? `${summary}${countLabel} — and ` : "";
    const partial = summary
      ? "the change was too large to review in full"
      : `The change was too large to review in full, so it was only partially checked${countLabel}`;
    return `${found}${partial}${named ? ` (not fully reviewed: ${named}${rest})` : ""}. Review those files yourself, or narrow the change, before stopping.`;
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
    emitDecision({});
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
    emitDecision({ systemMessage: warning });
    return;
  }

  const verdict = payload?.result?.verdict;
  if (verdict === "needs-attention") {
    emitDecision({ decision: "block", reason: buildBlockReason(payload) });
    return;
  }

  emitDecision({});
}

// Same guard as gemini-mcp.mjs and transfer.mjs: importing this module to test
// buildBlockReason must not run the hook, which reads stdin and spawns a review.
if (process.argv[1] === SELF_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(0);
  });
}
