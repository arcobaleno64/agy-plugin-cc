import fs from "node:fs";

import { classifyCliFailure } from "./failures.mjs";
import { getSessionRuntimeStatus } from "./gemini.mjs";
import { isPidAlive as defaultIsPidAlive } from "./process.mjs";
import { getConfig, listJobs, readJobFile, resolveJobFile, upsertJob, writeJobFile } from "./state.mjs";
import { SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;
export const DEFAULT_STALE_JOB_MS = 6 * 60 * 60 * 1000;

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

export function getCurrentSessionId(options = {}) {
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

// Restrict jobs to the current Claude session. When no session id is known
// (e.g. the lifecycle hook never ran) we fail closed against cross-session
// leakage: only session-agnostic jobs (no sessionId, e.g. legacy or direct-CLI
// runs) stay reachable, while jobs tagged to some other Claude session are
// hidden. This keeps the default scope honest — `--resume-last` can never
// silently continue another session's thread, and status/result never expose
// unrelated job output. Explicit `--all` remains the way to cross sessions.
//
// An UNTAGGED job is a third case, and it used to be sorted onto the wrong side.
// "No sessionId" does not mean "another session's": it means nobody could say.
// The MCP server is launched from .mcp.json and never receives
// GEMINI_COMPANION_SESSION_ID (the lifecycle hook can only export into
// CLAUDE_ENV_FILE, which reaches later Bash commands, not a server started
// alongside them), so every job it queues is untagged — and was therefore
// invisible to `/gemini:status` in any session, which is every session inside
// Claude Code. Measured: a completed untagged job appears in neither `running`,
// `recent`, nor `latestFinished`. The user could not see the review they had
// just started, and could not cancel it, because cancel resolves through the
// same filter.
//
// So discovery admits untagged jobs, and only jobs belonging to a *different*
// session stay hidden — the leak the filter was built for is untouched.
// `includeUnattributed: false` is for the one caller that must stay stricter:
// resume continues a conversation rather than merely listing one.
export function filterJobsForCurrentSession(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs.filter((job) => !job.sessionId);
  }
  const includeUnattributed = options.includeUnattributed !== false;
  return jobs.filter((job) => job.sessionId === sessionId || (includeUnattributed && !job.sessionId));
}

function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  if (!logFile || !fs.existsSync(logFile)) {
    return [];
  }

  const lines = fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line));

  return lines.slice(-maxLines);
}

function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

// Phase for a job whose own `phase` field is absent — a record written before
// the field existed, or one whose progress event never landed.
//
// It used to also scan the progress log for tool-level prefixes ("searching:",
// "running command:", "applying ") and report `investigating`, `verifying` or
// `editing`. Those tests could not have passed under any input: every line is
// written as `[<iso timestamp>] <message>` (appendLogLine) and the preview keeps
// only lines starting with "[", so `startsWith("searching:")` was false by
// construction.
//
// Nothing wrote such lines either. The log receives only the six progress
// messages `lib/gemini.mjs` emits — "Detecting engine...", "Starting <engine>
// turn...", "Turn completed." and their review equivalents — because
// `runCommand` is `spawnSync`: the engine's output arrives in one blocking
// return, not as events, so there is nothing to narrate mid-run.
//
// Nor is that detail obtainable. AGY 1.1.8's `--output-format stream-json` was
// measured on 1.1.10 (2026-08-05): it emits `step_type` values of `tool`,
// `agent_response`, `user_input`, `checkpoint` and `unknown` — and **`tool`
// carries no tool name or arguments**, so read-versus-run-tests-versus-edit
// cannot be distinguished from it either. Reporting those phases would have
// required inventing them.
//
// What remains is what is actually known: the job's own status, and its class.
function fallbackJobPhase(job) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "partial":
      return "partial";
    case "completed":
      return "done";
    default:
      return job.jobClass === "review" ? "reviewing" : "running";
  }
}

export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      job.status === "queued" || job.status === "running" || job.status === "failed" || job.status === "partial"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "partial" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? fallbackJobPhase(enriched)
  };
}

