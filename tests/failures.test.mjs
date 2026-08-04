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
