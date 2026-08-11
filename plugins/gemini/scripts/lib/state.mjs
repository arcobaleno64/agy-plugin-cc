import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyCliFailure } from "./failures.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;

// CLAUDE_PLUGIN_DATA is what Claude Code actually sets, and what
// session-lifecycle-hook.mjs forwards into the session env file so later
// commands see it. This module read GEMINI_COMPANION_DATA instead — a name
// nothing sets — so the forwarding was dead and every install fell through to
// the temp directory, where the OS eventually deletes background job state.
// Upstream codex-plugin-cc reads CLAUDE_PLUGIN_DATA in both files; the port
// renamed it here and not there.
//
// GEMINI_COMPANION_DATA is kept, and kept first, as a deliberate override: it
// was readable in shipped source and someone may have set it. Deprecated —
// drop it at 1.0.
const PLUGIN_DATA_ENVS = ["GEMINI_COMPANION_DATA", "CLAUDE_PLUGIN_DATA"];
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "gemini-companion");

function resolvePluginDataDir() {
  for (const name of PLUGIN_DATA_ENVS) {
    const value = String(process.env[name] ?? "").trim();
    if (value) return value;
  }
  return null;
}
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

// Windows refuses to rename onto a path another process holds open, raising
// EPERM/EBUSY/EACCES where POSIX simply succeeds. Every writer here is a
// detached worker racing its siblings, so a bare renameSync failed whole jobs
// on the plugin's most-used path. Retry briefly instead of surfacing a platform
// sharing conflict as a job failure. Bounded: a genuine permission problem
// still throws, it just throws ~250 ms later.
const RENAME_RETRY_ATTEMPTS = 50;
const RENAME_RETRY_DELAY_MS = 5;
const SHARING_ERROR_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function nowIso() {
  return new Date().toISOString();
}

// state.json holds configuration only. It used to also hold the job index — a
// single array that every detached worker loaded, mutated and rewrote — which
// could not survive concurrency: the last writer's snapshot won, so a sibling's
// job silently vanished from the index (`/gemini:result` then reported "No job
// found" for a job whose record and output were sitting on disk), and the
// pruning step deleted the artifacts of any job missing from that stale
// snapshot. Measured on Windows at 6 concurrent jobs: up to 4 of 6 job records
// and logs destroyed per run, with EPERM absent from the run entirely.
//
// The jobs/ directory is now the index. Each job owns exactly one file, written
// only by the process that owns that job, so there is no shared mutable list to
// lose an update on and nothing a sibling can delete.
function defaultState() {
  return {
    version: STATE_VERSION,
    config: {}
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = resolvePluginDataDir();
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

function readStateDirFile(stateDir) {
  const stateFile = path.join(stateDir, STATE_FILE_NAME);
  if (!fs.existsSync(stateFile)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function loadState(cwd) {
  const parsed = readStateDirFile(resolveStateDir(cwd));
  if (!parsed) {
    return defaultState();
  }
  return {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(parsed.config ?? {})
    }
  };
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function sleepMs(ms) {
  // Synchronous by necessity: every caller here is a sync fs path reached from
  // both the CLI and detached workers.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(tempFile, filePath) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(tempFile, filePath);
      return;
    } catch (error) {
      if (!SHARING_ERROR_CODES.has(error?.code) || attempt >= RENAME_RETRY_ATTEMPTS) {
        throw error;
      }
      sleepMs(RENAME_RETRY_DELAY_MS);
    }
  }
}

function atomicWriteJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  );
  try {
    fs.writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameWithRetry(tempFile, filePath);
  } catch (error) {
    removeFileIfExists(tempFile);
    throw error;
  }
}

export function saveState(cwd, state) {
  ensureStateDir(cwd);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    }
  };
  atomicWriteJson(resolveStateFile(cwd), nextState);
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = randomBytes(5).toString("hex");
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

// Merge a patch into the job's own file. Nothing else is touched, so two
// workers patching two different jobs cannot interfere at all, and a worker
// patching its own job is the only writer of that file.
export function upsertJob(cwd, jobPatch) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobPatch.id);
  const existing = fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
  const timestamp = nowIso();
  const next = existing
    ? { ...existing, ...jobPatch, updatedAt: timestamp }
    : { createdAt: timestamp, ...jobPatch, updatedAt: timestamp };
  atomicWriteJson(jobFile, next);
  return next;
}

