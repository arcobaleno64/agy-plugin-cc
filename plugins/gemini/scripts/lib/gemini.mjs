import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { buildCliArgs, detectEngine, formatAgyTimeout, mapEffortToModel, normalizeAgyEffort, normalizeAgyRequestedModel, normalizeRequestedModel, supportsAgyModelSelection, supportsAgyReadOnlySlashCommands, supportsAgyStdinPrompt, supportsAgyStructuredOutput } from "./engine.mjs";
import { classifyCliFailure } from "./failures.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";
import { resolveAgyBrainRoot, listConvDirs, recoverAgyResponse } from "./agy-transcript.mjs";

const DEFAULT_SPAWN_TIMEOUT_MS = 600_000; // 10 minutes (gemini)
// AGY's `agy --print` does not stream its response over a pipe in non-interactive
// use (verified empty stdout / hang on 1.0.3), so a 10-minute spawn would simply
// hang silently. Cap AGY far shorter so the plugin fails fast instead. This also
// feeds AGY's own `--print-timeout` via buildCliArgs.
const AGY_SPAWN_TIMEOUT_MS = 120_000; // 2 minutes
// How much earlier AGY's own --print-timeout lands, so it self-terminates and
// flushes its final transcript row before spawnSync SIGKILLs it.
const AGY_FLUSH_GRACE_MS = 15_000;
const MAX_BUFFER = 50 * 1024 * 1024; // 50 MB

// `--timeout <seconds>`. AGY's 2-minute default is this plugin's, not AGY's
// (AGY itself defaults --print-timeout to 5m): it was chosen to fail fast when
// `agy --print` returned nothing over a pipe, and it doubles as a hard ceiling
// on output size, since a turn producing more than it can emit in two minutes is
// killed with nothing to show. A user batching work has no way to raise it and
// no signal that size is what they are hitting.
//
// Bounded rather than free: below 30s no engine finishes, and the upper bound
// keeps a wedged background job inside the 6-hour stale-job reconcile.
export const MIN_TURN_TIMEOUT_SECONDS = 30;
export const MAX_TURN_TIMEOUT_SECONDS = 3600;

export function resolveSpawnTimeoutMs(engine, requestedSeconds = null) {
  if (requestedSeconds != null) {
    return Number(requestedSeconds) * 1000;
  }
  return engine === "agy" ? AGY_SPAWN_TIMEOUT_MS : DEFAULT_SPAWN_TIMEOUT_MS;
}

// The grace window has to scale with the timeout, not sit at a fixed 15s: at the
// documented minimum (`--timeout 30`) a flat subtraction floored at 30s left
// --print-timeout equal to the spawn timeout, so AGY's self-terminate landed on
// the same tick as spawnSync's SIGKILL and it was killed with empty stdout —
// exactly the failure the minute-rounding in formatAgyTimeout used to cause.
// Capping the grace at a quarter of the budget keeps the full 15s for every
// timeout above a minute while still leaving a real window below it.
export function resolveAgyPrintTimeoutMs(spawnTimeoutMs) {
  const grace = Math.min(AGY_FLUSH_GRACE_MS, Math.floor(spawnTimeoutMs / 4));
  return Math.max(1_000, spawnTimeoutMs - grace);
}

// Stable GA model served by every gemini CLI we target (verified on 0.44.1). Used
// as the graceful-degradation target when a requested model id is not found.
const GA_FALLBACK_MODEL = "gemini-2.5-flash";

// Detect a "model not found" failure from the gemini CLI so the plugin can fall
// back instead of hard-failing. The CLI surfaces this as `ModelNotFoundError` /
// `code: 404` on stderr and, with --output-format json, an envelope carrying
// `{ error: { message: "Requested entity was not found." } }` instead of
// `response`. Preview/retired ids and CLI-version skew are the common triggers.
// Scoped narrowly to
// model-not-found so auth/quota errors are NOT silently retried.
function isModelNotFoundError(rawStdout, rawStderr, parsedEnvelope = null) {
  const text = `${rawStdout ?? ""}\n${rawStderr ?? ""}`;
  if (/ModelNotFoundError|Requested entity was not found/i.test(text)) {
    return true;
  }
  const errMessage = parsedEnvelope?.error?.message;
  return typeof errMessage === "string" && /not found|not_found/i.test(errMessage);
}

function stripAnsi(str) {
  return String(str ?? "").replace(/\x1B\[[0-9;]*[mGKHF]/g, "");
}

function extractTouchedFiles(text) {
  const matches = text.match(/\b[\w./\\-]+\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|c|h|json|yaml|yml|toml|md|sh|bash)\b/g);
  if (!matches) return [];
  return [...new Set(matches)];
}

