#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { detectEngine, ENGINE_ENV, normalizeAgyEffort, normalizeAgyRequestedModel, normalizeRequestedModel, supportsAgyModelSelection, VALID_EFFORT_LEVELS } from "./lib/engine.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  filterJobsForCurrentSession,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJobs,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderReviewResult,
  renderTaskResult,
  renderStoredJobResult,
  renderStoredJobGroupResult,
  renderCancelReport,
  describeTermination,
  renderJobStatusReport,
  renderJobGroupStatusReport,
  renderSetupReport,
  renderStatusReport
} from "./lib/render.mjs";
import {
  runGeminiTurn,
  runGeminiReviewResilient,
  getGeminiAvailability,
  getAgyAvailability,
  getGeminiLoginStatus,
  getAgyLoginStatus,
  getGeminiPlanTier,
  getSessionRuntimeStatus
} from "./lib/gemini.mjs";
import { MODEL_MAP_METADATA, MODEL_ALIAS_ENTRIES } from "./lib/model-map.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SELF_PATH = fileURLToPath(import.meta.url);
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const STOP_REVIEW_TASK_MARKER = "";

// Deep (agentic) review guidance, appended to the review prompt when `--deep` is
// set. It invites the model to use its read-only tools to inspect repo context
// beyond the diff (dependency manifests, callers, untracked artifacts) — closing
// the gap vs a native agentic reviewer. Read-only: the gemini engine runs without
// --yolo so write tools require approval that never arrives non-interactively.
const DEEP_REVIEW_GUIDANCE = [
  "",
  "DEEP REVIEW MODE — look beyond the diff:",
  "Use your available read-only tools to inspect relevant repository context before finalizing.",
  "In particular check: dependency manifests (package.json / lockfiles) for any newly-used import,",
  "the files and callers the change touches, and any untracked files that should not be committed.",
  "Fold context-derived issues (undeclared dependencies, stray/untracked artifacts, broken call sites)",
  "into the SAME JSON findings shape. Do not modify any files."
].join("\n");

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/gemini-companion.mjs setup [--json] [--enable-review-gate|--disable-review-gate]",
      "  node scripts/gemini-companion.mjs adversarial-review [--wait|--background] [--deep] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <level>] [--engine agy|gemini|auto] [--engines gemini,agy] [focus text]",
      "  node scripts/gemini-companion.mjs review [--wait|--background] [--deep] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <level>] [--engine agy|gemini|auto]",
      "  node scripts/gemini-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model>] [--effort <low|medium|high>] [--engine agy|gemini|auto] [prompt]",
      "  node scripts/gemini-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/gemini-companion.mjs result [job-id] [--json]",
      "  node scripts/gemini-companion.mjs cancel [job-id] [--json]",
      "  node scripts/gemini-companion.mjs task-resume-candidate [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

