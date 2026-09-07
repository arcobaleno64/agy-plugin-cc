#!/usr/bin/env node
"use strict";

// Fake gemini CLI used by tests/runtime.test.mjs. It is copied into a temp bin
// directory (as an extensionless `gemini`) and discovered through PATH, so the
// companion's spawnSync calls exercise the real engine-detection and
// stdin/JSON-envelope code paths without contacting the network.
//
// Contract mirrored from the real gemini CLI as consumed by lib/gemini.mjs:
//   * `gemini --version`            -> prints a version line, exit 0.
//   * `gemini ... --output-format json` (prompt on stdin)
//                                   -> prints `{ "session_id", "response" }`.
//     For task turns `response` is plain text; for reviews it is a JSON string
//     so lib/gemini.mjs can re-parse it into the structured review object.
//
// The scenario is injected via fake-gemini-config.json (written at install
// time) and every invocation is recorded to fake-gemini-state.json so tests can
// assert on the forwarded argv (model selection, --yolo, --resume, ...).

const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "fake-gemini-config.json");
const STATE_PATH = path.join(__dirname, "fake-gemini-state.json");

function readScenario() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")).scenario || "task";
  } catch {
    return "task";
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { nextThread: 1, invocations: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

const argv = process.argv.slice(2);

if (argv.includes("--version")) {
  process.stdout.write("gemini-cli test 0.0.0-fake\n");
  process.exit(0);
}

const SCENARIO = readScenario();

function buildResponse() {
  switch (SCENARIO) {
    case "review-clean":
      return JSON.stringify({
        verdict: "approve",
        summary: "No material issues found.",
        findings: [],
        next_steps: []
      });
    case "review-findings":
    case "review-noisy":
      return JSON.stringify({
        verdict: "needs-attention",
        summary: "One adversarial concern surfaced.",
        findings: [
          {
            severity: "high",
            title: "Missing empty-state guard",
            body: "The change assumes data is always present.",
            file: "src/app.js",
            line_start: 4,
            line_end: 6,
            confidence: 0.87,
            recommendation: "Handle empty collections before indexing."
          }
        ],
        next_steps: ["Add an empty-state test."]
      });
    case "review-invalid":
      return "not valid json";
    case "review-transient-then-clean":
      // 2nd+ invocation returns a clean review (the 1st fails transiently in respond()).
      return JSON.stringify({
        verdict: "approve",
        summary: "No material issues found (after a transient retry).",
        findings: [],
        next_steps: []
      });
    default:
      if (argv.includes("--resume")) {
        return "Resumed the prior run.\nFollow-up prompt accepted.";
      }
      return "Handled the requested task.\nTask prompt accepted.";
  }
}

function respond(prompt) {
  const state = loadState();
  const sessionId = "thr_" + state.nextThread++;
  const invocation = { args: argv, prompt: prompt, sessionId: sessionId };
  state.invocations.push(invocation);
  state.lastInvocation = invocation;
  saveState(state);

  // Model-not-found fallback scenario: 404 unless invoked with the GA fallback
  // model, mirroring the real CLI's ModelNotFound envelope so lib/gemini.mjs can
  // detect it and retry on gemini-2.5-flash.
  if (SCENARIO === "review-model-404") {
    if (!argv.includes("gemini-2.5-flash")) {
      process.stderr.write("ModelNotFoundError: Requested entity was not found.\n  code: 404\n");
      process.stdout.write(JSON.stringify({ session_id: sessionId, error: { type: "Error", message: "Requested entity was not found.", code: 1 } }));
      process.exit(1);
    }
    const review = JSON.stringify({
      verdict: "needs-attention",
      summary: "Reviewed on the GA fallback model.",
      findings: [
        { severity: "high", title: "Fallback-path finding", body: "Surfaced by the fallback model.", file: "src/app.js", line_start: 1, line_end: 1, confidence: 0.9, recommendation: "Address it." }
      ],
      next_steps: []
    });
    process.stdout.write(JSON.stringify({ session_id: sessionId, response: review }));
    process.exit(0);
  }

  if (SCENARIO === "review-transient-then-clean" && state.invocations.length === 1) {
    // First invocation only: emulate the intermittent gemini empty / `Invalid stream`
    // envelope so runGeminiReviewResilient must retry. The 2nd call returns clean JSON.
    process.stderr.write("Invalid stream: The model returned an empty response or malformed tool call.\n");
    process.exit(1);
  }

  if (SCENARIO === "task-fail") {
    process.stderr.write("Gemini turn failed: simulated failure.\n");
    process.exit(1);
  }

  if (SCENARIO === "review-noisy") {
    // Reasoning/thought noise on stderr must NOT pollute the stdout JSON parse.
    // The terminal-capability warning (true-color variant emitted by gemini CLI
    // 0.44.1) and the Node deprecation preamble must be filtered out of the
    // Reasoning section, not surfaced as it.
    process.stderr.write("Warning: True color (24-bit) support not detected. Using a terminal with true color enabled will result in a better visual experience.\n");
    process.stderr.write("(node:12345) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities.\n");
    // Genuine reasoning that merely contains a bracketed [DEPnn] token must survive
    // the narrowed noise filter.
    process.stderr.write("Considering empty-state edge cases...\nCross-checking [DEP12] handling in the retry path.\nReasoning complete.\n");
  }

  if (SCENARIO === "review-prose") {
    // A turn that SUCCEEDS and still yields no review: exit 0, a well-formed CLI
    // envelope, and prose where the structured verdict should be. The models do
    // this when they answer the prompt instead of obeying its output contract.
    // The plugin then carries `result: null` with an exit status of 0, which is
    // the shape the stop gate has to tell apart from a passing review.
    process.stdout.write(JSON.stringify({
      session_id: sessionId,
      response: "I looked at the diff and it seems fine to me overall. Nothing jumped out."
    }));
    process.exit(0);
  }

  const response = buildResponse();
  process.stdout.write(JSON.stringify({ session_id: sessionId, response: response }));
  process.exit(0);
}

if (process.stdin.isTTY) {
  respond("");
} else {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => respond(Buffer.concat(chunks).toString("utf8")));
  process.stdin.on("error", () => respond(""));
}