// CLI noise that must never surface as model "reasoning": Node deprecation
// warnings, terminal-capability notices, and ripgrep fallbacks. Filtered BEFORE
// the last-N slice so genuine reasoning is not evicted by trailing noise.
const REASONING_NOISE = [
  /^\(node:\d+\)/,
  /DeprecationWarning/i,
  // Narrowed to Node's canonical `(node:NNN) [DEPxxx]` preamble so a genuine
  // reasoning line that merely contains a bracketed `[DEP12]`-style token is not
  // stripped as noise (lines are trimmed before this test, so ^ is safe).
  /^\(node:\d+\)\s+\[DEP\d+\]/,
  /--trace-deprecation/,
  /256-color support not detected/i,
  /Using a terminal with at least 256-color/i,
  /true color/i,
  /Ripgrep is not available/i,
  /Falling back to GrepTool/i
];

function isReasoningNoise(line) {
  return REASONING_NOISE.some((re) => re.test(line));
}

function extractReasoningSummary(stderr) {
  const lines = stripAnsi(String(stderr ?? ""))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !isReasoningNoise(l));
  if (!lines.length) return null;
  return lines.slice(-5).join("\n");
}

function stripControlChars(str) {
  // Strip C0 control chars (keep tab/newline/CR). Some gemini CLI builds emit
  // control tokens / thought markers around the JSON that break JSON.parse.
  return String(str ?? "").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function extractBalancedJsonObjects(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
}

export function tryParseJsonFromText(text) {
  const cleaned = stripControlChars(text);
  // 1. Direct parse of the whole payload.
  try { return JSON.parse(cleaned.trim()); } catch {}
  // 2. Some CLI versions prepend a non-JSON preamble (e.g. `update_topic{...}`)
  //    before the real object. Scan for balanced top-level {...} blocks and
  //    return the LAST one that parses.
  const candidates = extractBalancedJsonObjects(cleaned);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try { return JSON.parse(candidates[i]); } catch {}
  }
  return null;
}

// AGY >=1.1.8 emits one JSON envelope on stdout:
//   {conversation_id, status: "SUCCESS"|"ERROR", response, error?, duration_seconds,
//    num_turns, usage{...}}
// Unparseable output on this path is a malformed run, not a reason to fall back
// to the transcript — the version already promised an envelope.
//
// That reasoning holds for output that arrived and made no sense. It does not
// cover output that never arrived: when the hard spawn timeout SIGKILLs agy,
// stdout is *empty*, and "the version promised an envelope" says nothing about a
// process that was killed before it could print one. The turn ran and was
// billed, and its response is on disk in the transcript. So an empty stdout —
// and only an empty one — now falls back to the recovery the pre-1.1.8 path
// already performs. See resolveAgyStructuredResult.
function readAgyEnvelope(rawStdout) {
  const parsed = tryParseJsonFromText(rawStdout);
  if (!parsed || typeof parsed !== "object") return null;
  // A terminal status plus a payload slot is what identifies the envelope.
  // Do not require a specific status value: only SUCCESS and ERROR have been
  // observed, and whether that vocabulary is closed is an open question with
  // upstream (antigravity-cli#546). Treat anything other than SUCCESS as failure.
  if (typeof parsed.status !== "string" || !parsed.status) return null;
  if (!("response" in parsed) && !("error" in parsed)) return null;
  // conversation_id is "" on the observed ERROR envelope and may be absent
  // altogether; it identifies the conversation, not the envelope.
  if (parsed.conversation_id != null && typeof parsed.conversation_id !== "string") return null;
  return parsed;
}

