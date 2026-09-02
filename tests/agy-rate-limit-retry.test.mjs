import test from "node:test";
import assert from "node:assert/strict";

import {
  parseRateLimitResetMs,
  AGY_RATE_LIMIT_MAX_WAIT_MS,
  runGeminiReviewResilient
} from "../plugins/gemini/scripts/lib/gemini.mjs";

// AGY's verbatim wording, measured on 1.1.24. The retry in #142 is safe only
// because this sentence exists: it turns "retry and hope" into "wait exactly this
// long, then retry".
const AGY_RATE_LIMIT =
  "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 58s.";

test("the reset AGY states is read out of its own message", () => {
  // 58s plus the one-second grace: a retry landing on the same tick is refused
  // again for nothing.
  assert.equal(parseRateLimitResetMs(AGY_RATE_LIMIT), 59_000);
  assert.equal(parseRateLimitResetMs("Resets in 8s."), 9_000);
  assert.equal(parseRateLimitResetMs("resets in 1 minute"), 61_000);
});

// The whole design rests on not guessing. This wrapper has no backoff, so an
// immediate retry against a limit that has not cleared burns every attempt in
// seconds and reports the same refusal -- worse than failing once.
test("a message that does not say when it clears yields no wait, not a default", () => {
  assert.equal(parseRateLimitResetMs("Individual quota reached."), null);
  assert.equal(parseRateLimitResetMs("429 Too Many Requests"), null);
  assert.equal(parseRateLimitResetMs(""), null);
  assert.equal(parseRateLimitResetMs(null), null);
  assert.equal(parseRateLimitResetMs("Resets in 0s"), null);
});

test("a reset further out than the ceiling is not waited for", () => {
  assert.equal(parseRateLimitResetMs("Resets in 3600s"), null);
  assert.equal(parseRateLimitResetMs("Resets in 30 minutes"), null);
  // And the ceiling is a real bound, not a comment.
  const justUnder = parseRateLimitResetMs(`Resets in ${Math.floor((AGY_RATE_LIMIT_MAX_WAIT_MS - 1000) / 1000)}s`);
  assert.ok(justUnder !== null && justUnder <= AGY_RATE_LIMIT_MAX_WAIT_MS, `got ${justUnder}`);
});

// ---------------------------------------------------------------------------
// The wrapper's own branching. Before #142 an AGY review returned on attempt 1
// unconditionally, so a limit AGY itself said would clear in 58 seconds ended the
// review outright. These pin both halves of the narrowed exclusion: it retries
// the rate limit, and it still retries nothing else.
// ---------------------------------------------------------------------------

function agyEnvelope(error) {
  return `${JSON.stringify({
    conversation_id: "", status: "ERROR", response: "", error,
    duration_seconds: 0, num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }
  })}\n`;
}

function stubAgy(errors) {
  const calls = [];
  return {
    calls,
    detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.1.24" }),
    runCommandFn: (binary, args) => {
      calls.push(args);
      const error = errors[Math.min(calls.length - 1, errors.length - 1)];
      return { status: 1, stdout: agyEnvelope(error), stderr: "", signal: null, error: null };
    }
  };
}

const RATE_LIMIT = "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 58s.";
const NO_RESET = "Individual quota reached. Please upgrade your subscription to increase your limits.";
const BAD_MODEL = 'invalid model selection (--model "x"): model x is not recognized as a known model or custom model in settings';

test("an AGY rate limit that states its reset is waited out and retried", async () => {
  const stub = stubAgy([RATE_LIMIT]);
  const waits = [];
  const result = await runGeminiReviewResilient("/repo", { prompt: "p", engine: "agy" }, {
    ...stub, maxAttempts: 3, rateLimitWaitBudgetMs: 200_000, sleepFn: async (ms) => { waits.push(ms); }
  });
  assert.equal(stub.calls.length, 3, "all three attempts are used");
  assert.deepEqual(waits, [59_000, 59_000], "and each retry waits the stated reset, not zero");
  assert.equal(result.attempts, 3);
});

