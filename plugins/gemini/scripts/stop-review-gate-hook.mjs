#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getHeadCommit, getWorkingTreeState } from "./lib/git.mjs";
import { getConfig, jobStoreUnreadableReason, listJobs, upsertJob } from "./lib/state.mjs";
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

// Exported for test: this predicate decides whether a turn that edited the
// repository is reviewed before it ends, so which statuses count is a claim that
// has to be pinned rather than read off the line.
//
// The store it reads is the whole WORKSPACE, deliberately: a write task queued
// through the MCP tools carries no session id, so a session-scoped predicate
// would leave exactly those edits ungated. The cost of that scope is that the
// trigger has to be CONSUMED, or one write task arms the gate on every turn
// forever (SessionEnd never evicts an untagged job). `gateReviewedAt` is that
// consumption mark.
//
// It is compared against `completedAt`, NOT `updatedAt`. `upsertJob` stamps
// `updatedAt` with its own `nowIso()` on every write, so the very call that
// records the mark moves `updatedAt` past it — a mark compared against
// `updatedAt` is stale the instant it is written, and the gate re-arms every
// turn exactly as before. `completedAt` is written once when the job reaches a
// terminal state and is not touched by a later patch, so it is the timestamp
// that identifies WHICH finished result was reviewed. A job that finishes again
// (a resumed or re-run id) gets a newer `completedAt` and re-arms correctly.
export function pendingGateWriteTasks(jobs) {
  return jobs.filter(
    (job) =>
      job.write === true &&
      (job.status === "completed" || job.status === "partial") &&
      job.jobClass === "task" &&
      !(job.gateReviewedAt && job.completedAt && job.gateReviewedAt >= job.completedAt)
  );
}

export function hasCompletedWriteTask(jobs) {
  return pendingGateWriteTasks(jobs).length > 0;
}

// Marked only AFTER the review actually produced a verdict. A failed review
// fails open (below) without marking, so the edits it could not check still arm
// the gate on the next turn rather than being silently forgiven.
function markGateReviewed(workspaceRoot, jobs) {
  const stamp = new Date().toISOString();
  for (const job of jobs) {
    try {
      // touch:false — this records that the gate reviewed the job, not that the
      // job did anything, and bumping updatedAt would reorder the LRU and evict
      // a newer result in this one's place.
      upsertJob(workspaceRoot, { id: job.id, gateReviewedAt: stamp }, { touch: false });
    } catch {
      // A job whose file vanished mid-turn needs no mark.
    }
  }
}

function runAdversarialReview(cwd, scopeArgs, timeout = GATE_REVIEW_TIMEOUT_MS) {
  try {
    const output = execFileSync(
      process.execPath,
      [COMPANION_SCRIPT, "adversarial-review", ...scopeArgs, "--json"],
      { cwd, encoding: "utf8", timeout }
    );
    return JSON.parse(output);
  } catch {
    return null;
  }
}

// Exported for test. The gate fires because a --write task completed, and those
// edits are not always in the working tree: the task (or the user, before Stop)
// may have committed them, which leaves a clean tree that `--scope working-tree`
// reads as empty — a vacuous pass. So the scopes follow where the edits can be:
// uncommitted ones through the working tree, committed ones through
// `baseHeadCommit..HEAD`, where baseHeadCommit is HEAD as the task started.
// Both can be true at once, and both are then reviewed.
export function resolveGateScopes({ dirty, head, baseHeadCommit }) {
  const scopes = [];
  if (dirty) scopes.push(["--scope", "working-tree"]);
  if (baseHeadCommit && head && baseHeadCommit !== head) scopes.push(["--base", baseHeadCommit]);
  // Nothing to look at, or no base to look from: review the working tree anyway
  // so the empty answer comes from the companion rather than from this guess.
  return scopes.length > 0 ? scopes : [["--scope", "working-tree"]];
}