// Shared by the task and review paths: turns the envelope into the neutral pieces
// both need. The caller decides what to do with `text`.
function resolveAgyStructuredResult({ rawStdout, rawStderr, exitCode, result, engineInfo, brainRoot = null, conversationsBefore = null }) {
  const envelope = readAgyEnvelope(rawStdout);
  const failedExit = exitCode === 0 ? 1 : exitCode;

  if (!envelope) {
    // Empty stdout, not merely unparseable stdout: agy was killed before it
    // could print. The turn still ran and was still billed, and agy writes its
    // response to the transcript as it goes, so that file is the only surviving
    // copy — the pre-1.1.8 path already knows how to read it. Output that did
    // arrive and failed to parse is a malformed run and keeps failing, because
    // there the promise of an envelope really was broken.
    const killedBeforePrinting = !String(rawStdout).trim();
    const recovered = brainRoot && killedBeforePrinting ? recoverAgyResponse(brainRoot, conversationsBefore) : null;
    if (recovered?.response) {
      if (!recovered.confident) {
        process.stderr.write(
          `[gemini-companion] Warning: AGY returned no envelope and the recovered transcript match is not certain (${recovered.reason}). Verify the response corresponds to this run.\n`
        );
      }
      return {
        text: String(recovered.response).trim(),
        threadId: recovered.convDir ?? null,
        // A completed transcript row means the work finished even though the
        // envelope never made it out; an incomplete one is partial output, which
        // is worth returning but not worth calling success.
        exitCode: recovered.done ? 0 : failedExit,
        failure: recovered.done
          ? (recovered.failure ?? null)
          : classifyCliFailure({
              engine: engineInfo.engine,
              status: failedExit,
              signal: result.signal,
              error: result.error,
              stdout: rawStdout,
              stderr: rawStderr,
              transcriptReason: recovered.reason
            }),
        recoveredFromTranscript: true
      };
    }

    return {
      text: null,
      threadId: null,
      exitCode: failedExit,
      failure: classifyCliFailure({
        engine: engineInfo.engine,
        status: failedExit,
        signal: result.signal,
        error: result.error,
        stdout: rawStdout,
        stderr: rawStderr,
        invalidJson: true,
        noOutput: !String(rawStdout).trim()
      })
    };
  }

  const text = typeof envelope.response === "string" ? envelope.response.trim() : "";
  const succeeded = envelope.status === "SUCCESS" && Boolean(text);

  return {
    text,
    threadId: typeof envelope.conversation_id === "string" && envelope.conversation_id ? envelope.conversation_id : null,
    exitCode: succeeded ? 0 : failedExit,
    failure: succeeded
      ? null
      : classifyCliFailure({
          engine: engineInfo.engine,
          status: failedExit,
          signal: result.signal,
          error: result.error,
          // AGY's structured `error` carries the rate-limit and model-unavailable
          // wording the classifier already matches on, and stderr is empty here.
          stdout: envelope.error ?? rawStdout,
          stderr: envelope.error ?? rawStderr,
          noOutput: !text
        })
  };
}