test("an AGY rate limit with no stated reset is not retried", async () => {
  // No backoff exists here, so retrying without a stated reset burns the attempts
  // in seconds and reaches the same refusal.
  const stub = stubAgy([NO_RESET]);
  const waits = [];
  const result = await runGeminiReviewResilient("/repo", { prompt: "p", engine: "agy" }, {
    ...stub, maxAttempts: 3, rateLimitWaitBudgetMs: 200_000, sleepFn: async (ms) => { waits.push(ms); }
  });
  assert.equal(stub.calls.length, 1);
  assert.deepEqual(waits, []);
  assert.equal(result.attempts, 1);
});

test("AGY still fails fast on everything that is not a rate limit", async () => {
  // The allowlist is what keeps `tool-permission-denied` and brain-root
  // `transcript-missing` unreachable -- neither is in ACCOUNT_STATE_FAILURES and
  // none of the heuristics name them, so a denylist would have exposed both.
  const stub = stubAgy([BAD_MODEL]);
  const result = await runGeminiReviewResilient("/repo", { prompt: "p", engine: "agy" }, {
    ...stub, maxAttempts: 3, rateLimitWaitBudgetMs: 200_000, sleepFn: async () => { throw new Error("must not wait"); }
  });
  assert.equal(stub.calls.length, 1, "no retry for a deterministic refusal");
  assert.equal(result.failure.category, "model-unavailable");
});

test("a rate-limited AGY review that clears returns the review, not the refusal", async () => {
  const stub = stubAgy([RATE_LIMIT]);
  let call = 0;
  stub.runCommandFn = (binary, args) => {
    stub.calls.push(args);
    call += 1;
    if (call === 1) return { status: 1, stdout: agyEnvelope(RATE_LIMIT), stderr: "", signal: null, error: null };
    return {
      status: 0, stderr: "", signal: null, error: null,
      stdout: `${JSON.stringify({
        conversation_id: "c1", status: "SUCCESS",
        response: JSON.stringify({ verdict: "pass", summary: "ok", findings: [] }),
        duration_seconds: 1, num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 }
      })}\n`
    };
  };
  const result = await runGeminiReviewResilient("/repo", { prompt: "p", engine: "agy" }, {
    ...stub, maxAttempts: 3, rateLimitWaitBudgetMs: 200_000, sleepFn: async () => {}
  });
  assert.equal(result.attempts, 2, "the second attempt is the one that counts");
  assert.equal(result.status, 0);
  assert.ok(result.reviewJson, "and the review it produced is what comes back");
});

// This is the test that actually pins the allowlist, and it exists because the
// first version of this file did not. Mutating `category === "rate-limit"` into a
// condition that admits every category left the suite green: the only fixture for
// "not a rate limit" was a bad-model message, which carries no reset either, so
// the RESET PARSER was doing the rejecting and the allowlist was never exercised.
//
// A refusal that both is outside the allowlist and states a reset separates them.
// `tool-permission-denied` is the case the fence in isTransientReviewFailure names
// by hand: it is outside ACCOUNT_STATE_FAILURES, no heuristic matches it, and it
// was safe only while agy returned before any of that was consulted. Retrying it
// never helps -- the permission cannot be granted headlessly, so a wait changes
// nothing and costs a minute.
test("a non-rate-limit refusal is not retried even when it states a reset", async () => {
  const stub = stubAgy([
    "A tool was auto-denied: headless mode cannot prompt for permission. Resets in 30s."
  ]);
  const waits = [];
  const result = await runGeminiReviewResilient("/repo", { prompt: "p", engine: "agy" }, {
    ...stub, maxAttempts: 3, rateLimitWaitBudgetMs: 200_000, sleepFn: async (ms) => { waits.push(ms); }
  });
  assert.equal(result.failure.category, "tool-permission-denied", "fixture must hit the category under test");
  assert.equal(stub.calls.length, 1, "the allowlist, not the reset parser, must stop this");
  assert.deepEqual(waits, []);
});

// ---------------------------------------------------------------------------
// Review round 1 on #145. Four findings, and three of them are about the retry
// firing when it should not.
// ---------------------------------------------------------------------------

