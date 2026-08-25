export const FAILURE_CATEGORIES = new Set([
  "binary-missing",
  "auth",
  "quota",
  "rate-limit",
  "model-unavailable",
  "timeout",
  "prompt-too-long",
  "no-output",
  "transcript-missing",
  "transcript-ambiguous",
  "invalid-json",
  "tool-permission-denied",
  "cancelled",
  "stale-job",
  "unknown"
]);

const DEFAULTS = {
  "binary-missing": {
    retryable: false,
    summary: "Required CLI binary is not available.",
    nextStep: "Install and initialize either supported engine, then select it with `--engine gemini` or `--engine agy`."
  },
  auth: {
    retryable: false,
    summary: "CLI authentication failed or is missing.",
    nextStep: "Run `gemini` once to authenticate, then retry the command."
  },
  quota: {
    retryable: false,
    summary: "Gemini quota or billing limits blocked the request.",
    nextStep: "Wait for quota reset, adjust billing or account limits, or retry with a different available engine."
  },
  "rate-limit": {
    retryable: true,
    summary: "The request was rate limited.",
    nextStep: "Retry later, reduce concurrency, or narrow the request."
  },
  "model-unavailable": {
    retryable: false,
    summary: "The requested model is unavailable to this CLI.",
    nextStep: "Use a supported model, omit `--model`, or use the default Gemini engine mapping."
  },
  timeout: {
    retryable: true,
    summary: "The CLI command timed out.",
    // Both engines stall, so both directions are offered. The old wording named
    // only AGY timing out and pointed at gemini, which left a gemini timeout with
    // no engine advice at all -- the case in field note gi-2026-08-24-b7c1, where
    // gemini stalled for minutes on a diff AGY answered in about 25 seconds.
    nextStep: "Retry later, reduce prompt size or review scope, or run it on the other engine (`--engine agy` or `--engine gemini`)."
  },
  "prompt-too-long": {
    retryable: false,
    summary: "The prompt cannot be sent safely to the selected engine.",
    // "gemini sends prompts over stdin" stopped being a distinguishing reason at
    // AGY 1.1.2, which does the same (gemini.mjs, `useStdin`). Only the older
    // positional path -- which is what the `positional prompt` and NUL-byte checks
    // above actually catch -- has the limit this advice was written for, so the
    // advice now says which case it applies to instead of implying it always does.
    nextStep: "Shorten the prompt. If the engine is AGY older than 1.1.2, which passes the prompt as a command-line argument, `--engine gemini` sends it over stdin instead; AGY 1.1.2 and newer already does."
  },
  "no-output": {
    retryable: true,
    summary: "The CLI returned no usable output.",
    // The AGY half is a real remedy for a real AGY condition and stays. The tail
    // was not: an engine that returns nothing is a reason to try the other one
    // whichever engine it was.
    nextStep: "Retry the command; for AGY, initialize it once interactively. If it repeats, try the other engine (`--engine agy` or `--engine gemini`)."
  },
  "transcript-missing": {
    retryable: true,
    summary: "AGY transcript recovery did not produce a completed response.",
    nextStep: "Run `agy` once to initialize its brain directory, retry, or use `--engine gemini`."
  },
  "transcript-ambiguous": {
    retryable: true,
    summary: "AGY transcript recovery found an ambiguous conversation match.",
    nextStep: "Retry when no other AGY runs are starting, or use `--engine gemini`."
  },
  "invalid-json": {
    retryable: true,
    summary: "The CLI returned output that was not valid structured JSON.",
    nextStep: "Retry the command; if it repeats, inspect the job log and run `/gemini:setup`."
  },
  "tool-permission-denied": {
    retryable: false,
    summary: "AGY auto-denied a tool call because headless mode cannot prompt for permission.",
    // AGY's own message suggests re-running with --dangerously-skip-permissions.
    // That is not advice this plugin can pass on: the flag was removed in v0.16.0
    // (it granted nothing for edits and shell commands, docs/THREAT-MODEL.md 7.2)
    // and there is no option that puts it back, so telling a user to "re-run
    // with" it would name something they cannot reach from here. The allow-rule
    // is the part they can act on; an interactive `agy` run is the other.
    nextStep: "Add an allow-rule under `permissions.allow` in AGY's settings.json for the denied command, or run `agy` interactively once so it can ask."
  },
  cancelled: {
    retryable: true,
    summary: "The job was cancelled.",
    nextStep: "Run the command again if the work is still needed."
  },
  "stale-job": {
    retryable: true,
    summary: "The job was still marked active, but its worker is gone or stale.",
    nextStep: "Inspect `/gemini:result <job-id>` if output exists, otherwise retry the command."
  },
  unknown: {
    retryable: true,
    summary: "The CLI failed with an unclassified error.",
    nextStep: "Inspect the job log, run `/gemini:setup`, then retry with a narrower prompt if needed."
  }
};

function compactText(value) {
  if (value == null) {
    return "";
  }
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "object") {
    return String(value.message ?? value.detail ?? value.reason ?? "");
  }
  return String(value);
}

function firstLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

function combinedTrustedText(input) {
  return [
    input.stderr,
    input.error,
    input.errorMessage,
    input.message,
    input.reason,
    input.transcriptReason,
    input.structuredError
  ]
    .map(compactText)
    .filter(Boolean)
    .join("\n");
}

