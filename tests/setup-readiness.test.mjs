import test from "node:test";
import assert from "node:assert/strict";

import { buildSetupReport } from "../plugins/gemini/scripts/gemini-companion.mjs";
import { probeAgyLogin } from "../plugins/gemini/scripts/lib/gemini.mjs";
import { makeTempDir } from "./helpers.mjs";

// ---------------------------------------------------------------------------
// probeAgyLogin
//
// The defect this answers: getAgyLoginStatus can only say "unknown", so
// /gemini:setup told the user to "run an `--engine agy` command to confirm it is
// logged in" — spend a billed turn, then read the answer out of whether it
// failed. AGY 1.1.11 answers `/quota` in print mode from the account without
// starting a turn, which is a real auth check at no token cost.
// ---------------------------------------------------------------------------

const AGY_ENVELOPE = {
  conversation_id: "",
  status: "SUCCESS",
  response: "Gemini Models\tWeekly Limit Remaining\t84%\t2026-08-12T00:16:21Z\n",
  duration_seconds: 0,
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 }
};

function agyEngine(version) {
  return () => ({ engine: "agy", binary: "/fake/agy.exe", version });
}

function stubRun(result) {
  const calls = [];
  const fn = (binary, args, opts) => {
    calls.push({ binary, args, opts });
    return { stdout: "", stderr: "", status: 0, ...result };
  };
  fn.calls = calls;
  return fn;
}

test("the AGY probe asks a read-only question, so it costs no turn", () => {
  const runCommandFn = stubRun({ stdout: `${JSON.stringify(AGY_ENVELOPE)}\n` });

  const status = probeAgyLogin({ runCommandFn, detectEngineFn: agyEngine("1.1.11") });

  assert.equal(status.loggedIn, true);
  assert.equal(status.state, "verified");
  assert.equal(status.verifiable, true);

  const [call] = runCommandFn.calls;
  // The read-only slash command, not a prompt. `-p "/quota"` is answered from
  // the account; anything else here would be a billed turn.
  assert.ok(call.args.includes("/quota"), "the probe must ask a read-only slash command");
  assert.deepEqual(
    call.args.slice(call.args.indexOf("--output-format"), call.args.indexOf("--output-format") + 2),
    ["--output-format", "json"]
  );
  // Resolved through detectEngine, so on Windows this is an absolute .exe and no
  // shell is involved — a shell would rewrite the leading `/` into a path.
  assert.equal(call.binary, "/fake/agy.exe");
});

// Below 1.1.11 the same input is sent to the model as literal prompt text, so
// probing would cost a turn and prove nothing.
test("the AGY probe refuses on a version that would charge for it", () => {
  const runCommandFn = stubRun({ stdout: `${JSON.stringify(AGY_ENVELOPE)}\n` });

  const status = probeAgyLogin({ runCommandFn, detectEngineFn: agyEngine("1.1.10") });

  assert.equal(status.state, "unknown");
  assert.equal(status.verifiable, false);
  assert.match(status.detail, /1\.1\.11/);
  assert.deepEqual(runCommandFn.calls, [], "no version below 1.1.11 may be spawned for a probe");
});

test("an unauthenticated AGY is reported as logged out, with proof", () => {
  const runCommandFn = stubRun({
    stdout: JSON.stringify({ ...AGY_ENVELOPE, status: "ERROR", response: "", error: "unauthenticated: login required" }),
    status: 1
  });

  const status = probeAgyLogin({ runCommandFn, detectEngineFn: agyEngine("1.1.11") });

  assert.equal(status.loggedIn, false);
  assert.equal(status.state, "logged-out");
  assert.equal(status.verifiable, true);
});

// A probe that fails for some other reason must not be upgraded into "not
// logged in" — that is the same over-claiming the unknown state exists to avoid.
test("a probe that fails for another reason leaves the state unknown", () => {
  const runCommandFn = stubRun({ stdout: "", stderr: "connection reset", status: 1 });

  const status = probeAgyLogin({ runCommandFn, detectEngineFn: agyEngine("1.1.11") });

  assert.equal(status.state, "unknown");
  assert.equal(status.verifiable, false);
  assert.equal(status.loggedIn, false);
});

// ---------------------------------------------------------------------------
// Readiness mapping
// ---------------------------------------------------------------------------

function agyStatus(state) {
  return {
    loggedIn: state === "verified",
    state,
    verifiable: state === "verified" || state === "logged-out",
    detail: `AGY probe reported ${state}.`
  };
}

test("a verified AGY reaches ready, the state --engine agy could never hold", () => {
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "agy",
    probedAgy: true,
    agyLoginStatusFn: () => agyStatus("verified")
  });

  assert.equal(report.readyState, "ready");
  assert.equal(report.ready, true);
  assert.deepEqual(report.nextSteps, [], "a verified engine has nothing left to do");
});

// The reported false alarm: `readyState: "partial"` for an AGY that was in fact
// working. Unknown still means partial — but it now names a zero-cost way out
// instead of telling the user to spend a turn finding out.
test("an unprobed AGY stays partial but is told how to check for free", () => {
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "agy",
    agyLoginStatusFn: () => agyStatus("unknown")
  });

  assert.equal(report.readyState, "partial");
  assert.equal(report.ready, false);
  assert.match(report.nextSteps.join("\n"), /--probe-agy/);
  assert.doesNotMatch(
    report.nextSteps.join("\n"),
    /Run an `--engine agy` command to confirm/,
    "the old advice was to spend a billed turn to learn the answer"
  );
});

// Verified-logged-out is worse than unknown and must not share its state.
test("a probed-and-logged-out AGY is not-ready, not partial", () => {
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "agy",
    probedAgy: true,
    agyLoginStatusFn: () => agyStatus("logged-out")
  });

  assert.equal(report.readyState, "not-ready");
  assert.equal(report.ready, false);
  assert.match(report.nextSteps.join("\n"), /not signed in/i);
});

// The reported contradiction: `geminiReady: true` beside
// `geminiAuth.loggedIn: false`. Both are true and they answer different
// questions; the report now names which credential satisfied readiness.
test("the report names the credential that satisfied gemini readiness", () => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key";
  try {
    const report = buildSetupReport(makeTempDir(), [], {
      engine: "gemini",
      agyLoginStatusFn: () => agyStatus("unknown")
    });
    if (!report.gemini.available) {
      return; // no gemini CLI on this machine; the source field is exercised below
    }
    assert.equal(report.geminiCredentialSource, "env-api-key");
    assert.equal(report.geminiReady, true);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
});

test("the credential source says so plainly when there is no engine", () => {
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "gemini",
    agyLoginStatusFn: () => agyStatus("unknown")
  });

  if (report.gemini.available) {
    assert.notEqual(report.geminiCredentialSource, "engine-unavailable");
    return;
  }
  assert.equal(report.geminiCredentialSource, "engine-unavailable");
});
