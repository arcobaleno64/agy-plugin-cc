import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyCliFailure } from "../plugins/gemini/scripts/lib/failures.mjs";

test("classifyCliFailure identifies auth failures", () => {
  const failure = classifyCliFailure({ stderr: "OAuth token expired. Run gemini to authenticate." });
  assert.equal(failure.category, "auth");
  assert.equal(failure.retryable, false);
  assert.match(failure.nextStep, /authenticate/i);
});

// The two wordings below are one sentence apart and neither is derivable from
// the other, so both are pinned. Getting the split wrong is silent in each
// direction: call the per-minute limit durable and a recoverable review dies at
// attempt 1; call the spend cap transient and it burns three attempts reaching
// the same refusal.
test("classifyCliFailure identifies a durable spend cap as quota", () => {
  const failure = classifyCliFailure({
    stderr: "Your project has exceeded its monthly spending cap. Please go to AI Studio to manage your project spend cap."
  });
  assert.equal(failure.category, "quota");
  assert.equal(failure.retryable, false);
  assert.match(failure.nextStep, /quota|billing|later/i);
});

test("classifyCliFailure treats the free-tier per-minute limit as a retryable rate limit", () => {
  // Google's verbatim wording. It says both `quota` and `billing`, which is why
  // neither word can be a durable-quota marker — see failures.mjs.
  const failure = classifyCliFailure({
    stderr: "429 RESOURCE_EXHAUSTED: You exceeded your current quota, please check your plan and billing details"
  });
  assert.equal(failure.category, "rate-limit");
  assert.equal(failure.retryable, true);
});

// Google names the period in the quota metric / limit id, and it puts that period
// AFTER the noun. An earlier draft matched `(daily|per.?day) (quota|limit)`, the
// wrong word order, so it never fired and every per-day refusal was retried three
// times at minutes per attempt. These two pin the word order in both directions.
test("classifyCliFailure treats a per-day quota id as durable quota", () => {
  const failure = classifyCliFailure({
    stderr:
      "429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'generate_content_free_tier_requests', " +
      "quota_id: GenerateRequestsPerDayPerProjectPerModel-FreeTier"
  });
  assert.equal(failure.category, "quota");
  assert.equal(failure.retryable, false);
});

test("classifyCliFailure treats a per-minute limit id as a retryable rate limit", () => {
  const failure = classifyCliFailure({
    stderr:
      "429 RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'Generate Content API requests per minute' " +
      "and limit 'GenerateContent request limit per minute per project per region'"
  });
  assert.equal(failure.category, "rate-limit");
  assert.equal(failure.retryable, true);
});

test("classifyCliFailure keeps a bare RESOURCE_EXHAUSTED retryable rather than unknown", () => {
  // No 429 in the text: without RESOURCE_EXHAUSTED in the rate-limit branch this
  // would fall past every category to `unknown`.
  const failure = classifyCliFailure({ stderr: "RESOURCE_EXHAUSTED: quota exceeded for project" });
  assert.equal(failure.category, "rate-limit");
  assert.equal(failure.retryable, true);
});

test("classifyCliFailure identifies 429 rate limits as retryable", () => {
  const failure = classifyCliFailure({ stderr: "429 Too Many Requests: rate limit exceeded" });
  assert.equal(failure.category, "rate-limit");
  assert.equal(failure.retryable, true);
  assert.match(failure.nextStep, /retry/i);
});

test("classifyCliFailure identifies timeout failures", () => {
  const failure = classifyCliFailure({ error: Object.assign(new Error("spawn timed out"), { code: "ETIMEDOUT" }) });
  assert.equal(failure.category, "timeout");
  assert.equal(failure.retryable, true);
});

test("classifyCliFailure identifies model-unavailable failures", () => {
  const failure = classifyCliFailure({ stderr: "ModelNotFoundError: Requested entity was not found. code: 404" });
  assert.equal(failure.category, "model-unavailable");
  assert.equal(failure.retryable, false);
  assert.match(failure.nextStep, /model/i);
});

// Verbatim wording from a live `agy --output-format json --model <bogus>` run on
// AGY 1.1.10. From 1.1.8 the ERROR envelope's `error` reaches the classifier,
// where previously AGY left stderr empty and this landed on "no-output".
test("classifyCliFailure identifies AGY's invalid model selection wording", () => {
  const failure = classifyCliFailure({
    engine: "agy",
    status: 1,
    stderr: 'invalid model selection (--model "definitely-not-a-real-model" --effort ""): model definitely-not-a-real-model is not recognized as a known model or custom model in settings',
    noOutput: true
  });
  assert.equal(failure.category, "model-unavailable");
  assert.equal(failure.retryable, false);
});

test("classifyCliFailure identifies empty output", () => {
  const failure = classifyCliFailure({ noOutput: true, status: 0, stdout: "", stderr: "" });
  assert.equal(failure.category, "no-output");
  assert.equal(failure.retryable, true);
});

test("classifyCliFailure identifies invalid JSON", () => {
  const failure = classifyCliFailure({ invalidJson: true, stdout: "not json" });
  assert.equal(failure.category, "invalid-json");
  assert.equal(failure.retryable, true);
});

