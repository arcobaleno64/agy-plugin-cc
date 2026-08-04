import { test } from "node:test";
import assert from "node:assert/strict";

import { runGeminiReview, runGeminiTurn } from "../plugins/gemini/scripts/lib/gemini.mjs";

// AGY's stdout envelope, captured verbatim from a live `agy --output-format json`
// run on 1.1.10. Keep these shapes tied to real output — an injected fake is only
// as good as the sample it was built from.
const SUCCESS_ENVELOPE = {
  conversation_id: "8cd8584a-fd2a-4229-8dff-61aecdaaead1",
  status: "SUCCESS",
  response: "17 × 23 = 391\n",
  duration_seconds: 3.3086563,
  num_turns: 1,
  usage: { input_tokens: 22872, output_tokens: 180, thinking_tokens: 165, cache_read_tokens: 0, total_tokens: 23052 }
};

const ERROR_ENVELOPE = {
  conversation_id: "",
  status: "ERROR",
  response: "",
  error: 'invalid model selection (--model "definitely-not-a-real-model" --effort ""): model definitely-not-a-real-model is not recognized as a known model or custom model in settings',
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }
};

function agyEngine(version = "1.1.10") {
  return () => ({ engine: "agy", binary: "/fake/agy.exe", version });
}

// Records the argv it was handed so a test can assert on the constructed command
// without spawning anything.
function stubRun({ stdout = "", stderr = "", status = 0 } = {}) {
  const calls = [];
  const fn = (binary, args, opts) => {
    calls.push({ binary, args, opts });
    return { stdout, stderr, status };
  };
  fn.calls = calls;
  return fn;
}

test("AGY 1.1.10 turn takes response and conversation id from the envelope", async () => {
  const runCommandFn = stubRun({ stdout: `${JSON.stringify(SUCCESS_ENVELOPE)}\n` });

  const result = await runGeminiTurn("/repo", { prompt: "hi", write: false }, {
    runCommandFn,
    detectEngineFn: agyEngine()
  });

  assert.equal(result.status, 0);
  assert.equal(result.finalMessage, "17 × 23 = 391");
  assert.equal(result.threadId, "8cd8584a-fd2a-4229-8dff-61aecdaaead1");
  assert.equal(result.failure ?? null, null);

  const [call] = runCommandFn.calls;
  assert.deepEqual(
    call.args.slice(call.args.indexOf("--output-format"), call.args.indexOf("--output-format") + 2),
    ["--output-format", "json"]
  );
});

test("AGY 1.1.10 turn classifies an ERROR envelope from its error string", async () => {
  const runCommandFn = stubRun({ stdout: `${JSON.stringify(ERROR_ENVELOPE)}\n`, status: 1 });

  const result = await runGeminiTurn("/repo", { prompt: "hi", write: false }, {
    runCommandFn,
    detectEngineFn: agyEngine()
  });

  assert.notEqual(result.status, 0);
  // The envelope's `error` reaches the classifier; AGY leaves stderr empty here.
  assert.equal(result.failure.category, "model-unavailable");
  assert.equal(result.failure.retryable, false);
});

// Review finding on #30: conversation_id identifies the conversation, not the
// envelope, and may be absent entirely.
test("AGY 1.1.10 turn accepts an ERROR envelope that omits conversation_id", async () => {
  const runCommandFn = stubRun({
    stdout: JSON.stringify({ status: "ERROR", error: "model bogus is not recognized as a known model" }),
    status: 1
  });

  const result = await runGeminiTurn("/repo", { prompt: "hi", write: false }, {
    runCommandFn,
    detectEngineFn: agyEngine()
  });

  assert.equal(result.failure.category, "model-unavailable");
  assert.equal(result.threadId ?? null, null);
});

// Only SUCCESS and ERROR have been observed; whether that vocabulary is closed is
// an open question upstream (antigravity-cli#546), so an unknown status must be
// treated as a failure rather than rejected as a malformed envelope.
test("AGY 1.1.10 turn treats an unrecognized status as failure, not malformed output", async () => {
  const runCommandFn = stubRun({
    stdout: JSON.stringify({ conversation_id: "abc", status: "CANCELLED", response: "" }),
    status: 1
  });

  const result = await runGeminiTurn("/repo", { prompt: "hi", write: false }, {
    runCommandFn,
    detectEngineFn: agyEngine()
  });

  assert.notEqual(result.status, 0);
  assert.notEqual(result.failure.category, "invalid-json");
});

test("AGY 1.1.10 turn reports invalid-json when stdout is not an envelope", async () => {
  const runCommandFn = stubRun({ stdout: "AGY printed prose instead of JSON\n", status: 0 });

  const result = await runGeminiTurn("/repo", { prompt: "hi", write: false }, {
    runCommandFn,
    detectEngineFn: agyEngine()
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.failure.category, "invalid-json");
});

test("AGY 1.1.7 never requests the envelope", async () => {
  const runCommandFn = stubRun({ stdout: "ignored\n" });

  // Transcript recovery finds nothing here and reports a failure rather than
  // throwing, so the run completes and the argv is all this test needs.
  await runGeminiTurn("/repo", { prompt: "hi", write: false }, {
    runCommandFn,
    detectEngineFn: agyEngine("1.1.7")
  });

  const [call] = runCommandFn.calls;
  assert.ok(!call.args.includes("--output-format"), "1.1.7 predates the JSON envelope");
});

// The review path does something the task path does not: it parses findings JSON
// out of the envelope's `response`. That nesting — JSON inside the envelope's
// string field — is where a naive "just parse stdout" would go wrong.
test("AGY 1.1.10 review parses findings JSON out of the envelope response", async () => {
  const findings = { verdict: "changes-requested", findings: [{ file: "src/app.js", line: 2, summary: "off-by-one" }] };
  const runCommandFn = stubRun({
    stdout: JSON.stringify({ ...SUCCESS_ENVELOPE, response: JSON.stringify(findings) })
  });

  const result = await runGeminiReview("/repo", { prompt: "review this" }, {
    runCommandFn,
    detectEngineFn: agyEngine()
  });

  assert.equal(result.status, 0);
  assert.deepEqual(result.reviewJson, findings);
  assert.equal(result.failure ?? null, null);
});

test("AGY 1.1.10 review reports invalid-json when the response is not findings JSON", async () => {
  const runCommandFn = stubRun({
    stdout: JSON.stringify({ ...SUCCESS_ENVELOPE, response: "I reviewed it and it looks fine to me." })
  });

  const result = await runGeminiReview("/repo", { prompt: "review this" }, {
    runCommandFn,
    detectEngineFn: agyEngine()
  });

  // The envelope parsed; its payload did not. Those are different failures.
  assert.equal(result.failure.category, "invalid-json");
});