function buildSetupReport(cwd, actionsTaken = [], options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const geminiStatus = getGeminiAvailability(cwd);
  const agyStatus = getAgyAvailability();
  const geminiAuth = getGeminiLoginStatus(cwd);
  const agyAuth = getAgyLoginStatus();
  const geminiPlanTier = getGeminiPlanTier();
  const config = getConfig(workspaceRoot) ?? {};

  // Readiness is computed for the engine the user actually selected (via
  // `--engine` or GEMINI_ENGINE). The default/gemini path mirrors upstream: the
  // auto-preferred engine must be installed AND authenticated. Explicit `--engine agy`
  // must NOT inherit Gemini's ready state — it depends on the AGY binary (whose
  // auth cannot be verified non-interactively), so AGY-present is "partial" and
  // AGY-missing is "not-ready".
  const requestedEngine = String(options.engine ?? "").trim().toLowerCase();
  // Validate against the same set the runtime resolver accepts (detectEngine).
  // An unrecognized engine must fail the preflight rather than inheriting Gemini
  // readiness — otherwise the next command resolves the same value and throws.
  const engineKnown =
    requestedEngine === "" || requestedEngine === "auto" || requestedEngine === "gemini" || requestedEngine === "agy";
  const agySelected = requestedEngine === "agy";
  const geminiReady = geminiStatus.available && geminiAuth.loggedIn;
  const agyAvailable = agyStatus.available;
  // Backward-compatible alias retained for existing JSON consumers. AGY is a
  // first-class supported engine; "fallback" describes only auto-routing order.
  const agyFallbackAvailable = agyAvailable;
  // AGY auth cannot be verified non-interactively, so `--engine agy` is never
  // reported as fully `ready` — the most it reaches is `readyState: "partial"`
  // (binary present, auth unknown). `ready:true` is reserved for a verified
  // runtime: an installed AND authenticated Gemini CLI. An unrecognized engine
  // is never ready.
  const ready = engineKnown && !agySelected && nodeStatus.available && geminiReady;
  const readyState = !engineKnown
    ? "not-ready"
    : !nodeStatus.available
      ? "not-ready"
      : agySelected
        ? agyStatus.available
          ? "partial"
          : "not-ready"
        : geminiReady
          ? "ready"
          : agyAvailable
            ? "partial"
            : "not-ready";

  const nextSteps = [];
  if (!engineKnown) {
    nextSteps.push(
      `Engine "${requestedEngine}" is not recognized. Use \`--engine auto\`, \`gemini\`, or \`agy\` (or unset GEMINI_ENGINE).`
    );
  }
  if (agySelected && !agyStatus.available) {
    nextSteps.push(
      "AGY was requested via `--engine agy` but is not installed. Install it with `curl -fsSL https://antigravity.google/cli/install.sh | bash`, or drop `--engine agy` to use the default Gemini CLI."
    );
  }
  if (agySelected && agyStatus.available) {
    nextSteps.push(
      "AGY is installed, but its authentication state cannot be verified non-interactively. Run an `--engine agy` command to confirm it is logged in."
    );
  }
  if (!geminiStatus.available && !agyStatus.available) {
    nextSteps.push(
      "Install at least one supported engine: Gemini CLI with `npm install -g @google/gemini-cli`, or AGY with `curl -fsSL https://antigravity.google/cli/install.sh | bash`."
    );
  }
  if (!agySelected && geminiStatus.available && !geminiAuth.loggedIn) {
    nextSteps.push("Run `gemini` once to authenticate via OAuth.");
  }
  if (!agySelected && !geminiStatus.available && agyAvailable) {
    nextSteps.push(
      "Gemini CLI is unavailable; AGY is installed as a supported engine and auto routing can select it. Use `--engine agy` explicitly to confirm its authentication state, or install Gemini CLI to restore the preferred auto-routing candidate."
    );
  }

  // Personal (free) plan EOL: warn that gemini CLI free access ends 2026-06-18.
  // Enterprise / Code Assist tiers are unaffected; an unknown tier stays silent.
  if (geminiPlanTier.tier === "personal") {
    nextSteps.push(
      "Heads-up: Gemini personal-plan free CLI access ends 2026-06-18. To keep the gemini engine after that, upgrade to Gemini Code Assist Standard/Enterprise; otherwise route through AGY (`--engine agy`) — the plugin reads AGY responses from its on-disk transcript because `agy --print` does not pipe output (upstream google-gemini/gemini-cli#27466)."
    );
  }

  // Surface model-alias provenance so preview-channel drift is visible: how many
  // aliases resolve to *-preview IDs (which can change) and when they were last
  // verified. Defensive in case the alias table is ever malformed.
  const modelAliasCount = Array.isArray(MODEL_ALIAS_ENTRIES) ? MODEL_ALIAS_ENTRIES.length : 0;
  const previewAliasCount = Array.isArray(MODEL_ALIAS_ENTRIES)
    ? MODEL_ALIAS_ENTRIES.filter((entry) => entry.preview).length
    : 0;

  return {
    ready,
    readyState,
    requestedEngine: requestedEngine || "auto",
    geminiReady,
    agyAvailable,
    agyFallbackAvailable,
    geminiPlanTier,
    node: nodeStatus,
    npm: npmStatus,
    gemini: geminiStatus,
    geminiAuth,
    agy: agyStatus,
    agyAuth,
    sessionRuntime: getSessionRuntimeStatus(),
    reviewGateEnabled: config.stopReviewGateEnabled ?? false,
    modelAliases: {
      total: modelAliasCount,
      preview: previewAliasCount,
      lastVerified: MODEL_MAP_METADATA?.lastVerified ?? "unknown"
    },
    actionsTaken,
    nextSteps
  };
}