// Under stream-json an ERROR envelope with an empty `response` still yields
// salvaged partial text, which runGeminiReview can parse into reviewJson while
// `failure` stays non-null. So a run can come back rate-limited mid-stream with
// the findings already in hand — and the first version of this branch keyed only
// on the category, so it discarded them to wait a minute for a bare refusal.
test("a rate-limited attempt that already produced findings is not retried away", async () => {
  const stream = [
    JSON.stringify({ event: "step_update", step_update: { conversation_id: "c1", step_index: 1,
      state: "DONE", step_type: "agent_response",
      text_delta: JSON.stringify({ verdict: "reject", summary: "found one", findings: [] }) } }),
    JSON.stringify({ event: "result", result: { conversation_id: "c1", status: "ERROR", response: "",
      error: RATE_LIMIT, duration_seconds: 1, num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 } } })
  ].join("\n");
  const calls = [];
  const result = await runGeminiReviewResilient("/repo", { prompt: "p", engine: "agy" }, {
    detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.1.24" }),
    runCommandFn: (binary, args) => { calls.push(args); return { status: 1, stdout: `${stream}\n`, stderr: "", signal: null, error: null }; },
    maxAttempts: 3, rateLimitWaitBudgetMs: 200_000,
    sleepFn: async () => { throw new Error("must not wait when findings are already in hand"); }
  });
  assert.ok(result.reviewJson, "the fixture must actually produce parsed findings");
  assert.equal(calls.length, 1, "the review in hand is kept, not thrown away");
});

// A foreground /gemini:review is one Bash call under the host's default 120s
// timeout. Sleeping there turns a clean six-second "rate limited" into a killed
// command reporting nothing, so the wait is opt-in and a caller that says nothing
// gets the old fast failure.
test("no caller waits without a budget, and the default budget is zero", async () => {
  const stub = stubAgy([RATE_LIMIT]);
  const result = await runGeminiReviewResilient("/repo", { prompt: "p", engine: "agy" }, {
    ...stub, maxAttempts: 3,
    sleepFn: async () => { throw new Error("must not wait without a budget"); }
  });
  assert.equal(stub.calls.length, 1);
  assert.equal(result.attempts, 1);
});

test("the wait budget is spent across the whole call, not refreshed per attempt", async () => {
  const stub = stubAgy([RATE_LIMIT]);
  const waits = [];
  // Room for one 59s wait, not two.
  await runGeminiReviewResilient("/repo", { prompt: "p", engine: "agy" }, {
    ...stub, maxAttempts: 3, rateLimitWaitBudgetMs: 90_000,
    sleepFn: async (ms) => { waits.push(ms); }
  });
  assert.deepEqual(waits, [59_000], "the second wait is unaffordable and ends the run");
  assert.equal(stub.calls.length, 2);
});

// normalizeDetail truncates at 2000 characters, so a long error can be non-null
// while having lost the sentence naming the reset. `detail ?? stderr` only falls
// back on a nullish detail and would never look at stderr in that case.
test("the reset is found on stderr when a truncated detail no longer carries it", async () => {
  // Quota wording first so the category survives truncation; the reset sits past
  // the 2000-character cap and is therefore lost from `detail`.
  const longError = `Individual quota reached. ${"noise ".repeat(500)}Resets in 20s.`;
  const stub = stubAgy([RATE_LIMIT]);
  stub.runCommandFn = (binary, args) => {
    stub.calls.push(args);
    return {
      status: 1, signal: null, error: null,
      stdout: `${JSON.stringify({ conversation_id: "", status: "ERROR", response: "",
        error: longError, duration_seconds: 0, num_turns: 0,
        usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 } })}\n`,
      stderr: "Individual quota reached. Resets in 20s."
    };
  };
  const waits = [];
  await runGeminiReviewResilient("/repo", { prompt: "p", engine: "agy" }, {
    ...stub, maxAttempts: 2, rateLimitWaitBudgetMs: 200_000, sleepFn: async (ms) => { waits.push(ms); }
  });
  assert.deepEqual(waits, [21_000], "stderr carried the reset the truncated detail lost");
});

test("a compound duration is refused rather than half-read", () => {
  // `1m 30s` read as 61s fires 29 seconds early, is refused again, and burns an
  // attempt plus a minute of wall clock -- the exact failure the no-guess rule
  // exists to prevent.
  assert.equal(parseRateLimitResetMs("Resets in 1m 30s."), null);
  assert.equal(parseRateLimitResetMs("Resets in 1 m 30 s"), null);
  // A plain single unit still parses, and a trailing sentence is not a duration.
  assert.equal(parseRateLimitResetMs("Resets in 30s. Try again then."), 31_000);
});
