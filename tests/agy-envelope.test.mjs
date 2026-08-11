import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { MIN_TURN_TIMEOUT_SECONDS, probeAgyLogin, runGeminiReview, runGeminiTurn } from "../plugins/gemini/scripts/lib/gemini.mjs";

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

// The spawn caps stdout at MAX_BUFFER (50 MB); past that Node kills the child
// and hands back whatever it had, so an oversized envelope arrives cut mid-token
// rather than as a clean object. tryParseJsonFromText scans for balanced {...}
// blocks, so the question is whether a truncated payload can still yield an
// object the plugin would act on. It must not.
test("AGY 1.1.10 turn rejects an envelope truncated mid-value", async () => {
  const full = JSON.stringify({ ...SUCCESS_ENVELOPE, response: "x".repeat(4096) });
  const runCommandFn = stubRun({ stdout: full.slice(0, full.length - 200), status: 0 });

  const result = await runGeminiTurn("/repo", { prompt: "hi", write: false }, {
    runCommandFn,
    detectEngineFn: agyEngine()
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.failure.category, "invalid-json");
});

// A truncated envelope whose `usage` object closed before the cut leaves a
// balanced {...} block behind. The scan must not mistake that fragment for the
// envelope and report a successful run with no response.
test("AGY 1.1.10 turn rejects a truncation that leaves a balanced inner object", async () => {
  const stdout = '{"conversation_id":"abc","status":"SUCCESS","usage":{"total_tokens":42},"response":"partia';
  const runCommandFn = stubRun({ stdout, status: 0 });

  const result = await runGeminiTurn("/repo", { prompt: "hi", write: false }, {
    runCommandFn,
    detectEngineFn: agyEngine()
  });

  assert.notEqual(result.status, 0, "an inner fragment must not read as a completed run");
  assert.equal(result.failure.category, "invalid-json");
});

// A very large but well-formed envelope is a cost problem, not a correctness
// one: it is under the spawn cap, so it parses and the response is delivered
// whole. Pinned so a future size limit is a deliberate change with a visible
// diff rather than a silent truncation of someone's result.
test("AGY 1.1.10 turn delivers a large well-formed envelope intact", async () => {
  const response = "y".repeat(2 * 1024 * 1024);
  const runCommandFn = stubRun({ stdout: JSON.stringify({ ...SUCCESS_ENVELOPE, response }), status: 0 });

  const result = await runGeminiTurn("/repo", { prompt: "hi", write: false }, {
    runCommandFn,
    detectEngineFn: agyEngine()
  });

  assert.equal(result.status, 0);
  assert.equal(result.finalMessage.length, response.length);
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

// --- engine selection ---
// The review path used to pass "gemini" as its default, which reads to
// detectEngine as an *explicit* request — and an explicit request deliberately
// skips the credential check, because a user naming an engine should get it or a
// clear error. The result was that a gemini CLI installed but unauthenticated
// captured every review and failed it, with a working AGY sitting beside it.
// Only a missing gemini *binary* reached the fallback.

function recordingEngine() {
  const calls = [];
  const fn = (requested) => {
    calls.push(requested);
    return { engine: "agy", binary: "/fake/agy.exe", version: "1.1.10" };
  };
  fn.calls = calls;
  return fn;
}

test("a review with no engine asked for routes through auto, exactly like a task", async () => {
  const reviewEngine = recordingEngine();
  await runGeminiReview("/repo", { prompt: "review this" }, {
    runCommandFn: stubRun({ stdout: JSON.stringify({ ...SUCCESS_ENVELOPE, response: '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}' }) }),
    detectEngineFn: reviewEngine
  });

  const taskEngine = recordingEngine();
  await runGeminiTurn("/repo", { prompt: "do this", write: false }, {
    runCommandFn: stubRun({ stdout: JSON.stringify(SUCCESS_ENVELOPE) }),
    detectEngineFn: taskEngine
  });

  assert.deepEqual(reviewEngine.calls, [null], "review still names an engine of its own");
  assert.deepEqual(reviewEngine.calls, taskEngine.calls, "review and task disagree on engine selection");
});

test("an explicitly requested engine is still passed through untouched", async () => {
  for (const requested of ["gemini", "agy", "auto"]) {
    const engine = recordingEngine();
    await runGeminiReview("/repo", { prompt: "review this", engine: requested }, {
      runCommandFn: stubRun({ stdout: JSON.stringify({ ...SUCCESS_ENVELOPE, response: '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}' }) }),
      detectEngineFn: engine
    });
    assert.deepEqual(engine.calls, [requested]);
  }
});

// detectEngine is the single place that decides, and it already refuses an
// unauthenticated gemini under `auto` (engine.test.mjs). This asserts the review
// path actually reaches that decision rather than pre-empting it.
test("an unauthenticated gemini no longer captures the review path", async () => {
  const engine = recordingEngine();
  await runGeminiReview("/repo", { prompt: "review this" }, {
    runCommandFn: stubRun({ stdout: JSON.stringify({ ...SUCCESS_ENVELOPE, response: '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}' }) }),
    detectEngineFn: engine
  });
  assert.ok(!engine.calls.includes("gemini"), "review asked for gemini by name and skipped the credential check");
});

// ---------------------------------------------------------------------------
// Timeout window and killed-run recovery
// ---------------------------------------------------------------------------

// A brain directory with no conversations yet, plus the writer that creates one.
// Recovery identifies this run's conversation by diffing the directory listing
// taken before the spawn against the one after, so the conversation has to appear
// *during* the call — which is when agy creates it. Seeding it up front makes it
// invisible to that diff, and the fixture then silently proves nothing.
function seedAgyBrain() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-"));
  const brain = path.join(home, ".gemini", "antigravity-cli", "brain");
  fs.mkdirSync(brain, { recursive: true });

  const writeTranscript = ({ status = "DONE", content = "recovered response" } = {}) => {
    const logs = path.join(brain, "conv-0001", ".system_generated", "logs");
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(
      path.join(logs, "transcript_full.jsonl"),
      `${JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", status, content })}\n`,
      "utf8"
    );
  };
  return { home, writeTranscript };
}

// Writes the transcript as agy would, then returns as a killed process does.
function stubKilledRun(writeTranscript, row) {
  return () => {
    writeTranscript(row);
    return { stdout: "", stderr: "", status: null };
  };
}

function withHome(home, body) {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return body();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// The defect this pins: on a structured run the plugin read only stdout, so a
// turn that the hard spawn timeout SIGKILLed before it could print its envelope
// was reported as a failure with no output — while the response it had already
// produced, and been billed for, sat in the transcript on disk. The pre-1.1.8
// path had always known how to read that file.
test("a killed AGY run recovers its already-billed output from the transcript", async () => {
  const { home, writeTranscript } = seedAgyBrain();

  const result = await withHome(home, () =>
    runGeminiTurn("/repo", { prompt: "hi", write: false }, {
      // SIGKILL before printing: the transcript exists, stdout does not.
      runCommandFn: stubKilledRun(writeTranscript, { status: "DONE", content: "the answer is 42" }),
      detectEngineFn: agyEngine()
    })
  );

  assert.equal(result.finalMessage, "the answer is 42");
  assert.equal(result.status, 0, "a completed transcript row means the work finished");
  assert.equal(result.failure ?? null, null);
});

test("a killed AGY run returns partial output but does not call it success", async () => {
  const { home, writeTranscript } = seedAgyBrain();

  const result = await withHome(home, () =>
    runGeminiTurn("/repo", { prompt: "hi", write: false }, {
      runCommandFn: stubKilledRun(writeTranscript, { status: "IN_PROGRESS", content: "half an ans" }),
      detectEngineFn: agyEngine()
    })
  );

  assert.equal(result.finalMessage, "half an ans", "partial output must still be returned");
  assert.notEqual(result.status, 0);
  assert.ok(result.failure, "an unfinished transcript row is not a success");
});

// Narrow on purpose: output that arrived and failed to parse is a malformed run,
// which is what the "the version already promised an envelope" rule is about.
// Only output that never arrived falls back.
test("unparseable AGY stdout is still a failure, not a transcript lookup", async () => {
  const { home, writeTranscript } = seedAgyBrain();

  const result = await withHome(home, () =>
    runGeminiTurn("/repo", { prompt: "hi", write: false }, {
      runCommandFn: () => {
        writeTranscript({ status: "DONE", content: "SHOULD_NOT_BE_USED" });
        return { stdout: "this is not an envelope", stderr: "", status: 1 };
      },
      detectEngineFn: agyEngine()
    })
  );

  assert.doesNotMatch(String(result.finalMessage ?? ""), /SHOULD_NOT_BE_USED/);
  assert.notEqual(result.status, 0);
});

// The defect this pins: the flush grace window was computed in milliseconds and
// then rounded up to whole minutes, so the 105,000 ms window became `2m` — the
// exact hard-kill deadline it was meant to precede by 15 seconds. AGY was
// SIGKILLed instead of self-terminating, which is what left stdout empty.
test("AGY's print-timeout lands before the hard kill, not on it", async () => {
  const runCommandFn = stubRun({ stdout: `${JSON.stringify(SUCCESS_ENVELOPE)}\n` });

  await runGeminiTurn("/repo", { prompt: "hi", write: false }, {
    runCommandFn,
    detectEngineFn: agyEngine()
  });

  const [call] = runCommandFn.calls;
  const printTimeout = call.args[call.args.indexOf("--print-timeout") + 1];
  const printTimeoutMs = Number(printTimeout.replace(/s$/, "")) * 1000;
  assert.match(printTimeout, /^\d+s$/, "whole-minute rounding cannot express the grace window");
  assert.ok(
    printTimeoutMs < call.opts.timeout,
    `print-timeout ${printTimeoutMs}ms must precede the ${call.opts.timeout}ms hard kill`
  );
});

test("--timeout raises both the hard kill and AGY's own window", async () => {
  const runCommandFn = stubRun({ stdout: `${JSON.stringify(SUCCESS_ENVELOPE)}\n` });

  await runGeminiTurn("/repo", { prompt: "hi", write: false, timeoutSeconds: 600 }, {
    runCommandFn,
    detectEngineFn: agyEngine()
  });

  const [call] = runCommandFn.calls;
  assert.equal(call.opts.timeout, 600_000);
  assert.equal(call.args[call.args.indexOf("--print-timeout") + 1], "585s");
});

// Subtracting a flat 15s and flooring the result at 30s made the grace window
// vanish at the documented minimum: `--timeout 30` produced a 30s print-timeout
// against a 30s hard kill, so AGY self-terminated on the same tick spawnSync
// SIGKILLed it — the identical failure the minute-rounding used to cause, just
// reached from the other end of the range.
test("the grace window survives the smallest timeout the CLI accepts", async () => {
  const runCommandFn = stubRun({ stdout: `${JSON.stringify(SUCCESS_ENVELOPE)}\n` });

  await runGeminiTurn("\repo", { prompt: "hi", write: false, timeoutSeconds: MIN_TURN_TIMEOUT_SECONDS }, {
    runCommandFn,
    detectEngineFn: agyEngine()
  });

  const [call] = runCommandFn.calls;
  const printTimeoutMs = Number(call.args[call.args.indexOf("--print-timeout") + 1].replace(/s$/, "")) * 1000;
  assert.equal(call.opts.timeout, MIN_TURN_TIMEOUT_SECONDS * 1000);
  assert.ok(
    printTimeoutMs < call.opts.timeout,
    `print-timeout ${printTimeoutMs}ms must precede the ${call.opts.timeout}ms hard kill, not equal it`
  );
});

// The probe spawned `--print-timeout 30s` under a 30s kill, so a slow but
// authenticated account was killed at the moment it would have answered and
// reported back as `unknown`.
test("the AGY probe leaves itself room to answer before being killed", () => {
  const runCommandFn = stubRun({ stdout: "", stderr: "", status: 1 });

  probeAgyLogin({ runCommandFn, detectEngineFn: agyEngine("1.1.11") });

  const [call] = runCommandFn.calls;
  const printTimeoutMs = Number(call.args[call.args.indexOf("--print-timeout") + 1].replace(/s$/, "")) * 1000;
  assert.ok(
    printTimeoutMs < call.opts.timeout,
    `probe print-timeout ${printTimeoutMs}ms must precede the ${call.opts.timeout}ms kill`
  );
});