function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "engine"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  // Honor the engine the user routes to (flag wins over GEMINI_ENGINE) so the
  // readiness verdict matches the engine the next command will actually use.
  const requestedEngine = options.engine ?? process.env[ENGINE_ENV];
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGateEnabled", true);
    actionsTaken.push("Review gate enabled.");
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGateEnabled", false);
    actionsTaken.push("Review gate disabled.");
  }

  const finalReport = buildSetupReport(cwd, actionsTaken, { engine: requestedEngine });
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function isActiveJobSnapshot(snapshot) {
  return (snapshot.jobs ?? [snapshot.job]).some((job) => isActiveJobStatus(job.status));
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobSnapshot(snapshot) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobSnapshot(snapshot),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // Only consider jobs from the current Claude session so a resume never jumps
  // into another session's (or another project's) thread.
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot))).filter(
    (job) => job.id !== options.excludeJobId
  );
  const activeTask = jobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /gemini:status before continuing it.`);
  }

  const trackedTask = jobs.find((job) => job.jobClass === "task" && job.status === "completed" && job.threadId);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  return null;
}

export function buildReviewPrompt(request) {
  const templateName = request.templateName ?? "adversarial-review";
  // Resolve the review target from the caller's --base/--scope so the user's
  // selection actually reaches the diff collection. (Re-resolving with empty
  // options here would silently discard --base/--scope.)
  const target = request.target ?? resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const context = collectReviewContext(request.cwd, target);
  if (context.isEmpty) return { context, prompt: null };

  const template = loadPromptTemplate(ROOT_DIR, templateName);
  const basePrompt = interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: request.focusText || "No extra focus provided.",
    REVIEW_INPUT: context.content
  });
  return {
    context,
    prompt: request.deep ? `${basePrompt}\n${DEEP_REVIEW_GUIDANCE}` : basePrompt
  };
}

async function executeReviewRun(request) {
  const reviewName = request.reviewName ?? "Adversarial Review";
  const templateName = request.templateName ?? "adversarial-review";
  const { context, prompt } = request.preparedReview ?? buildReviewPrompt(request);

  // Nothing-to-review guard: if the resolved target has no changes, short-circuit
  // instead of asking Gemini to review an empty diff (which it rubber-stamps as
  // "approved"). This matters most for a detached --background review, where the
  // worker re-resolves the diff at run time and a now-clean tree would otherwise
  // persist a vacuous approve that only surfaces at /gemini:result.
  if (context.isEmpty) {
    const targetLabel = context.target?.label ?? "the requested scope";
    const message = `Nothing to review — ${targetLabel} has no changes.`;
    return {
      exitStatus: 0,
      threadId: null,
      turnId: null,
      engine: null,
      payload: {
        review: reviewName,
        target: context.target,
        empty: true,
        gemini: null,
        result: null
      },
      rendered: `# Gemini ${reviewName}\n\nTarget: ${targetLabel}\n\n${message}\n`,
      summary: message,
      jobTitle: `Gemini ${reviewName}`,
      jobClass: "review",
      targetLabel
    };
  }

  const result = await runGeminiReviewResilient(request.cwd, {
    prompt,
    model: request.model,
    effort: request.effort,
    engine: request.engine,
    isAdversarial: templateName === "adversarial-review",
    onProgress: request.onProgress
  });

  const parsed = result.reviewJson
    ? { parsed: result.reviewJson, rawOutput: result.reviewText, parseError: null, failure: result.failure ?? null }
    : { parsed: null, rawOutput: result.reviewText, parseError: "Could not parse structured JSON from review output.", failure: result.failure ?? null };

  const payload = {
    review: reviewName,
    target: context.target,
    gemini: { status: result.status, stdout: result.reviewText, stderr: result.stderr ?? "" },
    result: parsed.parsed,
    ...(result.failure ? { failure: result.failure } : {})
  };

  const fallbackBanner = result.modelFallback ? `> ⚠️ ${result.modelFallback}\n\n` : "";

  return {
    exitStatus: result.status,
    threadId: null,
    turnId: null,
    engine: result.engine ?? null,
    payload,
    rendered: fallbackBanner + renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target?.label ?? "",
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? "Review completed.",
    jobTitle: `Gemini ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target?.label ?? "",
    ...(result.status !== 0 && result.failure ? { failure: result.failure } : {})
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);

  let resumeLast = false;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, { excludeJobId: request.jobId });
    if (!latestThread) {
      throw new Error("No previous Gemini task thread found.");
    }
    resumeLast = true;
  }

  if (!request.prompt && !resumeLast) {
    throw new Error("Provide a prompt or use --resume-last.");
  }

  const result = await runGeminiTurn(workspaceRoot, {
    prompt: request.prompt,
    model: request.model,
    effort: request.effort,
    engine: request.engine,
    write: request.write,
    resumeLast,
    onProgress: request.onProgress
  });

  const rawOutput = result.finalMessage ?? "";
  const failureMessage = result.stderr ?? "";
  const failure = result.failure ?? null;
  const taskMetadata = buildTaskRunMetadata({ prompt: request.prompt, resumeLast: request.resumeLast });

  const fallbackBanner = result.modelFallback ? `${result.modelFallback}\n\n` : "";
  const rendered = fallbackBanner + renderTaskResult(
    { rawOutput, failureMessage, reasoningSummary: result.reasoningSummary, failure },
    { title: taskMetadata.title, jobId: request.jobId ?? null, write: Boolean(request.write) }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId ?? null,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary,
    ...(failure ? { failure } : {})
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId ?? null,
    turnId: null,
    engine: result.engine ?? null,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write),
    ...(result.status !== 0 && failure ? { failure } : {})
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  const title = resumeLast ? "Gemini Resume" : "Gemini Task";
  const fallbackSummary = resumeLast ? "Continue previous task" : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /gemini:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false, engine = null, groupId = null }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
    ...(engine ? { engine } : {}),
    ...(groupId ? { groupId } : {})
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, engine, prompt, write, resumeLast, jobId }) {
  return {
    cwd,
    model,
    effort,
    engine,
    prompt,
    write,
    resumeLast,
    jobId
  };
}

// Serializable review request for the detached review-worker. A normal single
// review re-resolves base/scope when the worker runs. A grouped blind review may
// supply one preparedReview snapshot so every engine receives byte-identical
// input even if the working tree changes between worker starts.
function buildReviewRequest({ cwd, base, scope, model, effort, engine, focusText, reviewName, templateName, deep = false, preparedReview = null }) {
  return {
    cwd,
    base,
    scope,
    model,
    effort,
    engine,
    focusText,
    reviewName,
    templateName,
    deep,
    ...(preparedReview ? { preparedReview } : {})
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedWorker(cwd, jobId, workerCommand, spawnFn = spawn) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "gemini-companion.mjs");
  const child = spawnFn(process.execPath, [scriptPath, workerCommand, "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

// Persist a job and hand it to a detached worker (`task-worker` or
// `review-worker`). Both job classes share the same enqueue/state machinery; the
// worker subcommand only decides which executor deserializes the request.
function enqueueBackgroundJob(cwd, job, request, workerCommand, { spawnFn = spawn } = {}) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedWorker(cwd, job.id, workerCommand, spawnFn);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile,
      ...(job.engine ? { engine: job.engine } : {}),
      ...(job.groupId ? { groupId: job.groupId } : {})
    },
    logFile
  };
}

function validateEffortLevel(effort) {
  if (effort != null && !VALID_EFFORT_LEVELS.has(String(effort).trim().toLowerCase())) {
    throw new Error(`Invalid --effort "${effort}". Valid values: ${[...VALID_EFFORT_LEVELS].join(", ")}.`);
  }
}

// Detached workers must never be started with a selection that their target
// engine will reject. Preserve the engine-specific representation in the
// persisted request so the worker has no extra normalization responsibility.
function prepareEngineSelection(engineInfo, model, effort) {
  const requestedModel = model ?? null;
  const requestedEffort = effort ?? null;
  validateEffortLevel(requestedEffort);
  if (!requestedModel && !requestedEffort) return { model: requestedModel, effort: requestedEffort };

  if (engineInfo.engine === "agy") {
    if (!supportsAgyModelSelection(engineInfo.version)) {
      throw new Error(`AGY ${engineInfo.version} does not support --model/--effort. Upgrade to AGY 1.1.5 or newer, or select --engine gemini.`);
    }
    const agyModel = normalizeAgyRequestedModel(requestedModel);
    const agyEffort = normalizeAgyEffort(requestedEffort);
    if (agyModel && agyEffort) {
      throw new Error("AGY 1.1.5 cannot combine --model with --effort for its available model IDs. Select a model or an effort level, not both.");
    }
    return { model: agyModel, effort: agyEffort };
  }

  return { model: normalizeRequestedModel(requestedModel), effort: requestedEffort };
}

function prepareBackgroundSelection(request, detectEngineFn) {
  const model = request.model ?? null;
  const effort = request.effort ?? null;
  validateEffortLevel(effort);
  if (!model && !effort) return { model, effort };
  return prepareEngineSelection(
    detectEngineFn(request.engine ?? null),
    model,
    effort
  );
}

export function dispatchBackgroundReview(request, { spawnFn = spawn, detectEngineFn = detectEngine } = {}) {
  const cwd = path.resolve(request.cwd ?? process.cwd());
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const selection = prepareBackgroundSelection(request, detectEngineFn);
  const reviewName = request.reviewName ?? "Review";
  const templateName = request.templateName ?? "review";
  ensureGitRepository(cwd);
  const target = resolveReviewTarget(cwd, { base: request.base, scope: request.scope });
  const kind = templateName === "adversarial-review" ? "adversarial-review" : "review";
  const job = createCompanionJob({
    prefix: "review",
    kind,
    title: `Gemini ${reviewName}`,
    workspaceRoot,
    jobClass: "review",
    summary: `${reviewName} ${target.label}`,
    engine: request.engine,
    groupId: request.groupId
  });
  const storedRequest = buildReviewRequest({
    cwd,
    base: request.base,
    scope: request.scope,
    model: selection.model,
    effort: selection.effort,
    engine: request.engine,
    focusText: request.focusText ?? "",
    reviewName,
    templateName,
    deep: request.deep,
    preparedReview: request.preparedReview
  });
  return enqueueBackgroundJob(cwd, job, storedRequest, "review-worker", { spawnFn }).payload;
}

export function dispatchAdversarialReview(request, {
  spawnFn = spawn,
  detectEngineFn = detectEngine,
  stderr = process.stderr
} = {}) {
  const engineValues = Array.isArray(request.engines) ? request.engines : String(request.engines ?? "").split(",");
  const requestedEngines = [...new Set(engineValues.map((engine) => String(engine).trim().toLowerCase()).filter(Boolean))];
  if (requestedEngines.length === 0) throw new Error("--engines requires at least one engine.");
  const invalid = requestedEngines.filter((engine) => engine !== "gemini" && engine !== "agy");
  if (invalid.length > 0) throw new Error(`Unknown review engine: ${invalid.join(", ")}. Valid engines: gemini, agy.`);

  const available = [];
  const unavailable = [];
  for (const engine of requestedEngines) {
    try {
      available.push({ engine, info: detectEngineFn(engine) });
    } catch (error) {
      unavailable.push({ engine, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (available.length === 0) {
    throw new Error(`None of the requested review engines are available: ${unavailable.map(({ engine, error }) => `${engine} (${error})`).join("; ")}.`);
  }

  const availableEngines = available.map(({ engine }) => engine);
  if (availableEngines.length > 1 && request.model != null) {
    throw new Error("--model cannot be used with --engines gemini,agy because model IDs are engine-specific. Run separate reviews with --engine.");
  }

  const warning = unavailable.length > 0
    ? `Adversarial review degraded to ${availableEngines.join(", ")}; unavailable: ${unavailable.map(({ engine }) => engine).join(", ")}.`
    : null;
  if (warning) stderr.write(`${warning}\n`);

  const groupId = available.length > 1 ? generateJobId("review-group") : null;
  const preparedReview = groupId ? buildReviewPrompt({
    ...request,
    cwd: path.resolve(request.cwd ?? process.cwd()),
    reviewName: "Adversarial Review",
    templateName: "adversarial-review"
  }) : null;
  // Validate every selected engine before the first detached worker is spawned.
  // Otherwise a later validation error can orphan an earlier group member.
  const preparedSelections = available.map(({ engine, info }) => ({
    engine,
    selection: prepareEngineSelection(info, request.model, request.effort)
  }));
  const jobs = preparedSelections.map(({ engine, selection }) => dispatchBackgroundReview({
    ...request,
    ...selection,
    engine,
    groupId,
    preparedReview,
    reviewName: "Adversarial Review",
    templateName: "adversarial-review"
  }, { spawnFn, detectEngineFn }));
  return {
    groupId,
    jobIds: jobs.map((job) => job.jobId),
    jobs,
    engines: availableEngines,
    unavailableEngines: unavailable.map(({ engine }) => engine),
    degraded: unavailable.length > 0,
    warning
  };
}

function renderQueuedReviewGroupLaunch(payload) {
  return `Gemini adversarial review group ${payload.groupId} started in the background (${payload.engines.join(", ")}). Check /gemini:status ${payload.groupId} for progress.\n`;
}

export function dispatchBackgroundTask(request, { spawnFn = spawn, detectEngineFn = detectEngine } = {}) {
  const cwd = path.resolve(request.cwd ?? process.cwd());
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const { model, effort } = prepareBackgroundSelection(request, detectEngineFn);
  const prompt = request.prompt ?? "";
  const resumeLast = Boolean(request.resumeLast);
  requireTaskRequest(prompt, resumeLast);
  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast });
  const job = buildTaskJob(workspaceRoot, taskMetadata, Boolean(request.write));
  const storedRequest = buildTaskRequest({
    cwd,
    model,
    effort,
    engine: request.engine ?? null,
    prompt,
    write: Boolean(request.write),
    resumeLast,
    jobId: job.id
  });
  return enqueueBackgroundJob(cwd, job, storedRequest, "task-worker", { spawnFn }).payload;
}

async function handleReviewCommand(argv, { reviewName, templateName, supportsFocus, supportsEngines = false }) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "engine", "cwd", ...(supportsEngines ? ["engines"] : [])],
    booleanOptions: ["json", "wait", "background", "deep"],
    aliasMap: { m: "model" }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = supportsFocus ? positionals.join(" ").trim() : "";
  validateEffortLevel(options.effort);

  if (supportsEngines && options.engines != null) {
    if (options.engine != null) throw new Error("Choose either --engine or --engines, not both.");
    if (options.wait) throw new Error("--engines dispatches background jobs and cannot be combined with --wait.");
    const dispatch = dispatchAdversarialReview({
      cwd,
      base: options.base,
      scope: options.scope,
      model: options.model,
      effort: options.effort ?? null,
      engines: String(options.engines).split(","),
      focusText,
      deep: options.deep
    });
    if (dispatch.groupId) {
      const payload = {
        groupId: dispatch.groupId,
        jobIds: dispatch.jobIds,
        status: "queued",
        engines: dispatch.engines
      };
      outputCommandResult(payload, renderQueuedReviewGroupLaunch(payload), options.json);
    } else {
      const payload = dispatch.jobs[0];
      outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    }
    return;
  }

  if (options.background) {
    // Persist the review to a detached review-worker so the result survives an
    // interrupted Claude session (parity with background tasks). Returns a job id
    // immediately; track via /gemini:status and /gemini:result.
    const payload = dispatchBackgroundReview({
      cwd,
      base: options.base,
      scope: options.scope,
      model: options.model,
      effort: options.effort ?? null,
      engine: options.engine,
      focusText,
      reviewName,
      templateName,
      deep: options.deep
    });
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  ensureGitRepository(cwd);
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const kind = templateName === "adversarial-review" ? "adversarial-review" : "review";
  const job = createCompanionJob({
    prefix: "review",
    kind,
    title: `Gemini ${reviewName}`,
    workspaceRoot,
    jobClass: "review",
    summary: `${reviewName} ${target.label}`
  });

  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        target,
        base: options.base,
        scope: options.scope,
        model: options.model,
        effort: options.effort ?? null,
        engine: options.engine,
        focusText,
        reviewName,
        templateName,
        deep: options.deep,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, { reviewName: "Review", templateName: "review", supportsFocus: false });
}

async function handleAdversarialReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Adversarial Review",
    templateName: "adversarial-review",
    supportsFocus: true,
    supportsEngines: true
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "engine", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: { m: "model" }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = options.model ?? null;
  const engine = options.engine ?? null;
  validateEffortLevel(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast });

  if (options.background) {
    const payload = dispatchBackgroundTask({
      cwd,
      model: options.model,
      effort: options.effort ?? null,
      engine,
      prompt,
      write,
      resumeLast
    });
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort: options.effort ?? null,
        engine,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

// Shared worker body for the detached `task-worker` / `review-worker` subcommands:
// load the persisted job, deserialize its request, and run the matching executor
// under runTrackedJob (which records running/completed/failed state + result).
async function runStoredJobWorker(argv, { executor, label }) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error(`Missing required --job-id for ${label}.`);
  }

  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executor({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleTaskWorker(argv) {
  return runStoredJobWorker(argv, { executor: executeTaskRun, label: "task-worker" });
}

async function handleReviewWorker(argv) {
  return runStoredJobWorker(argv, { executor: executeReviewRun, label: "review-worker" });
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(
      snapshot,
      snapshot.groupId ? renderJobGroupStatusReport(snapshot) : renderJobStatusReport(snapshot.job),
      options.json
    );
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

export function getJobStatus({ cwd = process.cwd(), jobId }) {
  return buildSingleJobSnapshot(path.resolve(cwd), jobId);
}

export function getJobResult({ cwd = process.cwd(), jobId, all = false }) {
  const resolved = resolveResultJobs(path.resolve(cwd), jobId, { all });
  if (resolved.groupId) {
    return {
      groupId: resolved.groupId,
      results: resolved.jobs.map((job) => ({ job, storedJob: readStoredJob(resolved.workspaceRoot, job.id) }))
    };
  }
  return { job: resolved.job, storedJob: readStoredJob(resolved.workspaceRoot, resolved.job.id) };
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "all"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const payload = getJobResult({ cwd, jobId: reference, all: options.all });

  outputCommandResult(
    payload,
    payload.groupId ? renderStoredJobGroupResult(payload) : renderStoredJobResult(payload.job, payload.storedJob),
    options.json
  );
}

async function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  // Resume candidates are scoped to the current Claude session by default.
  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot)));
  const activeTask = jobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    // `available` mirrors upstream codex-companion (rescue.md keys off it). Do not
    // rename to `found` — commands/rescue.md asks the agent to read `available`.
    const payload = { available: false, blocked: true, activeJobId: activeTask.id };
    outputResult(
      options.json ? payload : `Task ${activeTask.id} is still running. Use /gemini:status before resuming.\n`,
      options.json
    );
    return;
  }
  const candidate = jobs.find((job) => job.jobClass === "task" && job.status === "completed" && job.threadId);
  const payload = candidate
    ? { available: true, jobId: candidate.id, threadId: candidate.threadId, title: candidate.title }
    : { available: false };
  outputResult(
    options.json ? payload : (candidate ? `Resume candidate: ${candidate.id} — ${candidate.title}\n` : "No resume candidate found.\n"),
    options.json
  );
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "all"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { payload, job, termination } = cancelJob({ cwd, jobId: reference, all: options.all });

  outputCommandResult(payload, renderCancelReport(job, termination), options.json);
}

export function cancelJob({ cwd = process.cwd(), jobId = "", all = false }, { terminateProcessTreeFn = terminateProcessTree } = {}) {
  const { workspaceRoot, job } = resolveCancelableJob(path.resolve(cwd), jobId, { all });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};

  // Be honest about whether a live process was actually killed: the detached
  // worker is unref()-ed, so by cancel time its PID may already be gone. The job
  // is still marked cancelled (the user's intent is recorded) in every case.
  const termination = terminateProcessTreeFn(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, `Cancelled by user — ${describeTermination(termination)}.`);

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    processTerminated: termination.delivered
  };

  return { payload, job: nextJob, termination };
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleAdversarialReview(argv);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "review-worker":
      await handleReviewWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "task-resume-candidate":
      await handleTaskResumeCandidate(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

if (process.argv[1] === SELF_PATH) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