// The third parameter mirrors dispatchBackgroundTask's { spawnFn, detectEngineFn }
// seam. It exists so the engine-response logic can be exercised without a real
// binary: the Windows AGY stand-in must be an absolute .exe (CVE-2024-27980), so
// a fixture there cannot report a chosen version, and spawn-driven tests cost
// ~150s per suite against ~0.2s for direct calls.
export async function runGeminiTurn(cwd, options = {}, { runCommandFn = runCommand, detectEngineFn = detectEngine } = {}) {
  const { prompt, effort: requestedEffort, write = true, resumeLast = false, engine: requestedEngine, timeoutSeconds = null, onProgress } = options;
  let { model } = options;
  let effort = requestedEffort;

  onProgress?.({ message: "Detecting engine...", phase: "starting" });

  const engineInfo = detectEngineFn(requestedEngine ?? null);

  if (engineInfo.engine === "agy") {
    if (model || effort) {
      if (!supportsAgyModelSelection(engineInfo.version)) {
        throw new Error(`AGY ${engineInfo.version} does not support --model/--effort. AGY 1.1.5 through 1.1.9 accept the flags but ignore them in headless runs. Upgrade to AGY 1.1.10 or newer, or select --engine gemini.`);
      }
      model = normalizeAgyRequestedModel(model);
      effort = normalizeAgyEffort(effort);
    }
  } else {
    if (!model && effort) {
      model = mapEffortToModel(effort);
    }
    model = normalizeRequestedModel(model) ?? model;
  }

  // Gemini always uses stdin. AGY auto-enters print mode from stdin starting at
  // 1.1.2; unknown/older versions keep the positional compatibility path.
  const useStdin = engineInfo.engine === "gemini"
    || (engineInfo.engine === "agy" && supportsAgyStdinPrompt(engineInfo.version));
  const agyStructured = engineInfo.engine === "agy" && supportsAgyStructuredOutput(engineInfo.version);
  const useJson = engineInfo.engine === "gemini" || agyStructured;
  const spawnTimeoutMs = resolveSpawnTimeoutMs(engineInfo.engine, timeoutSeconds);

  // AGY >=1.1.8 returns the response, conversation id, and terminal status in a
  // stdout envelope. Older versions surface none of them reliably, so they need
  // the conversation dirs snapshotted BEFORE the spawn to identify the new one
  // afterwards.
  //
  // Structured runs snapshot too, even though they normally never read it: when
  // the envelope is missing the turn has still run and been billed, and the
  // transcript on disk is the only remaining copy of what it produced. Costs one
  // readdir. Give agy's own --print-timeout a shorter window than the hard spawn
  // kill either way, so agy self-terminates and flushes before SIGKILL.
  let agyBrainRoot = null;
  let agyBefore = null;
  let agyPrintTimeoutMs = spawnTimeoutMs;
  if (engineInfo.engine === "agy") {
    agyBrainRoot = resolveAgyBrainRoot();
    agyBefore = listConvDirs(agyBrainRoot);
    agyPrintTimeoutMs = resolveAgyPrintTimeoutMs(spawnTimeoutMs);
  }

  const args = buildCliArgs(engineInfo.engine, {
    prompt,
    model,
    effort,
    write,
    resumeLast,
    timeoutMs: engineInfo.engine === "agy" ? agyPrintTimeoutMs : spawnTimeoutMs,
    agyVersion: engineInfo.version,
    useStdin,
    outputJson: useJson,
    // Orients a read-only AGY turn on this repository. A write turn is already
    // oriented by --new-project; buildCliArgs picks between them.
    workspaceDir: cwd,
  });

  onProgress?.({ message: `Starting ${engineInfo.engine} turn...`, phase: "running" });

  const result = runCommandFn(engineInfo.binary, args, {
    cwd,
    input: useStdin ? prompt : undefined,
    maxBuffer: MAX_BUFFER,
    timeout: spawnTimeoutMs, // hard kill — grace-later than agy's --print-timeout
  });

  let rawStdout = stripAnsi(result.stdout ?? "");
  let rawStderr = stripAnsi(result.stderr ?? "");
  let exitCode = result.status ?? (result.error ? 1 : 0);
  let modelFallbackNote = null;

  // Graceful degradation (gemini engine): a requested model id that is not found
  // (preview/retired, or absent on this CLI version) retries ONCE on the GA
  // fallback so the task still runs instead of hard-failing. agy has no model
  // selection so this never applies to it.
  if (engineInfo.engine === "gemini" && model && model !== GA_FALLBACK_MODEL && isModelNotFoundError(rawStdout, rawStderr, tryParseJsonFromText(rawStdout))) {
    process.stderr.write(`[gemini-companion] Model '${model}' is unavailable on this gemini CLI (model-not-found); retrying task on GA fallback '${GA_FALLBACK_MODEL}'.\n`);
    const fbArgs = buildCliArgs("gemini", {
      prompt,
      model: GA_FALLBACK_MODEL,
      write,
      resumeLast,
      timeoutMs: spawnTimeoutMs,
      useStdin,
      outputJson: useJson,
    });
    const fbResult = runCommandFn(engineInfo.binary, fbArgs, { cwd, input: useStdin ? prompt : undefined, maxBuffer: MAX_BUFFER, timeout: spawnTimeoutMs });
    rawStdout = stripAnsi(fbResult.stdout ?? "");
    rawStderr = stripAnsi(fbResult.stderr ?? "");
    exitCode = fbResult.status ?? (fbResult.error ? 1 : 0);
    modelFallbackNote = `Requested model '${model}' was unavailable on this gemini CLI; task ran on the GA fallback '${GA_FALLBACK_MODEL}'.`;
  }

  let finalMessage = rawStdout.trim();
  let threadId = null;
  let reasoningSummary = extractReasoningSummary(rawStderr) ?? null;
  let recoveryFailure = null;

  if (agyStructured) {
    const structured = resolveAgyStructuredResult({ rawStdout, rawStderr, exitCode, result, engineInfo, brainRoot: agyBrainRoot, conversationsBefore: agyBefore });
    exitCode = structured.exitCode;
    recoveryFailure = structured.failure;
    threadId = structured.threadId;
    if (structured.text) finalMessage = structured.text;
  } else if (engineInfo.engine === "agy") {
    // Pre-1.1.8: recover the authoritative response and conversation id by
    // diffing the transcript directories captured before/after the spawn.
    const rec = recoverAgyResponse(agyBrainRoot, agyBefore);
    if (!rec.response) {
      if (exitCode === 0) exitCode = 1;
      recoveryFailure = classifyCliFailure({
        engine: engineInfo.engine,
        status: exitCode,
        signal: result.signal,
        error: result.error,
        stdout: rawStdout,
        stderr: rawStderr,
        transcriptReason: rec.reason,
        noOutput: !finalMessage
      });
    } else {
      recoveryFailure = rec.failure ?? null;
      if (!rec.confident) {
        process.stderr.write(`[gemini-companion] Warning: AGY transcript match is not certain (${rec.reason}). Verify the response corresponds to this run.\n`);
      }
      finalMessage = String(rec.response).trim();
      threadId = rec.convDir ?? null; // agy conversation id — resume via --conversation <id>
      reasoningSummary = rec.thinking ?? reasoningSummary;
      // Success is defined by a completed transcript row, not the (often killed)
      // exit code: agy frequently hangs until --print-timeout even on success.
      if (rec.done) exitCode = 0;
      else if (exitCode === 0) exitCode = 1; // recovered but truncated → signal partial
    }
  } else if (useJson) {
    // For gemini engine with JSON output, extract response text and session_id
    const outer = tryParseJsonFromText(rawStdout);
    if (outer) {
      threadId = typeof outer.session_id === "string" ? outer.session_id : null;
      const responseText = (typeof outer.response === "string" ? outer.response : outer?.response?.text) ?? rawStdout;
      finalMessage = responseText.trim();
    }
  }

  if (!finalMessage && exitCode === 0) {
    exitCode = 1;
  }

  const touchedFiles = extractTouchedFiles(finalMessage);
  const failure = recoveryFailure ?? (exitCode !== 0 || !finalMessage
    ? classifyCliFailure({
        engine: engineInfo.engine,
        status: exitCode,
        signal: result.signal,
        error: result.error,
        stdout: finalMessage || rawStdout,
        stderr: rawStderr,
        noOutput: !finalMessage
      })
    : null);

  onProgress?.({ message: exitCode === 0 ? "Turn completed." : "Turn failed.", phase: exitCode === 0 ? "done" : "failed" });

  return {
    status: exitCode,
    finalMessage,
    threadId,
    reasoningSummary,
    touchedFiles,
    engine: engineInfo.engine,
    stderr: rawStderr,
    modelFallback: modelFallbackNote,
    ...(failure ? { failure } : {})
  };
}