export function readStoredJob(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function isActiveStatus(status) {
  return status === "queued" || status === "running";
}

function activeJobAgeMs(job, nowMs) {
  const started = Date.parse(job.startedAt ?? job.createdAt ?? job.updatedAt ?? "");
  if (!Number.isFinite(started)) {
    return 0;
  }
  return Math.max(0, nowMs - started);
}

function staleFailureForJob(job, options = {}) {
  if (!isActiveStatus(job.status) || !Object.prototype.hasOwnProperty.call(job, "pid")) {
    return null;
  }

  const staleJobMs = options.staleJobMs ?? DEFAULT_STALE_JOB_MS;
  const nowMs = options.now ? new Date(options.now).getTime() : Date.now();
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  if (!Number.isFinite(job.pid)) {
    return classifyCliFailure({
      category: "stale-job",
      summary: `Job ${job.id} was marked ${job.status}, but it has no live worker pid.`
    });
  }
  if (!isPidAlive(job.pid)) {
    return classifyCliFailure({
      category: "stale-job",
      summary: `Job ${job.id} was marked ${job.status}, but worker pid ${job.pid} is no longer running.`
    });
  }
  if (activeJobAgeMs(job, nowMs) > staleJobMs) {
    return classifyCliFailure({
      category: "stale-job",
      summary: `Job ${job.id} exceeded the active-job stale threshold.`
    });
  }
  return null;
}

function jobFileFailureForActiveJob(workspaceRoot, job) {
  if (!isActiveStatus(job.status)) {
    return null;
  }
  const jobFile = resolveJobFile(workspaceRoot, job.id);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  const stored = readJobFile(jobFile);
  return stored?.failure?.category === "invalid-json" ? stored.failure : null;
}

function failActiveJob(workspaceRoot, job, failure) {
  const jobFile = resolveJobFile(workspaceRoot, job.id);
  const existing = fs.existsSync(jobFile) ? readJobFile(jobFile) : {};
  // readJobFile synthesizes a status:"failed" placeholder when the job file
  // itself is corrupt (invalid-json) — that's not a real terminal state, so
  // it must still go through the write below. A genuine terminal status here
  // means the worker finished on disk since this reconcile pass captured its
  // now-stale snapshot (e.g. it just completed); don't clobber that result.
  if (existing.status && !isActiveStatus(existing.status) && existing.failure?.category !== "invalid-json") {
    return null;
  }

  const completedAt = new Date().toISOString();
  const failed = {
    ...job,
    ...existing,
    id: job.id,
    status: "failed",
    phase: "failed",
    pid: null,
    completedAt,
    errorMessage: failure.summary,
    failure
  };
  writeJobFile(workspaceRoot, job.id, failed);
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "failed",
    phase: "failed",
    pid: null,
    completedAt,
    errorMessage: failure.summary,
    failure
  });
  return failed;
}

export function reconcileActiveJobs(workspaceRoot, jobs, options = {}) {
  let changed = false;
  const reconciled = jobs.map((job) => {
    const failure = jobFileFailureForActiveJob(workspaceRoot, job) ?? staleFailureForJob(job, options);
    if (!failure) {
      return job;
    }
    const failed = failActiveJob(workspaceRoot, job, failure);
    if (!failed) {
      return job;
    }
    changed = true;
    return failed;
  });
  return changed ? listJobs(workspaceRoot) : reconciled;
}