test("classifyCliFailure identifies transcript recovery failures", () => {
  assert.equal(classifyCliFailure({ transcriptReason: "no transcript file found" }).category, "transcript-missing");
  assert.equal(classifyCliFailure({ transcriptReason: "2 new dirs appeared; picked newest by mtime" }).category, "transcript-ambiguous");
});

test("classifyCliFailure identifies prompt-too-long preflight failures", () => {
  const failure = classifyCliFailure({ promptTooLong: true, engine: "agy" });
  assert.equal(failure.category, "prompt-too-long");
  assert.equal(failure.retryable, false);
  assert.match(failure.nextStep, /shorten|gemini/i);
});

// Verbatim wording from a live AGY run. The exit status is 0 and stdout is
// empty, so without this rule the failure lands on "no-output" — which is marked
// retryable, and retrying a denied permission never succeeds.
test("classifyCliFailure identifies AGY headless tool-permission soft-denials", () => {
  const failure = classifyCliFailure({
    status: 0,
    stdout: "",
    stderr: 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.'
  });
  assert.equal(failure.category, "tool-permission-denied");
  assert.equal(failure.retryable, false);
  assert.match(failure.nextStep, /allow-rule/i);
});

// The plugin removed --dangerously-skip-permissions in v0.16.0 and offers no way
// to reinstate it, so the advice must not tell a user to re-run with it — even
// though AGY's own message does, and the classifier still matches that wording.
test("the tool-permission next step does not name a flag the plugin cannot pass", () => {
  const failure = classifyCliFailure({ status: 0, stdout: "", stderr: "a tool was auto-denied" });
  assert.equal(failure.category, "tool-permission-denied");
  assert.doesNotMatch(failure.nextStep, /dangerously-skip-permissions/);
});

test("classifyCliFailure falls back to unknown", () => {
  const failure = classifyCliFailure({ stderr: "unexpected failure shape" });
  assert.equal(failure.category, "unknown");
  assert.equal(failure.retryable, true);
});

test("classifyCliFailure does not treat transport words in model prose as transport failures", () => {
  const failure = classifyCliFailure({
    status: 1,
    stdout: "The code returns a 429 and hits a rate limit under load.",
    stderr: ""
  });
  assert.notEqual(failure.category, "rate-limit");
});

// Verbatim from a live gemini 0.54.4 run on 2026-08-12 (`gemini -p "say OK"`
// against an account whose consumer access ended): HTTP 400, exit 1, no tokens
// spent. It classified as `unknown`, whose next step is "retry with a narrower
// prompt" — advice that cannot fix a rejected credential. The pattern it missed
// is word order: Google says "API key not valid", the classifier had "invalid
// api key".
test("Google's own API-key rejection classifies as auth, not unknown", () => {
  const stderr =
    'Error when talking to Gemini API _ApiError: {"error":{"message":"{\n  \\"error\\": {\n    ' +
    '\\"code\\": 400,\n    \\"message\\": \\"API key not valid. Please pass a valid API key.\\",\n    ' +
    '\\"status\\": \\"INVALID_ARGUMENT\\",\n    \\"details\\": [\n      {\n        ' +
    '\\"@type\\": \\"type.googleapis.com/google.rpc.ErrorInfo\\",\n        \\"reason\\": \\"API_KEY_INVALID\\"\n' +
    '      }\n    ]\n  }\n}\n","code":400,"status":"Bad Request"}}';
  const failure = classifyCliFailure({ engine: "gemini", status: 1, stdout: "", stderr });

  assert.equal(failure.category, "auth");
  assert.match(failure.nextStep, /gemini/, "the next step must point at re-authenticating");
  assert.doesNotMatch(failure.nextStep, /narrower prompt/);
});

// The status Google returns for a rejected key is also what it returns for a
// malformed request, including a bad --model id. Auth is tested before the model
// check, so matching the status rather than the key wording would swallow it.
test("a bad model id is still a model failure, not an auth failure", () => {
  const failure = classifyCliFailure({
    engine: "gemini",
    status: 1,
    stdout: "",
    stderr: '{"error":{"code":400,"status":"INVALID_ARGUMENT","message":"models/nope-1.0 is not found or not supported"}}'
  });

  assert.notEqual(failure.category, "auth");
});

// These strings were written when AGY was the unreliable engine, and they all sent
// the user one way: to gemini. Field note gi-2026-08-24-b7c1 is the first recorded
// case of the reverse -- gemini stalling on a diff AGY answered in about 25 seconds
// -- and the plugin had nothing to say to that user beyond "retry or shrink it".
// A condition either engine can produce must not name only one of them.
test("advice for a failure either engine can hit names both engines", () => {
  const cases = [
    ["timeout", { code: "ETIMEDOUT" }],
    ["no-output", { stdout: "", stderr: "", exitCode: 0 }]
  ];
  for (const [expected, data] of cases) {
    const failure = classifyCliFailure(data);
    assert.equal(failure.category, expected);
    assert.match(failure.nextStep, /--engine agy/, `${expected} must offer AGY`);
    assert.match(failure.nextStep, /--engine gemini/, `${expected} must offer gemini`);
  }
});