// Same injection seam as runGeminiTurn; see the note there.
export async function runGeminiReview(cwd, options = {}, { runCommandFn = runCommand, detectEngineFn = detectEngine } = {}) {
  const { prompt, model: requestedModel, effort: requestedEffort, engine: requestedEngine, isAdversarial = true, timeoutSeconds = null, onProgress } = options;

  // Mode-aware label: the standard /review and adversarial /adversarial-review
  // share this runner, so the progress line must reflect the actual mode.
  onProgress?.({ message: `Starting ${isAdversarial ? "adversarial review" : "review"}...`, phase: "reviewing" });

  // Same engine selection as a task: whatever the user asked for, else `auto`.
  //
  // This used to pass "gemini" as the default, which made an unspecified engine
  // look like an explicit request — and an explicit request deliberately skips
  // the credential check, because a user naming an engine should get that engine
  // or a clear error. So a gemini CLI that was installed but unauthenticated was
  // selected here and failed every review, while a working AGY sat beside it.
  // Only a *missing* gemini binary reached the fallback.
  //
  // The reason for the preference is also gone: it was "prefer gemini for JSON
  // output", true when only gemini could emit structured output. AGY has carried
  // the same JSON envelope since 1.1.8 (plugin v0.11.0).
  const engineInfo = detectEngineFn(requestedEngine ?? null);
  const agyStructured = engineInfo.engine === "agy" && supportsAgyStructuredOutput(engineInfo.version);
  const useJson = engineInfo.engine === "gemini" || agyStructured;

  let model;
  let effort = null;
  if (engineInfo.engine === "agy") {
    if (requestedModel || requestedEffort) {
      if (!supportsAgyModelSelection(engineInfo.version)) {
        throw new Error(`AGY ${engineInfo.version} does not support --model/--effort. AGY 1.1.5 through 1.1.9 accept the flags but ignore them in headless runs. Upgrade to AGY 1.1.10 or newer, or select --engine gemini.`);
      }
      model = normalizeAgyRequestedModel(requestedModel);
      effort = normalizeAgyEffort(requestedEffort);
    }
  } else {
    if (!requestedModel && requestedEffort) {
      model = mapEffortToModel(requestedEffort);
    }
    model = normalizeRequestedModel(model ?? requestedModel) ?? "gemini-2.5-flash";
  }

  const useStdin = engineInfo.engine === "gemini"
    || (engineInfo.engine === "agy" && supportsAgyStdinPrompt(engineInfo.version));
  const spawnTimeoutMs = resolveSpawnTimeoutMs(engineInfo.engine, timeoutSeconds);

  // AGY >=1.1.8 returns the review in a stdout envelope. Older versions need the
  // transcript, and structured runs snapshot it too so a killed run's already-
  // billed output can still be recovered (see resolveAgyStructuredResult).
  // Either way, give agy's --print-timeout a grace window shorter than the hard
  // spawn kill so it flushes before SIGKILL.
  let agyBrainRoot = null;
  let agyBefore = null;
  let agyPrintTimeoutMs = spawnTimeoutMs;
  if (engineInfo.engine === "agy") {
    agyBrainRoot = resolveAgyBrainRoot();
    agyBefore = listConvDirs(agyBrainRoot);
    agyPrintTimeoutMs = resolveAgyPrintTimeoutMs(spawnTimeoutMs);
  }

  const args = buildCliArgs(engineInfo.engine, {
    prompt,
    model,
    effort,
    // Read-only: no --yolo, and deliberately no --approval-mode plan either.
    // buildCliArgs explains why plan mode is the weaker read-only shape.
    write: false,
    outputJson: useJson,
    timeoutMs: engineInfo.engine === "agy" ? agyPrintTimeoutMs : spawnTimeoutMs,
    agyVersion: engineInfo.version,
    useStdin,
  });

  const result = runCommandFn(engineInfo.binary, args, {
    cwd,
    input: useStdin ? prompt : undefined,
    maxBuffer: MAX_BUFFER,
    timeout: spawnTimeoutMs, // hard kill — grace-later than agy's --print-timeout
  });

  let rawStdout = stripAnsi(result.stdout ?? "");
  let rawStderr = stripAnsi(result.stderr ?? "");
  let exitCode = result.status ?? (result.error ? 1 : 0);
  let modelFallbackNote = null;

  // Graceful degradation (gemini engine): if the requested model id is not found
  // (preview/retired, or absent on this CLI version), retry ONCE on the GA
  // fallback so the user still gets a review instead of a hard failure — and
  // surface the substitution loudly.
  if (engineInfo.engine === "gemini" && model && model !== GA_FALLBACK_MODEL && isModelNotFoundError(rawStdout, rawStderr, tryParseJsonFromText(rawStdout))) {
    process.stderr.write(`[gemini-companion] Model '${model}' is unavailable on this gemini CLI (model-not-found); retrying review on GA fallback '${GA_FALLBACK_MODEL}'.\n`);
    const fbArgs = buildCliArgs("gemini", {
      prompt,
      model: GA_FALLBACK_MODEL,
      write: false,
      outputJson: useJson,
      timeoutMs: spawnTimeoutMs,
      useStdin,
    });
    const fbResult = runCommandFn(engineInfo.binary, fbArgs, { cwd, input: useStdin ? prompt : undefined, maxBuffer: MAX_BUFFER, timeout: spawnTimeoutMs });
    rawStdout = stripAnsi(fbResult.stdout ?? "");
    rawStderr = stripAnsi(fbResult.stderr ?? "");
    exitCode = fbResult.status ?? (fbResult.error ? 1 : 0);
    modelFallbackNote = `Requested model '${model}' was unavailable on this gemini CLI; review ran on the GA fallback '${GA_FALLBACK_MODEL}'.`;
  }

  let reasoningSummary = extractReasoningSummary(rawStderr) ?? null;

  let reviewJson = null;
  let reviewText = rawStdout.trim();
  let recoveryFailure = null;

  if (agyStructured) {
    const structured = resolveAgyStructuredResult({ rawStdout, rawStderr, exitCode, result, engineInfo, brainRoot: agyBrainRoot, conversationsBefore: agyBefore });
    exitCode = structured.exitCode;
    recoveryFailure = structured.failure;
    if (structured.text) {
      reviewText = structured.text;
      reviewJson = tryParseJsonFromText(reviewText);
    }
  } else if (engineInfo.engine === "agy") {
    // Pre-1.1.8: recover the authoritative review and parse JSON findings from it.
    const rec = recoverAgyResponse(agyBrainRoot, agyBefore);
    if (!rec.response) {
      if (exitCode === 0) exitCode = 1;
      recoveryFailure = classifyCliFailure({
        engine: engineInfo.engine,
        status: exitCode,
        signal: result.signal,
        error: result.error,
        stdout: rawStdout,
        stderr: rawStderr,
        transcriptReason: rec.reason,
        noOutput: !reviewText
      });
    } else {
      recoveryFailure = rec.failure ?? null;
      if (!rec.confident) {
        process.stderr.write(`[gemini-companion] Warning: AGY transcript match is not certain (${rec.reason}). Verify the review corresponds to this run.\n`);
      }
      reviewText = String(rec.response).trim();
      reviewJson = tryParseJsonFromText(reviewText);
      reasoningSummary = rec.thinking ?? reasoningSummary;
      if (rec.done) exitCode = 0;
      else if (exitCode === 0) exitCode = 1; // recovered but truncated → signal partial
    }
  } else if (useJson) {
    // Gemini --output-format json wraps the response in an outer JSON envelope.
    // The text payload lives at different paths depending on CLI version:
    //   { response: "text..." }          — string (common with stdin delivery)
    //   { response: { text: "..." } }    — nested object (older format)
    //   { candidates[0].content... }     — raw API shape
    const outerParsed = tryParseJsonFromText(rawStdout);
    if (outerParsed) {
      const innerText =
        outerParsed?.response?.text ??
        (typeof outerParsed?.response === "string" ? outerParsed.response : null) ??
        outerParsed?.candidates?.[0]?.content?.parts?.[0]?.text ??
        outerParsed?.text ??
        rawStdout;
      reviewText = typeof innerText === "string" ? innerText.trim() : rawStdout;
      reviewJson = tryParseJsonFromText(reviewText);
    } else {
      reviewJson = tryParseJsonFromText(rawStdout);
    }
  } else {
    reviewJson = tryParseJsonFromText(rawStdout);
  }

  if (!reviewText && exitCode === 0) {
    exitCode = 1;
  }

  const failure = recoveryFailure ?? (exitCode !== 0 || !reviewText || !reviewJson
    ? classifyCliFailure({
        engine: engineInfo.engine,
        status: exitCode,
        signal: result.signal,
        error: result.error,
        stdout: reviewText || rawStdout,
        stderr: rawStderr,
        noOutput: !reviewText,
        invalidJson: Boolean(reviewText && !reviewJson)
      })
    : null);

  onProgress?.({ message: exitCode === 0 ? "Review completed." : "Review failed.", phase: exitCode === 0 ? "done" : "failed" });

  return {
    status: exitCode,
    reviewText,
    reviewJson,
    reasoningSummary,
    engine: engineInfo.engine,
    stderr: rawStderr,
    modelFallback: modelFallbackNote,
    ...(failure ? { failure } : {})
  };
}