// The listed form of a job. `result` and `rendered` are the job's output, which
// only `/gemini:result` reads (through readStoredJob); withholding them here
// keeps `/gemini:status --json` the size and shape it has always been, now that
// the listing reads the full record rather than a summary index.
function toIndexEntry(job) {
  const { result, rendered, ...entry } = job;
  return entry;
}

// One-time upgrade path: releases through v0.16.7 kept the job list inside
// state.json. Materialize any such entry that has no file of its own, then drop
// the array, so a user's existing jobs survive the upgrade instead of
// disappearing the moment the listing stops reading state.json.
function migrateLegacyJobIndex(cwd, stateDir) {
  const parsed = readStateDirFile(stateDir);
  const legacyJobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
  if (legacyJobs.length === 0) {
    return;
  }
  const jobsDir = path.join(stateDir, JOBS_DIR_NAME);
  for (const job of legacyJobs) {
    const jobFile = path.join(jobsDir, `${job?.id}.json`);
    if (!job?.id || fs.existsSync(jobFile)) {
      continue;
    }
    atomicWriteJson(jobFile, job);
  }
  saveState(cwd, { config: parsed.config ?? {} });
}

export function listJobs(cwd) {
  // resolveStateDir shells out to git to find the workspace root, so resolve it
  // once for the whole call. `/gemini:status --wait` polls this every two
  // seconds, and the migration check plus the directory scan used to resolve it
  // separately — two process spawns per poll where the old shared index cost one.
  const stateDir = resolveStateDir(cwd);
  migrateLegacyJobIndex(cwd, stateDir);
  const jobsDir = path.join(stateDir, JOBS_DIR_NAME);

  let entries;
  try {
    entries = fs.readdirSync(jobsDir);
  } catch {
    return [];
  }

  return entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => toIndexEntry(readJobFile(path.join(jobsDir, name))))
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function removeJobArtifacts(jobsDir, job) {
  removeFileIfExists(path.join(jobsDir, `${job.id}.json`));
  removeFileIfExists(job.logFile);
}

export function removeJobs(cwd, predicate) {
  const removed = listJobs(cwd).filter((job) => predicate(job));
  const jobsDir = path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
  for (const job of removed) {
    removeJobArtifacts(jobsDir, job);
  }
  return removed;
}

// Bound the store at MAX_JOBS, deciding from what is on disk right now rather
// than from any caller's snapshot — the stale-snapshot version of this deleted
// live siblings. An unfinished job is never a candidate no matter how far down
// the list it sorts: its worker is still writing to those files.
export function pruneJobStore(cwd, { keepId = null } = {}) {
  const jobs = listJobs(cwd);
  if (jobs.length <= MAX_JOBS) {
    return [];
  }
  const evictable = jobs
    .slice(MAX_JOBS)
    .filter((job) => job.id !== keepId && job.status !== "queued" && job.status !== "running");
  const jobsDir = path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
  for (const job of evictable) {
    removeJobArtifacts(jobsDir, job);
  }
  return evictable;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  // Prune once per job, when its file first appears. Doing it on every write
  // would rescan the directory four times per job for no gain.
  const isNewJob = !fs.existsSync(jobFile);
  atomicWriteJson(jobFile, payload);
  if (isNewJob) {
    pruneJobStore(cwd, { keepId: jobId });
  }
  return jobFile;
}

export function readJobFile(jobFile) {
  try {
    return JSON.parse(fs.readFileSync(jobFile, "utf8"));
  } catch (error) {
    const id = path.basename(jobFile, path.extname(jobFile));
    const errorMessage = `Unreadable job file ${jobFile}: ${error instanceof Error ? error.message : String(error)}`;
    return {
      id,
      status: "failed",
      phase: "failed",
      errorMessage,
      failure: classifyCliFailure({
        category: "invalid-json",
        errorMessage,
        summary: "Stored job payload is not valid JSON.",
        nextStep: "Run `/gemini:status` to reconcile the failed job, then retry the command if needed."
      })
    };
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