function normalizeFailure(category, input = {}) {
  const defaults = DEFAULTS[category] ?? DEFAULTS.unknown;
  const summary = input.summary ?? firstLine(input.errorMessage);
  return {
    category,
    retryable: Boolean(input.retryable ?? defaults.retryable),
    summary: String(summary || defaults.summary),
    nextStep: String(input.nextStep ?? defaults.nextStep)
  };
}

function explicitFailure(input) {
  const source = input?.failure ?? input;
  const category = source?.category;
  if (!FAILURE_CATEGORIES.has(category)) {
    return null;
  }
  return normalizeFailure(category, source);
}

function errorCode(input) {
  return input?.error?.code ?? input?.code ?? null;
}

function transcriptCategory(reason) {
  if (!reason) {
    return null;
  }
  if (/multiple|ambiguous|\b\d+\s+new dirs?|not certain|picked newest/i.test(reason)) {
    return "transcript-ambiguous";
  }
  if (/brain root|no new conversation dir|no transcript file|no PLANNER_RESPONSE|status=.*possible truncation|status=|transcript read failed/i.test(reason)) {
    return "transcript-missing";
  }
  return null;
}

export function classifyCliFailure(input = {}) {
  const data = typeof input === "string" ? { message: input } : (input ?? {});
  const already = explicitFailure(data);
  if (already) {
    return already;
  }

  const trusted = combinedTrustedText(data);
  const stdout = compactText(data.stdout);
  const structuredText = data.structured === true ? `${trusted}\n${stdout}` : trusted;
  const code = errorCode(data);
  const signal = compactText(data.signal);

  if (data.cancelled || /cancel(l)?ed|aborted|SIGINT/i.test(structuredText) || signal === "SIGINT") {
    return normalizeFailure("cancelled", data);
  }
  if (code === "ENOENT" || /command not found|not recognized as .*command|binary .*not (found|available)|No Gemini or AGY engine found|engine requested but .*binary is not available/i.test(structuredText)) {
    return normalizeFailure("binary-missing", data);
  }
  if (data.promptTooLong || data.promptNul || /prompt .*too long|context length|token limit|NUL byte|positional prompt/i.test(structuredText)) {
    return normalizeFailure("prompt-too-long", data);
  }
  // `api key not valid` and `API_KEY_INVALID` are Google's actual wording, and
  // they are not word-order variants of `invalid api key` — a live 400 from
  // generativelanguage.googleapis.com fell through to `unknown`, whose next step
  // ("retry with a narrower prompt") can never fix a rejected credential.
  // Deliberately not matched: `INVALID_ARGUMENT` and `\b400\b`. Both also cover
  // malformed requests, and a bad `--model` id returns exactly that status — auth
  // is tested before the model check below, so either one would swallow it.
  if (
    /oauth|unauth|authenticat|login required|invalid api key|api key not valid|API_KEY_INVALID|permission denied|\b401\b|\b403\b/i.test(
      structuredText
    )
  ) {
    return normalizeFailure("auth", data);
  }
  if (/quota|billing|RESOURCE_EXHAUSTED/i.test(structuredText)) {
    return normalizeFailure("quota", data);
  }
  if (/\b429\b|too many requests|rate.?limit/i.test(structuredText)) {
    return normalizeFailure("rate-limit", data);
  }
  // AGY words a bad model as `invalid model selection (--model "x"): model x is
  // not recognized as a known model or custom model in settings` (live 1.1.10).
  // Its ERROR envelope reaches this classifier from 1.1.8 on, where previously
  // only an empty stderr did, so match that wording alongside gemini's.
  if (/ModelNotFoundError|Requested entity was not found|model .*not found|model.*unavailable|invalid model selection|not recognized as a known model|not_found|\b404\b/i.test(structuredText)) {
    return normalizeFailure("model-unavailable", data);
  }

  const transcriptReason = compactText(data.transcriptReason ?? data.reason) || structuredText;
  const transcript = transcriptCategory(transcriptReason);
  if (transcript) {
    const retryable = /brain root/i.test(transcriptReason) ? false : undefined;
    return normalizeFailure(transcript, { ...data, retryable });
  }

  if (code === "ETIMEDOUT" || data.timedOut || /timed? out|timeout|deadline exceeded|SIGTERM|SIGKILL/i.test(structuredText) || signal === "SIGTERM" || signal === "SIGKILL") {
    return normalizeFailure("timeout", data);
  }

  if (data.invalidJson || /invalid json|JSON\.parse|Could not parse structured JSON|unexpected token/i.test(structuredText)) {
    return normalizeFailure("invalid-json", data);
  }

  // AGY exits 0 with empty stdout when a tool needed a permission it could not
  // prompt for, which would otherwise land on "no-output" — retryable, and
  // retrying never helps. Matched on AGY's own wording, including its suggestion
  // to pass --dangerously-skip-permissions; that the plugin no longer offers the
  // flag does not stop AGY from naming it.
  if (/headless mode cannot prompt for|was auto-denied\b|dangerously-skip-permissions/i.test(structuredText)) {
    return normalizeFailure("tool-permission-denied", data);
  }
  if (data.noOutput || (!String(stdout).trim() && !String(trusted).trim() && (data.status == null || data.status === 0))) {
    return normalizeFailure("no-output", data);
  }

  return normalizeFailure("unknown", data);
}

export function createFailureError(input = {}) {
  const failure = classifyCliFailure(input);
  const error = new Error(`${failure.summary} Next step: ${failure.nextStep}`);
  error.failure = failure;
  return error;
}
