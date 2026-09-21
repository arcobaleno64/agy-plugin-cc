export const FAILURE_CATEGORIES = new Set([
  "binary-missing",
  "engine-unsupported",
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
  // The engine is installed and answers --version; the version is the problem.
  // Not retryable in the strong sense -- the same request will be refused
  // identically until the binary is replaced -- which is what separates it from
  // `binary-missing`, where the retry at least has somewhere to go.
  "engine-unsupported": {
    retryable: false,
    summary: "The engine is older than this plugin supports.",
    // The refusal itself already names the floor, what breaks below it, and
    // whether the other engine is a way out, and it survives as `summary`. This
    // adds the one thing it cannot say about itself: retrying changes nothing.
    nextStep: "Run `agy update`, then rerun. A version refusal cannot be retried into success; the summary says whether the other engine is a way out."
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
    // `--timeout` comes first because it is the only one of these that addresses
    // the cause when the budget itself is what was too small — issue #153, where
    // three runs were spent narrowing scope before the timeout turned out to be
    // the binding constraint. Scope and engine stay, since a genuinely oversized
    // prompt and a stalled engine are both still real causes.
    nextStep: "Raise the budget with `--timeout <seconds>`, reduce prompt size or review scope, or run it on the other engine (`--engine agy` or `--engine gemini`)."
  },
  "prompt-too-long": {
    retryable: false,
    summary: "The prompt cannot be sent safely to the selected engine.",
    // Engine-neutral on purpose. This is now the only arm: the argv-limit and
    // NUL-byte preflight that used to throw with its own nextStep is gone with
    // the positional prompt path it guarded. What arrives here is text-matched
    // (`context length`, `token limit`) — a model's context window rather than an
    // engine's argv, and most often gemini. An earlier draft of this line
    // described AGY argv handling and shipped that to exactly those users.
    nextStep: "Shorten the prompt, narrow the review scope, or split the diff into smaller runs."
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

// What the engine itself said, kept verbatim. `summary` and `nextStep` are this
// plugin's words for a category; they are chosen from a fixed table and cannot
// name anything specific to the run. The engine's own message can, and it is
// routinely the only place the actionable part exists — AGY answers a rejected
// `--model` with the full list of ids it would have accepted, and before this
// field that text was read by the classifier and then dropped, leaving the user
// told to "use a supported model" with no way to learn which ones those are.
//
// Capped because it is engine output, not a fixed string: the model list is a few
// hundred bytes, but nothing upstream promises a bound, and this travels into job
// records that are written to disk and re-rendered.
const MAX_FAILURE_DETAIL = 2000;

// Truncation has to be idempotent, because a stored failure is re-normalized
// every time a job record is read back (`explicitFailure`). A first version
// appended the marker AFTER slicing to the full budget, so the result was longer
// than the budget, and a second pass sliced the marker off and replaced it with
// one reporting the truncated length — the original size was lost and another 37
// characters of real message went with it. The marker is budgeted inside the cap,
// and text already carrying one is returned untouched.
const TRUNCATION_MARKER = /\n… \(truncated; \d+ characters total\)$/;

function normalizeDetail(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (text.length <= MAX_FAILURE_DETAIL || TRUNCATION_MARKER.test(text)) return text;
  const marker = `\n… (truncated; ${text.length} characters total)`;
  return `${text.slice(0, MAX_FAILURE_DETAIL - marker.length)}${marker}`;
}

function normalizeFailure(category, input = {}) {
  const defaults = DEFAULTS[category] ?? DEFAULTS.unknown;
  const summary = input.summary ?? firstLine(input.errorMessage);
  return {
    category,
    retryable: Boolean(input.retryable ?? defaults.retryable),
    summary: String(summary || defaults.summary),
    nextStep: String(input.nextStep ?? defaults.nextStep),
    detail: normalizeDetail(input.detail)
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

// AGY 1.2.6+ prints a structured failure line on stderr alongside its prose:
//   AGY_ERROR: {"status":"<canonical>","code":<n>,"retryable":<bool>,"error_id":"..."}
// Field names were read out of the 1.2.7 binary (printmode.agentErrorPayload,
// emitted by (*AgentError).structuredLine); the fallback form it also carries is
// {"short_error":"..."}. Never observed live: six probes on 1.2.7 — rejected
// --model, expired --print-timeout, invalid --json-schema, unknown --project,
// stale --conversation, and a 191k-token prompt — each failed some other way,
// so this is read defensively and nothing depends on it arriving.
//
// The line has to come out of the prose before the arms below run. Its values
// are gRPC canonical statuses, and `Aborted` — a concurrency or transaction
// abort, not a user cancellation — matches the `aborted` in the cancelled arm.
// Once that arm wins, auth and quota never run. Measured by putting all 17
// canonical statuses through classifyCliFailure: `Aborted` was the only misfile.
const AGY_ERROR_LINE = /^[ \t]*AGY_ERROR:[ \t]*(\{.*\})[ \t]*$/gm;

// Only the statuses whose meaning is unambiguous are mapped, so that cutting a
// line out never loses a classification that was already right. `Unauthenticated`
// is here because the auth arm reaches it today through the `unauth` substring,
// and dropping the line would have silently demoted it to `unknown`.
// `ResourceExhausted` is deliberately absent: the quota arm splits durable from
// transient on wording this line does not carry, so it keeps falling through to
// `unknown`, which is where it lands today. `PermissionDenied` likewise — the
// auth arm matches `permission denied` with a space, so the token never reached
// it in the first place.
const AGY_STATUS_CATEGORY = new Map([
  ["canceled", "cancelled"],
  ["cancelled", "cancelled"],
  ["unauthenticated", "auth"]
]);

// A canonical status this plugin knows how to read is answered directly. One
// that it does not is left exactly where it is: an unmapped status is not a
// licence to delete the line, because the line is often the only place a
// classifiable phrase exists. Two measured cases say so — the fallback text
// rides along in `short_error` (`{"status":"Internal","short_error":"Individual
// quota reached. Resets in 2h39m52s."}` reaches the quota arm only through that
// text), and the wire spelling `RESOURCE_EXHAUSTED` is matched by the rate-limit
// arm while the CamelCase `ResourceExhausted` is not. Stripping on presence
// alone turned a durable quota refusal back into a retryable `unknown`, undoing
// what 20980ed fixed.
//
// That leaves the one token that is actively wrong. `Aborted` is gRPC's
// concurrency or transaction abort, and the cancelled arm's `aborted` claims it
// as a user cancellation — after which the auth and quota arms never run. Only
// that value is blanked out of the text, and only inside the structured line, so
// everything else on it still reaches the arms below. Putting all 17 canonical
// statuses through classifyCliFailure, in both CamelCase and SCREAMING_SNAKE,
// measured `Aborted` as the only value that needed it.
const AGY_MISLEADING_STATUS = new Set(["aborted"]);

function splitAgyErrorLine(text) {
  const source = String(text ?? "");
  let rewritten = "";
  let cursor = 0;
  let category = null;
  let changed = false;
  for (const match of source.matchAll(AGY_ERROR_LINE)) {
    let status = null;
    try {
      const parsed = JSON.parse(match[1]);
      status = typeof parsed?.status === "string" ? parsed.status.trim().toLowerCase() : null;
    } catch {
      continue;
    }
    if (!status) continue;
    const mapped = AGY_STATUS_CATEGORY.get(status);
    if (mapped) {
      category = category ?? mapped;
      continue;
    }
    if (!AGY_MISLEADING_STATUS.has(status)) continue;
    // Splice by index rather than by text: the same JSON can appear again in
    // surrounding prose (an engine echoing a previous attempt), and a literal
    // replace rewrites the leftmost copy, which is the echo. No test pins this
    // — either way an un-blanked copy of the token survives, so the category
    // comes out the same and only the prose differs — so it is written the
    // correct way rather than the testable way.
    rewritten += source.slice(cursor, match.index) + match[0].replace(/"status"\s*:\s*"[^"]*"/i, '"status":""');
    cursor = match.index + match[0].length;
    changed = true;
  }
  if (category) return { text: source, category };
  if (!changed) return { text, category: null };
  return { text: rewritten + source.slice(cursor), category: null };
}

export function classifyCliFailure(input = {}) {
  const data = typeof input === "string" ? { message: input } : (input ?? {});
  const already = explicitFailure(data);
  if (already) {
    return already;
  }

  const trusted = combinedTrustedText(data);
  const stdout = compactText(data.stdout);
  const rawStructuredText = data.structured === true ? `${trusted}\n${stdout}` : trusted;
  const agyError = splitAgyErrorLine(rawStructuredText);
  if (agyError.category) {
    return normalizeFailure(agyError.category, data);
  }
  const structuredText = agyError.text;
  const code = errorCode(data);
  const signal = compactText(data.signal);

  if (data.cancelled || /cancel(l)?ed|aborted|SIGINT/i.test(structuredText) || signal === "SIGINT") {
    return normalizeFailure("cancelled", data);
  }
  // Ahead of `auth` deliberately. The floor refusal's own text mentions
  // authenticating when gemini has no usable credential either -- that sentence
  // is there to explain why routing reached AGY at all -- and `auth` matches on
  // `authenticat`, so a later arm would file a version refusal as a login
  // problem and send the user to `/gemini:setup` instead of `agy update`.
  if (/older than this plugin supports|requires AGY \d+\.\d+\.\d+ or newer/i.test(structuredText)) {
    return normalizeFailure("engine-unsupported", data);
  }
  if (code === "ENOENT" || /command not found|not recognized as .*command|binary .*not (found|available)|No Gemini or AGY engine found|engine requested but .*binary is not available/i.test(structuredText)) {
    return normalizeFailure("binary-missing", data);
  }
  // `NUL byte` and `positional prompt` are gone from this pattern with the
  // preflight that produced them; what remains matches what an engine says about
  // a context window, not what the plugin used to say about argv.
  if (/prompt .*too long|context length|token limit/i.test(structuredText)) {
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
  // `quota` splits two failures that read almost identically and want opposite
  // handling. The durable one — a project over its spend cap or its monthly
  // allowance — cannot be retried into success, and 0.24.2 widened this branch to
  // catch it after it was being reported as a passing flake. The transient one is
  // Google's standard free-tier per-minute limit, whose entire wording is:
  //
  //   429 RESOURCE_EXHAUSTED: You exceeded your current quota, please check your
  //   plan and billing details
  //
  // That message is the free tier's generic refusal. It carries no period at all,
  // so it cannot be classified from its own words — but the refusals that DO name
  // a period say so in a quota metric or limit id, and those are matched directly:
  //
  //   ... limit 'GenerateContent request limit per minute per project'
  //   ... quota_id: GenerateRequestsPerDayPerProjectPerModel-FreeTier
  //
  // `per day` / `PerDay` is durable on any horizon a review cares about (it
  // resets at midnight Pacific); `per minute` is transient. Matching the period
  // positively is why this is not a guess: an earlier draft wrote the day case as
  // `(daily|per.?day) (quota|limit)`, which is the wrong word order — Google puts
  // the period AFTER the noun (`limit ... per day`), so that alternative could
  // never fire and every per-day refusal was retried three times.
  //
  // `billing` is deliberately NOT a durable marker despite being in the 0.24.2
  // set: the generic message above says `billing details`, so keeping it would
  // leave exactly the bug this split exists to fix. Only `billing account`
  // survives, which appears in the disabled-account wording and not in that one.
  //
  // The period-less generic message therefore falls through to `rate-limit` and
  // is retried. That is a choice made without knowing which limit it is, and the
  // asymmetry is what decides it: a hard failure on a transient limit throws away
  // a review that would have succeeded, while retrying a durable one wastes
  // wall-clock and ends at the same refusal. Note that the cost of being wrong
  // here is NOT small — the 0.24.2 measurement was 10m46s for three attempts to
  // reach the same refusal, so each wasted attempt is minutes, not seconds. It is
  // accepted because the periods that are nameable are now named above, leaving
  // only the genuinely ambiguous case in this branch.
  //
  // AGY needs the same split and names its period differently: one sentence,
  // "Individual quota reached. ... Resets in <duration>.", for both horizons.
  // Measured `Resets in 58s` on 1.1.24 (retried once by runGeminiReviewResilient)
  // and `Resets in 2h39m52s` on 1.2.2 — the exhausted 5-hour window. A reset
  // stated in hours or days is durable on any horizon a turn cares about, so it is
  // matched positively; minutes and seconds stay `rate-limit`.
  if (
    /spend(ing)? cap|billing account|monthly (spend|quota|limit)|per.?day|daily (quota|limit)|exceeded your (monthly|daily)/i.test(structuredText) ||
    /resets? in\s+\d+\s*(?:h(?:ours?|rs?)?|d(?:ays?)?)(?![a-z])/i.test(structuredText)
  ) {
    return normalizeFailure("quota", data);
  }
  if (/\b429\b|too many requests|rate.?limit|quota|RESOURCE_EXHAUSTED/i.test(structuredText)) {
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
