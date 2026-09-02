import { test } from "node:test";
import assert from "node:assert/strict";

import { tryParseJsonFromText, isTransientReviewFailure } from "../plugins/gemini/scripts/lib/gemini.mjs";

test("parses a clean JSON payload", () => {
  const obj = tryParseJsonFromText('{"verdict":"approve","summary":"s","findings":[],"next_steps":[]}');
  assert.equal(obj.verdict, "approve");
});

test("recovers the real JSON after a non-JSON preamble and control chars", () => {
  // Mirrors the observed gemini 0.44.1 pollution: control tokens + an
  // `update_topic{...}` block emitted before the actual review JSON.
  const polluted =
    "\x1b\x1b\x1bupdate_topic{strategic_intent:Review the diff,summary:The user provided context}" +
    '\n{"verdict":"needs-attention","summary":"x",' +
    '"findings":[{"severity":"high","title":"t","body":"b","file":"f","line_start":1,"line_end":2,"confidence":0.9,"recommendation":"r"}],' +
    '"next_steps":[]}';
  const obj = tryParseJsonFromText(polluted);
  assert.ok(obj, "should recover the trailing JSON object");
  assert.equal(obj.verdict, "needs-attention");
  assert.equal(obj.findings[0].severity, "high");
  assert.equal(obj.findings[0].title, "t");
});

test("returns the LAST balanced JSON object when several appear", () => {
  const obj = tryParseJsonFromText('{"a":1} some noise {"b":2}');
  assert.equal(obj.b, 2);
});

test("ignores braces inside JSON strings", () => {
  const obj = tryParseJsonFromText('prefix {"summary":"has } and { braces","verdict":"approve"} suffix');
  assert.equal(obj.verdict, "approve");
  assert.equal(obj.summary, "has } and { braces");
});

test("returns null when no JSON object is present", () => {
  assert.equal(tryParseJsonFromText("no json here"), null);
  assert.equal(tryParseJsonFromText(""), null);
});

test("parses the outer gemini envelope carrying a stringified response", () => {
  const obj = tryParseJsonFromText('{"session_id":"thr_1","response":"hello world"}');
  assert.equal(obj.session_id, "thr_1");
  assert.equal(obj.response, "hello world");
});

test("recovers the JSON object when trailing log noise follows it", () => {
  const obj = tryParseJsonFromText('{"verdict":"approve","summary":"s","findings":[]}\nDone. exit 0\n');
  assert.equal(obj.verdict, "approve");
});

test("isTransientReviewFailure: structured findings are never transient", () => {
  assert.equal(
    isTransientReviewFailure({ reviewJson: { verdict: "approve" }, reviewText: "", stderr: "" }),
    false
  );
});

test("isTransientReviewFailure: empty stdout+stderr is transient", () => {
  assert.equal(isTransientReviewFailure({ reviewJson: null, reviewText: "", stderr: "" }), true);
});

test("isTransientReviewFailure: the malformed envelope is transient on either channel", () => {
  // stderr (the common case)…
  assert.equal(
    isTransientReviewFailure({ reviewJson: null, reviewText: "", stderr: "Invalid stream: ...malformed tool call" }),
    true
  );
  // …and stdout (builds that emit the envelope with exit 0).
  assert.equal(
    isTransientReviewFailure({ reviewJson: null, reviewText: "Invalid stream: empty response", stderr: "" }),
    true
  );
});

test("isTransientReviewFailure: a transport flake on stderr is transient", () => {
  assert.equal(
    isTransientReviewFailure({ reviewJson: null, reviewText: "", stderr: "503: service temporarily unavailable" }),
    true
  );
});

test("isTransientReviewFailure: a real prose review mentioning HTTP codes is NOT transient", () => {
  // Channel separation in action: loose transport words in the review's own prose
  // (stdout) must not be mistaken for a transport flake on stderr.
  const prose = "The handler returns a 500 and ignores the rate limit; it is unavailable under load.";
  assert.equal(isTransientReviewFailure({ reviewJson: null, reviewText: prose, stderr: "" }), false);
});

// ---------------------------------------------------------------------------
// Quota is not a flake. `429` and `resource_exhausted` are in the transport
// heuristic because a passing rate limit says them — but so does a project over
// its spend cap, and retrying that spends wall-clock to reach the same refusal
// three times. classifyCliFailure is the tiebreak: it ranks `quota`
// (retryable:false) ahead of `rate-limit` (retryable:true), and these pin that
// the retry wrapper actually consults it.
// ---------------------------------------------------------------------------

test("isTransientReviewFailure: an exhausted spend cap is NOT transient", () => {
  const stderr =
    '{"type":"Error","message":"Your project has exceeded its monthly spending cap. Please go to AI Studio to manage your project spend cap.","code":429}';
  assert.equal(isTransientReviewFailure({ reviewJson: null, reviewText: "", stderr }), false);
});

test("isTransientReviewFailure: RESOURCE_EXHAUSTED is NOT transient", () => {
  assert.equal(
    isTransientReviewFailure({ reviewJson: null, reviewText: "", stderr: "RESOURCE_EXHAUSTED: quota exceeded" }),
    false
  );
});

test("isTransientReviewFailure: a plain rate limit with no quota wording stays transient", () => {
  // The guard must not swallow the case the retry was built for.
  assert.equal(
    isTransientReviewFailure({ reviewJson: null, reviewText: "", stderr: "429 Too Many Requests" }),
    true
  );
});