// Transient gemini failures that warrant a retry of a READ-ONLY review: the CLI
// occasionally returns an empty / `Invalid stream` / malformed-tool-call envelope,
// or a transport-level rate-limit / unavailability — none deterministic. This is
// DISTINCT from model-not-found (handled inline by the GA fallback above): a
// transient flake produces no usable findings at all and is worth re-running.
//
// The signal is matched by CHANNEL to avoid false positives (both ANSI-stripped):
// the malformed-output ENVELOPE phrases never occur in a real review's prose, so we
// accept them on either stream (some builds emit the envelope on stdout with exit 0,
// others on stderr). The loose TRANSPORT words CAN legitimately appear in a review's
// prose (a review may discuss a "500" or "rate limit"), so we trust those only on
// stderr — where the model's review text never lands.
const ENVELOPE_REVIEW_RE = /invalid stream|malformed tool call|empty response|no response/i;
const TRANSPORT_REVIEW_RE = /resource[_ ]?exhausted|unavailable|deadline|temporarily|try again|rate.?limit|\b(429|500|502|503|504)\b|econnreset|socket hang|stream closed/i;

export function isTransientReviewFailure({ reviewJson, reviewText, stderr } = {}) {
  if (reviewJson != null) return false;                       // got structured findings — success
  const out = (reviewText ?? "").trim();
  const err = (stderr ?? "").trim();
  if (!out && !err) return true;                              // empty stdout+stderr — nothing usable
  if (ENVELOPE_REVIEW_RE.test(`${out}\n${err}`)) return true; // envelope — trusted on either channel
  if (TRANSPORT_REVIEW_RE.test(err)) return true;             // transport flake — trusted on stderr only
  return false;                                               // real non-transient output (e.g. prose review) — keep it
}