function matchJobReference(jobs, reference, predicate = () => true) {
  const filtered = jobs.filter(predicate);
  if (!reference) {
    return filtered[0] ?? null;
  }

  const exact = filtered.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  const prefixMatches = filtered.filter((job) => job.id.startsWith(reference));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Job reference "${reference}" is ambiguous. Use a longer job id.`);
  }

  throw new Error(`No job found for "${reference}". Run /gemini:status to list known jobs.`);
}

export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  // Default to the current Claude session; --all crosses every session.
  const allJobs = reconcileActiveJobs(workspaceRoot, listJobs(workspaceRoot), options);
  const scopedJobs = options.all ? allJobs : filterJobsForCurrentSession(allJobs, options);
  const jobs = sortJobsNewestFirst(scopedJobs);
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => job.status === "queued" || job.status === "running")
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => job.status !== "queued" && job.status !== "running") ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => job.status !== "queued" && job.status !== "running" && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    needsReview: Boolean(config.stopReviewGateEnabled),
    sessionRuntime: getSessionRuntimeStatus({ env: options.env }),
    running,
    latestFinished,
    recent
  };
}

export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(reconcileActiveJobs(workspaceRoot, listJobs(workspaceRoot), options));
  const exactGroup = reference ? jobs.filter((job) => job.groupId === reference) : [];
  const selected = exactGroup[0] ?? matchJobReference(jobs, reference);
  if (!selected) {
    throw new Error(`No job found for "${reference}". Run /gemini:status to inspect known jobs.`);
  }

  const grouped = selected.groupId
    ? jobs.filter((job) => job.groupId === selected.groupId).map((job) => enrichJob(job, { maxProgressLines: options.maxProgressLines }))
    : [];

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines }),
    ...(selected.groupId ? { groupId: selected.groupId, jobs: grouped } : {})
  };
}

export function resolveResultJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // Default scope is the current Claude session (consistent with /gemini:status)
  // so an explicit id/prefix can never reach another session's job. Pass
  // { all: true } to resolve across every session in the workspace.
  const candidates = options.all ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot));
  const jobs = sortJobsNewestFirst(candidates);
  const selected = matchJobReference(
    jobs,
    reference,
    (job) => job.status === "completed" || job.status === "failed" || job.status === "partial" || job.status === "cancelled"
  );

  if (selected) {
    return { workspaceRoot, job: selected };
  }

  const active = matchJobReference(jobs, reference, (job) => job.status === "queued" || job.status === "running");
  if (active) {
    throw new Error(`Job ${active.id} is still ${active.status}. Check /gemini:status and try again once it finishes.`);
  }

  if (reference) {
    throw new Error(`No finished job found for "${reference}". Run /gemini:status to inspect active jobs.`);
  }

  throw new Error("No finished Gemini jobs found for this repository yet.");
}

export function resolveResultJobs(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const candidates = options.all ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot));
  const jobs = sortJobsNewestFirst(candidates);
  const exactGroup = reference ? jobs.filter((job) => job.groupId === reference) : [];
  const selected = exactGroup[0] ?? resolveResultJob(cwd, reference, options).job;

  if (!selected.groupId) {
    return { workspaceRoot, job: selected };
  }

  const grouped = jobs.filter((job) => job.groupId === selected.groupId);
  const active = grouped.find((job) => isActiveStatus(job.status));
  if (active) {
    throw new Error(`Review group ${selected.groupId} is still running (${active.id}: ${active.status}). Check /gemini:status and try again once it finishes.`);
  }
  return { workspaceRoot, groupId: selected.groupId, jobs: grouped };
}

export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // Default scope is the current Claude session so /gemini:cancel can never
  // terminate another session's (or another project's) job — neither by id nor
  // via the no-argument "single active job" shortcut. Pass { all: true } to
  // deliberately cross sessions.
  const scoped = options.all ? listJobs(workspaceRoot) : filterJobsForCurrentSession(listJobs(workspaceRoot));
  const jobs = sortJobsNewestFirst(scoped);
  const activeJobs = jobs.filter((job) => job.status === "queued" || job.status === "running");

  if (reference) {
    const selected = matchJobReference(activeJobs, reference);
    if (!selected) {
      throw new Error(`No active job found for "${reference}".`);
    }
    return { workspaceRoot, job: selected };
  }

  if (activeJobs.length === 1) {
    return { workspaceRoot, job: activeJobs[0] };
  }
  if (activeJobs.length > 1) {
    throw new Error("Multiple Gemini jobs are active. Pass a job id to /gemini:cancel.");
  }

  throw new Error("No active Gemini jobs to cancel.");
}
