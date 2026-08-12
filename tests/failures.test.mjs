import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyCliFailure } from "../plugins/gemini/scripts/lib/failures.mjs";

test("classifyCliFailure identifies auth failures", () => {
  const failure = classifyCliFailure({ stderr: "OAuth token expired. Run gemini to authenticate." });
  assert.equal(failure.category, "auth");
  assert.equal(failure.retryable, false);
  assert.match(failure.nextStep, /authenticate/i);
});

test("classifyCliFailure identifies quota failures", () => {
  const failure = classifyCliFailure({ stderr: "RESOURCE_EXHAUSTED: quota exceeded for project" });
  assert.equal(failure.category, "quota");
  assert.equal(failure.retryable, false);
  assert.match(failure.nextStep, /quota|billing|later/i);
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