// Resilient wrapper around runGeminiReview: a READ-ONLY adversarial review is
// idempotent (no side effects), so a transient empty / `Invalid stream` envelope is
// safe to re-run. The gemini CLI flakes intermittently on this in practice
// (observed needing 2-3 attempts for the SAME input); retrying here removes that
// flakiness from the caller. agy is NOT retried — its transcript-recovery path and
// fail-fast timeout handle its distinct failure mode, and re-spawning it is costly.
// Composes with runGeminiReview's inline GA-fallback (model-not-found) retry: that
// fixes a deterministic wrong-model error within a single attempt; this re-runs the
// whole review only when no usable result came back at all.
export async function runGeminiReviewResilient(cwd, options = {}, { maxAttempts = 3 } = {}) {
  let last = null;
  let prevText = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await runGeminiReview(cwd, options);
    if (last.engine === "agy") return { ...last, attempts: attempt };
    if (!isTransientReviewFailure(last)) return { ...last, attempts: attempt };
    // Backstop for a residual stderr-side false positive: identical non-empty review
    // text across attempts is deterministic output that merely tripped the heuristic,
    // not a flake — keep it rather than burning the remaining retries on the same result.
    const text = (last.reviewText ?? "").trim();
    if (text && text === prevText) return { ...last, attempts: attempt };
    prevText = text;
    if (attempt < maxAttempts) {
      options.onProgress?.({ message: `Transient review failure (attempt ${attempt}/${maxAttempts}); retrying...`, phase: "reviewing" });
    }
  }
  return { ...last, attempts: maxAttempts, exhaustedTransientRetries: true };
}

export function getGeminiAvailability() {
  return binaryAvailable("gemini", ["--version"]);
}

export function getAgyAvailability() {
  return binaryAvailable("agy", ["--version"]);
}

// Moved to lib/gemini-auth.mjs so engine.mjs can consult credentials without an
// import cycle. Re-exported here because these are the existing public names.
export { getGeminiLoginStatus, getGeminiPlanTier, hasGeminiCredentials } from "./gemini-auth.mjs";