// The other half of the same rule, and the reason this is not a blanket "always name
// both": transcript recovery is a mechanism only AGY has, and its brain directory is
// only AGY's to initialize. Advice that named gemini as an alternative for these
// would be describing a condition gemini cannot be in. Pinned so a later pass at
// symmetry does not flatten a real asymmetry into a false one.
test("advice for an AGY-only condition stays AGY-only", () => {
  for (const reason of ["brain root missing", "ambiguous conversation match"]) {
    const failure = classifyCliFailure({ transcriptReason: reason });
    assert.match(failure.category, /^transcript-/, `${reason} classifies as a transcript failure`);
    assert.doesNotMatch(failure.nextStep, /--engine agy/, "AGY is already the engine that failed");
    // Asserting only the absence let the asymmetry be deleted rather than kept: drop
    // the gemini alternative and nothing here noticed. The escape hatch is the point.
    assert.match(failure.nextStep, /--engine gemini/, "the way out is still offered");
  }
});

// An earlier attempt at this rewrote the default to describe AGY argv handling, on
// the assumption that the argv cases reach it. They do not: assertAgyPromptSafe
// throws with its own nextStep and normalizeFailure prefers an explicit one, so the
// only traffic here is the text-matched arm -- `context length`, `token limit` -- a
// model's context window, most often gemini's. Those users were handed a paragraph
// about AGY versions. What is pinned is that this default names no engine at all.
test("the default prompt-too-long advice belongs to no engine", () => {
  const failure = classifyCliFailure({ stderr: "Error: context length exceeded for the model" });
  assert.equal(failure.category, "prompt-too-long");
  assert.doesNotMatch(failure.nextStep, /--engine/, "a context window is not an engine's fault");
  assert.match(failure.nextStep, /scope|split/i, "and the remedy is to send less");
});

// ---------------------------------------------------------------------------
// `detail` carries the engine's own words. `summary` and `nextStep` are chosen
// from a fixed table keyed by category, so neither can name anything specific to
// the run — the model that was rejected, the ids that would have worked, when a
// limit resets. Before this field the engine's message was read by the
// classifier and then discarded. (#141)
// ---------------------------------------------------------------------------

test("classifyCliFailure keeps the engine's own message as detail", () => {
  const said = 'invalid model selection (--model "gemini-3-pro" --effort ""): model gemini-3-pro is not recognized\nAvailable models:\n  Gemini 3.1 Pro (High)';
  const failure = classifyCliFailure({ engine: "agy", status: 1, stdout: said, stderr: said, detail: said });
  assert.equal(failure.category, "model-unavailable");
  assert.equal(failure.detail, said);
  // The specifics live only in detail: the table-driven fields cannot carry them.
  assert.ok(!failure.summary.includes("gemini-3-pro"));
  assert.ok(!failure.nextStep.includes("Gemini 3.1 Pro"));
});

test("classifyCliFailure reports no detail as null rather than an empty string", () => {
  assert.equal(classifyCliFailure({ stderr: "429 Too Many Requests" }).detail, null);
  assert.equal(classifyCliFailure({ stderr: "429 Too Many Requests", detail: "   " }).detail, null);
});

test("classifyCliFailure caps a runaway detail instead of storing it whole", () => {
  // Engine output, not a fixed string, and it is written to job records on disk.
  const failure = classifyCliFailure({ stderr: "boom", detail: "x".repeat(5000) });
  assert.ok(failure.detail.length < 2200, `detail was ${failure.detail.length} characters`);
  assert.match(failure.detail, /truncated; 5000 characters total/);
});

test("a failure that is re-normalized does not lose its detail", () => {
  // Job records are stored and re-read, and an already-classified failure takes
  // the explicitFailure path rather than the text matchers.
  const first = classifyCliFailure({ stderr: "boom", detail: "the engine said this" });
  const second = classifyCliFailure({ failure: first });
  assert.equal(second.detail, "the engine said this");
  assert.equal(second.category, first.category);
});

// Review finding on #144. A stored failure is re-normalized every time a job
// record is read back, and the first version appended the marker AFTER slicing
// to the full budget — so the result exceeded the cap, the second pass sliced the
// marker off, and the replacement reported the truncated length. The original
// size was lost and another 37 characters of real message with it. The
// re-normalization test above uses a 20-character detail, so it cannot see this.
test("truncating an already-truncated detail is a no-op, and keeps the real total", () => {
  const once = classifyCliFailure({ stderr: "boom", detail: "x".repeat(5000) });
  const twice = classifyCliFailure({ failure: once });
  assert.equal(twice.detail, once.detail, "a second pass must not re-truncate");
  assert.match(twice.detail, /truncated; 5000 characters total/, "the engine's real size, not the truncated one");
  assert.ok(once.detail.length <= 2000, `marker must fit inside the cap, got ${once.detail.length}`);
});