function readGateRepositoryState(cwd, pending) {
  try {
    const dirty = getWorkingTreeState(cwd).isDirty;
    const head = getHeadCommit(cwd);
    // The oldest pending task started earliest, so its base covers the others.
    const oldest = [...pending]
      .filter((job) => job.baseHeadCommit)
      .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))[0];
    return { dirty, head, baseHeadCommit: oldest?.baseHeadCommit ?? null };
  } catch {
    return { dirty: true, head: null, baseHeadCommit: null };
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
  const pending = pendingGateWriteTasks(jobs);
  if (pending.length === 0) {
    // An empty list is the reason this lets Stop through, and `listJobs` gives
    // the same empty list for a store it could not read. Untangled here rather
    // than in `listJobs` because only this caller treats "no jobs" as a licence
    // to skip the gate; everywhere else an unreadable store and an empty one
    // really do render the same.
    const unreadable = jobStoreUnreadableReason(workspaceRoot);
    if (unreadable) {
      const warning =
        `Gemini review gate skipped: the job store could not be read (${unreadable}), so the gate cannot tell whether anything needs reviewing. Run /gemini:adversarial-review --wait before stopping if you changed code.`;
      process.stderr.write(`${warning}
`);
      emitDecision({ systemMessage: warning });
      return;
    }
    emitDecision({});
    return;
  }

  const repositoryState = readGateRepositoryState(cwd, pending);
  const deadline = Date.now() + GATE_REVIEW_TIMEOUT_MS;
  const payloads = [];
  for (const scopeArgs of resolveGateScopes(repositoryState)) {
    payloads.push(runAdversarialReview(cwd, scopeArgs, Math.max(1, deadline - Date.now())));
  }

  // The guard is "did it return a verdict", not "did it return anything". A
  // review that reviewed nothing still exits 0 with a whole JSON object: the
  // companion returns `{ empty: true, result: null }` when the scope is empty.
  // That payload is truthy, so `!payload` would let it through as if it were a
  // verdict. Same for a run whose output did not parse: `result` is null while
  // the exit status stays 0. An empty answer is a real answer only when the
  // companion says so (`empty: true`); anything else without a verdict is a
  // failed review.
  if (payloads.length > 0 && payloads.every((entry) => entry?.empty === true)) {
    // Nothing is in scope, so there is nothing left to review — and the mark must
    // be spent anyway. Left armed, every later Stop re-ran this empty review and
    // failed open again, forever.
    markGateReviewed(workspaceRoot, pending);
    if (!repositoryState.baseHeadCommit && repositoryState.head) {
      // A task recorded before baseHeadCommit existed cannot say where it
      // started, so a committed edit is indistinguishable from no edit.
      emitDecision({
        systemMessage: "Gemini review gate: no uncommitted changes and the write task recorded no starting commit, so edits it already committed were not reviewed. Run /gemini:adversarial-review --base <ref> --wait if you committed code."
      });
      return;
    }
    emitDecision({});
    return;
  }

  const reviewed = payloads.filter((entry) => entry?.result?.verdict);
  const payload = payloads.some((entry) => !entry?.result?.verdict && entry?.empty !== true)
    ? null
    : (reviewed.find((entry) => entry.result.verdict === "needs-attention") ?? reviewed[0]);
  if (!payload?.result?.verdict) {
    // Review failed, returned no verdict, or Gemini unavailable — fail OPEN
    // (never trap the user at Stop), but make the skip VISIBLE instead of silent
    // so they know the gate did not actually run. `systemMessage` surfaces to
    // the user; stderr is a belt-and-suspenders fallback for hook logs.
    const warning =
      "Gemini review gate skipped: the adversarial review did not return a verdict (Gemini/AGY unavailable, errored, or nothing in scope to review). Run /gemini:adversarial-review --wait before stopping if you changed code.";
    process.stderr.write(`${warning}\n`);
    emitDecision({ systemMessage: warning });
    return;
  }

  // The review ran and returned a verdict, so these edits have now been checked.
  // Mark before acting on the verdict: a `needs-attention` block that did not
  // mark would re-review the same edits on every subsequent turn, which is the
  // loop this consumption mark exists to end.
  markGateReviewed(workspaceRoot, pending);

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