export function getAgyLoginStatus() {
  const status = binaryAvailable("agy", ["--version"]);
  if (!status.available) {
    return { loggedIn: false, state: "unavailable", verifiable: false, detail: "AGY binary not found." };
  }
  // AGY 1.1.x uses its own consumerOAuth flow and may store credentials in an
  // OS credential service. Gemini's ~/.gemini/oauth_creds.json is therefore not
  // evidence of AGY authentication. Keep `loggedIn` for JSON compatibility, but
  // pair it with an explicit unknown state so callers do not interpret it as a
  // verified logout.
  return {
    loggedIn: false,
    state: "unknown",
    verifiable: false,
    detail: `AGY ${status.detail ?? ""} present; authentication cannot be verified non-interactively. Run \`agy\` once interactively to authenticate or refresh credentials.`.trim(),
  };
}

// Non-interactive AGY authentication check. `getAgyLoginStatus` can only report
// "unknown", which left `/gemini:setup` telling the user to "run an `--engine
// agy` command to confirm it is logged in" — i.e. to spend a billed turn to
// learn whether they are logged in, and to read the answer out of whether it
// failed. This asks AGY a question only an authenticated account can answer and
// costs nothing: measured on 1.1.11, `num_turns: 0` and every token count zero.
//
// Opt-in (`setup --probe-agy`) rather than part of every setup run: it spawns
// AGY and takes ~5 seconds, and `setup` is otherwise a local inspection.
export const AGY_PROBE_TIMEOUT_MS = 30_000;

export function probeAgyLogin({ runCommandFn = runCommand, detectEngineFn = detectEngine } = {}) {
  // detectEngine resolves the binary the way every other AGY call does — on
  // Windows an absolute .exe spawned with shell:false (CVE-2024-27980), which
  // also keeps a shell from rewriting the probe's leading `/` into a path.
  let engineInfo;
  try {
    engineInfo = detectEngineFn("agy");
  } catch {
    return { loggedIn: false, state: "unavailable", verifiable: false, detail: "AGY binary not found." };
  }

  const version = engineInfo.version;
  if (!supportsAgyReadOnlySlashCommands(version)) {
    return {
      loggedIn: false,
      state: "unknown",
      verifiable: false,
      detail: `AGY ${version ?? "(unknown version)"} cannot be probed without spending a turn. Read-only slash commands in print mode arrived in AGY 1.1.11; below that, \`/quota\` is sent to the model as prompt text. Upgrade to probe, or run \`agy\` interactively once.`
    };
  }

  // Same grace window as a real turn: an equal --print-timeout would have AGY
  // self-terminate on the tick runCommand kills it, so a slow-but-authenticated
  // account would come back "unknown" instead of verified.
  const printTimeout = formatAgyTimeout(resolveAgyPrintTimeoutMs(AGY_PROBE_TIMEOUT_MS));
  const result = runCommandFn(engineInfo.binary, ["--print-timeout", printTimeout, "-p", "/quota", "--output-format", "json"], {
    timeout: AGY_PROBE_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER
  });
  const envelope = readAgyEnvelope(stripAnsi(result.stdout ?? ""));

  if (envelope?.status === "SUCCESS") {
    return {
      loggedIn: true,
      state: "verified",
      verifiable: true,
      detail: `AGY ${version} answered \`/quota\` from the account, so it is authenticated. No turn was spent.`
    };
  }

  // A failure here is not proof of a logout: the probe can also fail on a
  // network error or a version that answers differently. Say which it was, and
  // do not upgrade "did not answer" into "not logged in".
  const reason = envelope?.error ?? String(result.stderr ?? "").trim() ?? "";
  const failure = classifyCliFailure({
    engine: "agy",
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout,
    stderr: envelope?.error ?? result.stderr
  });
  if (failure.category === "auth") {
    return {
      loggedIn: false,
      state: "logged-out",
      verifiable: true,
      detail: `AGY ${version} rejected the \`/quota\` probe as unauthenticated. Run \`agy\` interactively once to sign in.${reason ? ` (${reason})` : ""}`
    };
  }
  return {
    loggedIn: false,
    state: "unknown",
    verifiable: false,
    detail: `AGY ${version} did not answer the \`/quota\` probe (${failure.category}), so its authentication state is still unknown.${reason ? ` (${reason})` : ""}`
  };
}

export function getSessionRuntimeStatus() {
  // Unlike the Codex app-server (a shared persistent runtime), the Gemini plugin
  // invokes the CLI directly per command, so the runtime label describes which
  // engine the next command would use rather than a shared session endpoint.
  const gemini = getGeminiAvailability();
  const agy = getAgyAvailability();
  const available = gemini.available || agy.available;
  const label = gemini.available
    ? "gemini CLI (per-command)"
    : agy.available
      ? "agy (per-command)"
      : "no engine available";
  return { mode: "direct", gemini, agy, available, label };
}
