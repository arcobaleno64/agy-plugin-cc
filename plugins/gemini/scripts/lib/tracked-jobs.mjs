import fs from "node:fs";
import process from "node:process";

import { classifyCliFailure } from "./failures.mjs";
import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "GEMINI_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      engine: typeof value.engine === "string" && value.engine.trim() ? value.engine.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    engine: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;
  let lastEngine = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    // Which engine a run chose was only written when the job finished, so a
    // running job could not answer it — and under `auto` that is exactly when the
    // answer matters, because the choice decides which account's quota is being
    // spent. The runner knows it the moment detection returns, which is well
    // before the first token; it travels on the same event as the phase change
    // that announces the turn.
    if (normalized.engine && normalized.engine !== lastEngine) {
      lastEngine = normalized.engine;
      patch.engine = normalized.engine;
      changed = true;
    }

    if (!changed) {
      return;
    }

    // A session-end sweep or a prune can remove the job while its worker is
    // still reporting. upsertJob would recreate the record from the patch, so
    // the existence check stays — it is the only thing keeping a deleted job
    // deleted. (It used to guard just the job-file mirror, because the shared
    // index was patched unconditionally; with the directory as the store, one
    // write does both and the guard covers it.)
    if (!fs.existsSync(resolveJobFile(workspaceRoot, jobId))) {
      return;
    }

    upsertJob(workspaceRoot, patch);
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[gemini] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  try {
    const execution = await runner();
    // Three terminal states, not two. A run that was cut off after producing
    // text is neither: calling it "completed" would claim a completeness the
    // engine never confirmed, and calling it "failed" told users to pay for a
    // second copy of an answer already in hand (field note gi-2026-08-17-c4a1).
    // The runner decides — see the `partial` flag in lib/gemini.mjs — because
    // only it knows whether text was salvaged or delivered.
    const completionStatus = execution.exitStatus === 0
      ? "completed"
      : (execution.partial ? "partial" : "failed");
    const completedAt = nowIso();
    // A partial run keeps its failure: that is where the next step lives, and it
    // is the part that stops a user re-running work they already have.
    const failure = completionStatus !== "completed"
      ? (execution.failure ?? classifyCliFailure({
          status: execution.exitStatus,
          stderr: execution.payload?.gemini?.stderr ?? execution.payload?.stderr ?? "",
          stdout: execution.payload?.rawOutput ?? execution.payload?.gemini?.stdout ?? "",
          errorMessage: execution.summary
        }))
      : null;
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      engine: execution.engine ?? runningRecord.engine ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : completionStatus,
      completedAt,
      result: execution.payload,
      rendered: execution.rendered,
      ...(failure ? { failure } : {})
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      engine: execution.engine ?? runningRecord.engine ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : completionStatus,
      pid: null,
      completedAt,
      ...(failure ? { failure } : {})
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const failure = classifyCliFailure(error?.failure ?? { error, errorMessage });
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null,
      failure
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage,
      completedAt,
      failure
    });
    throw error;
  }
}
