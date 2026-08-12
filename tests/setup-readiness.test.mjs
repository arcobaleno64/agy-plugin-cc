import test from "node:test";
import assert from "node:assert/strict";

import { buildSetupReport } from "../plugins/gemini/scripts/gemini-companion.mjs";
import {
  GEMINI_PROBE_TIMEOUT_MS,
  getSessionRuntimeStatus,
  probeAgyLogin,
  probeGeminiLogin
} from "../plugins/gemini/scripts/lib/gemini.mjs";
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

// Availability is stubbed alongside the login status. Reading it off the machine
// makes the assertions below depend on whether AGY happens to be installed:
// green on a developer box, "not-ready" on every CI runner.
const AGY_INSTALLED = { available: true, version: "1.1.11" };

test("a verified AGY reaches ready, the state --engine agy could never hold", () => {
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "agy",
    probedAgy: true,
    agyAvailabilityFn: () => AGY_INSTALLED,
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
    agyAvailabilityFn: () => AGY_INSTALLED,
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
    agyAvailabilityFn: () => AGY_INSTALLED,
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
  // Injected rather than assigned onto process.env: mutating the real env made
  // this test order-dependent with anything else that reads it, and it is the same
  // seam that keeps the readiness assertions below off the runner's environment.
  //
  // The keychain opt-out travels with it so the injected key is the *only* thing
  // that can satisfy `geminiReady`. Without it this passed on a developer machine
  // off an unrelated keychain entry while failing on CI, which had none — the
  // wrong-reason pass that hides whether the env is read at all.
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "gemini",
    env: { GEMINI_API_KEY: "test-key", GEMINI_COMPANION_DISABLE_KEYCHAIN: "1" },
    geminiAvailabilityFn: () => ({ available: true, version: "0.53.1" }),
    agyLoginStatusFn: () => agyStatus("unknown")
  });

  assert.equal(report.geminiCredentialSource, "env-api-key");
  assert.equal(report.geminiReady, true);
});

test("the credential source says so plainly when there is no engine", () => {
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "gemini",
    geminiAvailabilityFn: () => ({ available: false, version: null }),
    agyLoginStatusFn: () => agyStatus("unknown")
  });

  assert.equal(report.geminiCredentialSource, "engine-unavailable");
});

// ---------------------------------------------------------------------------
// getSessionRuntimeStatus
//
// The defect this answers, found by running the plugin against its own repo:
// the label picked gemini whenever the gemini *binary* existed, ignoring the
// requested engine entirely — the function took no env or engine argument at
// all, and job-control passed one that was silently dropped. With
// GEMINI_ENGINE=agy and an expired gemini credential, `/gemini:setup --json`
// reported "gemini CLI (per-command)": the one engine that could not have run.
// The label now comes from detectEngine, the resolver the next command uses.
// ---------------------------------------------------------------------------

const AVAILABLE_GEMINI = () => ({ available: true, detail: "0.54.4" });
const AVAILABLE_AGY = () => ({ available: true, detail: "1.1.12" });

function recordingDetectEngine(engine) {
  const calls = [];
  const fn = (requested) => {
    calls.push(requested);
    return { engine, binary: engine, version: "test" };
  };
  fn.calls = calls;
  return fn;
}

test("the runtime label follows GEMINI_ENGINE, not whichever binary exists", () => {
  const detectEngineFn = recordingDetectEngine("agy");
  const status = getSessionRuntimeStatus({
    env: { GEMINI_ENGINE: "agy" },
    geminiAvailabilityFn: AVAILABLE_GEMINI,
    agyAvailabilityFn: AVAILABLE_AGY,
    detectEngineFn
  });

  assert.deepEqual(detectEngineFn.calls, ["agy"], "the requested engine must reach the resolver");
  assert.equal(status.selected, "agy");
  assert.equal(status.label, "agy (per-command)");
});

test("an explicit --engine outranks the environment", () => {
  const detectEngineFn = recordingDetectEngine("gemini");
  const status = getSessionRuntimeStatus({
    requestedEngine: "gemini",
    env: { GEMINI_ENGINE: "agy" },
    geminiAvailabilityFn: AVAILABLE_GEMINI,
    agyAvailabilityFn: AVAILABLE_AGY,
    detectEngineFn
  });

  assert.deepEqual(detectEngineFn.calls, ["gemini"]);
  assert.equal(status.label, "gemini CLI (per-command)");
});

test("an installed but unusable engine is not named as the runtime", () => {
  // detectEngine throws for "installed with no usable credential and no AGY".
  const status = getSessionRuntimeStatus({
    env: {},
    geminiAvailabilityFn: AVAILABLE_GEMINI,
    agyAvailabilityFn: () => ({ available: false, detail: null }),
    detectEngineFn: () => {
      throw new Error("Gemini CLI is installed but has no usable credential");
    }
  });

  assert.equal(status.available, true, "the binary is still installed");
  assert.equal(status.selected, null);
  assert.equal(status.label, "installed, but no engine is ready");
});

test("no engine at all still reports plainly", () => {
  const status = getSessionRuntimeStatus({
    env: {},
    geminiAvailabilityFn: () => ({ available: false, detail: null }),
    agyAvailabilityFn: () => ({ available: false, detail: null }),
    detectEngineFn: () => {
      throw new Error("No Gemini or AGY engine found.");
    }
  });

  assert.equal(status.available, false);
  assert.equal(status.label, "no engine available");
});

test("the label matches the engine the real resolver picks, not a stub", () => {
  // The other three tests stub detectEngineFn, so nothing would catch the shim
  // that feeds the probes back in — it identifies engines by binary substring and
  // has to return binaryAvailable's {available, detail} shape. This drives the
  // real detectEngine over stubbed availability to pin that contract.
  const ready = getSessionRuntimeStatus({
    requestedEngine: "gemini",
    env: {},
    geminiAvailabilityFn: AVAILABLE_GEMINI,
    agyAvailabilityFn: AVAILABLE_AGY
  });
  assert.equal(ready.selected, "gemini");
  assert.equal(ready.label, "gemini CLI (per-command)");

  const missing = getSessionRuntimeStatus({
    requestedEngine: "gemini",
    env: {},
    geminiAvailabilityFn: () => ({ available: false, detail: null }),
    agyAvailabilityFn: AVAILABLE_AGY
  });
  assert.equal(missing.selected, null, "a requested engine that is not installed cannot be the runtime");
  assert.equal(missing.label, "installed, but no engine is ready");
});

// ---------------------------------------------------------------------------
// gemini readiness, and --probe-gemini
//
// The defect: `/gemini:setup --engine gemini` answered `"readyState": "ready"`
// with `"nextSteps": []` for an account that returns API_KEY_INVALID on every
// request (measured live, 2026-08-12). The keychain still held an entry, so the
// credential *resolved*; the OAuth file in the same payload said the token had
// expired four days earlier, and readiness ignored it. That flag only became
// reachable in 0.17.1 — before, `--engine gemini` was silently dropped.
// ---------------------------------------------------------------------------

function geminiFileStatus(state, detail = `OAuth file reported ${state}.`) {
  return { loggedIn: state === "valid", state, verifiable: false, detail };
}

function geminiProbeStatus(state) {
  return {
    loggedIn: state === "verified",
    state,
    verifiable: state === "verified" || state === "logged-out",
    detail: `Gemini probe reported ${state}.`
  };
}

// `env: {}` is not decoration. Readiness reads GEMINI_API_KEY / GOOGLE_API_KEY,
// an env key outranks the file, and this suite used to read them straight from
// `process.env` — so this assertion passed only on a machine with neither
// exported. Verified: before the seam, `GEMINI_API_KEY=x node --test` failed here.
test("an expired OAuth file blocks the ready claim even when a credential resolves", () => {
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "gemini",
    env: {},
    geminiAvailabilityFn: () => ({ available: true, detail: "0.54.4" }),
    agyAvailabilityFn: () => ({ available: true, detail: "1.1.12" }),
    geminiCredentialedFn: () => true,
    geminiLoginStatusFn: () => geminiFileStatus("expired", "OAuth token expired at 2026-08-08T04:28:48.236Z."),
    agyLoginStatusFn: () => agyStatus("unknown")
  });

  assert.notEqual(report.readyState, "ready", "a stale credential must not read as ready");
  assert.equal(report.ready, false);
  assert.ok(
    report.nextSteps.some((step) => /stale|expired/i.test(step)),
    `the report must say what to do; got ${JSON.stringify(report.nextSteps)}`
  );
  assert.ok(
    report.nextSteps.some((step) => /probe-gemini/.test(step) && /spends a turn/.test(step)),
    "offering --probe-gemini must disclose that it costs a turn"
  );
});

test("a missing OAuth file is not evidence, because 0.53.1 deletes it", () => {
  // The keychain-only install is healthy and must keep reading as ready — this is
  // the case the credential check was added for, and the expiry rule must not
  // swallow it.
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "gemini",
    env: {},
    geminiAvailabilityFn: () => ({ available: true, detail: "0.54.4" }),
    agyAvailabilityFn: () => ({ available: false, detail: null }),
    geminiCredentialedFn: () => true,
    geminiLoginStatusFn: () => geminiFileStatus("missing"),
    agyLoginStatusFn: () => agyStatus("unknown")
  });

  assert.equal(report.readyState, "ready");
  assert.equal(report.ready, true);
});

// An env API key is the top of the resolution order, so it legitimately outranks
// a stale file — and this is the pair that proves the env above is actually read
// rather than ignored in both directions.
test("an env API key outranks the stale-file evidence", () => {
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "gemini",
    env: { GEMINI_API_KEY: "test-key" },
    geminiAvailabilityFn: () => ({ available: true, detail: "0.54.4" }),
    agyAvailabilityFn: () => ({ available: false, detail: null }),
    geminiCredentialedFn: () => true,
    geminiLoginStatusFn: () => geminiFileStatus("expired"),
    agyLoginStatusFn: () => agyStatus("unknown")
  });

  assert.equal(report.readyState, "ready");
  assert.equal(report.geminiCredentialSource, "env-api-key");
});

test("a probe that comes back rejected is not-ready for an explicit --engine gemini", () => {
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "gemini",
    probedGemini: true,
    env: {},
    geminiAvailabilityFn: () => ({ available: true, detail: "0.54.4" }),
    agyAvailabilityFn: () => ({ available: true, detail: "1.1.12" }),
    geminiCredentialedFn: () => true,
    geminiLoginStatusFn: () => geminiProbeStatus("logged-out"),
    geminiFileStatusFn: () => geminiFileStatus("missing"),
    agyLoginStatusFn: () => agyStatus("unknown")
  });

  assert.equal(report.readyState, "not-ready", "a verified negative is worse than unknown");
  assert.equal(report.ready, false);
});

test("a rejected gemini stays partial under auto, because auto routes to AGY", () => {
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "",
    probedGemini: true,
    env: {},
    geminiAvailabilityFn: () => ({ available: true, detail: "0.54.4" }),
    agyAvailabilityFn: () => ({ available: true, detail: "1.1.12" }),
    geminiCredentialedFn: () => true,
    geminiLoginStatusFn: () => geminiProbeStatus("logged-out"),
    geminiFileStatusFn: () => geminiFileStatus("missing"),
    agyLoginStatusFn: () => agyStatus("unknown")
  });

  assert.equal(report.readyState, "partial");
});

test("a verified probe outranks the file and reaches ready", () => {
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "gemini",
    probedGemini: true,
    env: {},
    geminiAvailabilityFn: () => ({ available: true, detail: "0.54.4" }),
    agyAvailabilityFn: () => ({ available: false, detail: null }),
    geminiCredentialedFn: () => true,
    geminiLoginStatusFn: () => geminiProbeStatus("verified"),
    // Deliberately the worst file evidence available: a *verified* probe is the
    // one thing that outranks it.
    geminiFileStatusFn: () => geminiFileStatus("expired"),
    agyLoginStatusFn: () => agyStatus("unknown")
  });

  assert.equal(report.readyState, "ready");
  assert.equal(report.ready, true);
});

// Under --probe-gemini, `geminiAuth` is the probe's answer, where `loggedIn: true`
// means "the API accepted a request" — not "the OAuth file is valid". Naming the
// source off that reported `oauth-file` for the exact case the probe exists to
// serve: 0.53.1 deleted the file and the credential lives in the keychain.
test("a verified probe does not rename the keychain as the OAuth file", () => {
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "gemini",
    probedGemini: true,
    env: {},
    geminiAvailabilityFn: () => ({ available: true, detail: "0.54.4" }),
    agyAvailabilityFn: () => ({ available: false, detail: null }),
    geminiCredentialedFn: () => true,
    geminiLoginStatusFn: () => geminiProbeStatus("verified"),
    geminiFileStatusFn: () => geminiFileStatus("missing"),
    agyLoginStatusFn: () => agyStatus("unknown")
  });

  assert.equal(report.geminiCredentialSource, "os-keychain");
});

// An inconclusive probe replaced the file status wholesale, so it *erased* the one
// piece of evidence the free check had produced: an expired file plus a probe that
// timed out read as `ready`.
test("an inconclusive probe does not erase the expired file underneath it", () => {
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "gemini",
    probedGemini: true,
    env: {},
    geminiAvailabilityFn: () => ({ available: true, detail: "0.54.4" }),
    agyAvailabilityFn: () => ({ available: false, detail: null }),
    geminiCredentialedFn: () => true,
    geminiLoginStatusFn: () => geminiProbeStatus("unknown"),
    geminiFileStatusFn: () => geminiFileStatus("expired"),
    agyLoginStatusFn: () => agyStatus("unknown")
  });

  assert.notEqual(report.readyState, "ready");
  assert.equal(report.ready, false);
});

// The stale-file step quotes the file, and stops offering a probe once one has
// answered. Reading the probe there produced "the OAuth file says it is stale:
// Gemini CLI rejected the probe…" followed by advice to run the probe that had
// just run — measured on a real `setup --probe-gemini --engine gemini`.
test("the stale-file step quotes the file, not the probe standing in front of it", () => {
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "gemini",
    probedGemini: true,
    env: {},
    geminiAvailabilityFn: () => ({ available: true, detail: "0.54.4" }),
    agyAvailabilityFn: () => ({ available: false, detail: null }),
    geminiCredentialedFn: () => true,
    geminiLoginStatusFn: () => geminiProbeStatus("unknown"),
    geminiFileStatusFn: () => geminiFileStatus("expired", "OAuth token expired at 2026-08-08."),
    agyLoginStatusFn: () => agyStatus("unknown")
  });

  const stale = report.nextSteps.find((step) => /OAuth file says it is stale/.test(step));
  assert.ok(stale, `expected a stale-file step; got ${JSON.stringify(report.nextSteps)}`);
  assert.match(stale, /OAuth token expired at 2026-08-08\./);
  assert.doesNotMatch(stale, /rejected the probe|reported unknown/, "it must not quote the probe");
  assert.doesNotMatch(stale, /spends a turn/, "a probe already ran; do not offer it again");
});

test("a rejected probe says what to do once, not twice", () => {
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "gemini",
    probedGemini: true,
    env: {},
    geminiAvailabilityFn: () => ({ available: true, detail: "0.54.4" }),
    agyAvailabilityFn: () => ({ available: false, detail: null }),
    geminiCredentialedFn: () => true,
    geminiLoginStatusFn: () => geminiProbeStatus("logged-out"),
    geminiFileStatusFn: () => geminiFileStatus("expired"),
    agyLoginStatusFn: () => agyStatus("unknown")
  });

  assert.deepEqual(report.nextSteps, ["Gemini probe reported logged-out."]);
});

// The probe costs a turn. `unknown` used to push nothing, so a user who had just
// paid for a request read a report that looked like no probe had run.
test("an inconclusive probe is disclosed instead of passing in silence", () => {
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "gemini",
    probedGemini: true,
    env: {},
    geminiAvailabilityFn: () => ({ available: true, detail: "0.54.4" }),
    agyAvailabilityFn: () => ({ available: false, detail: null }),
    geminiCredentialedFn: () => true,
    geminiLoginStatusFn: () => geminiProbeStatus("unknown"),
    geminiFileStatusFn: () => geminiFileStatus("missing"),
    agyLoginStatusFn: () => agyStatus("unknown")
  });

  assert.ok(
    report.nextSteps.some((step) => /Gemini probe reported unknown/.test(step)),
    `an inconclusive probe must say so; got ${JSON.stringify(report.nextSteps)}`
  );
});

// Nothing gated the paid probe on the engine, while AGY readiness ignores
// geminiAuth entirely and every gemini next step is guarded by !agySelected — so
// this combination billed a turn whose answer was then discarded.
// The gate is only observable through what the report says, because an injected
// `geminiLoginStatusFn` replaces the probe either way — so the assertion is the
// disclosure, paired with its complement below so it cannot be satisfied by
// always pushing the line.
test("--probe-gemini does not spend a turn for an AGY run", () => {
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "agy",
    probedGemini: true,
    env: {},
    geminiAvailabilityFn: () => ({ available: true, detail: "0.54.4" }),
    agyAvailabilityFn: () => AGY_INSTALLED,
    geminiCredentialedFn: () => true,
    geminiLoginStatusFn: () => geminiFileStatus("missing"),
    agyLoginStatusFn: () => agyStatus("unknown")
  });

  assert.ok(
    report.nextSteps.some((step) => /`--probe-gemini` was not run/.test(step)),
    `a skipped flag must be said out loud; got ${JSON.stringify(report.nextSteps)}`
  );
});

test("--probe-gemini is not announced as skipped when it is the point of the run", () => {
  const report = buildSetupReport(makeTempDir(), [], {
    engine: "gemini",
    probedGemini: true,
    env: {},
    geminiAvailabilityFn: () => ({ available: true, detail: "0.54.4" }),
    agyAvailabilityFn: () => ({ available: false, detail: null }),
    geminiCredentialedFn: () => true,
    geminiLoginStatusFn: () => geminiProbeStatus("verified"),
    geminiFileStatusFn: () => geminiFileStatus("missing"),
    agyLoginStatusFn: () => agyStatus("unknown")
  });

  assert.doesNotMatch(report.nextSteps.join("\n"), /`--probe-gemini` was not run/);
});

// ---------------------------------------------------------------------------
// probeGeminiLogin
// ---------------------------------------------------------------------------

test("the gemini probe reports a rejected credential as logged out, with proof", () => {
  const runCommandFn = stubRun({
    status: 1,
    stderr: '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}'
  });
  const status = probeGeminiLogin(undefined, {
    runCommandFn,
    detectEngineFn: () => ({ engine: "gemini", binary: "gemini", version: "0.54.4" })
  });

  assert.equal(status.state, "logged-out");
  assert.equal(status.verifiable, true, "a classified auth refusal is proof, not a guess");
  assert.equal(status.loggedIn, false);
  assert.match(status.detail, /No turn was spent/);
  // The prompt travels on stdin, like every other gemini call in this plugin.
  assert.equal(runCommandFn.calls[0].opts.input, "ok");
  assert.ok(!runCommandFn.calls[0].args.includes("-p"), "stdin transport must not also pass -p");
});

test("the gemini probe says a completed request cost a turn", () => {
  const status = probeGeminiLogin(undefined, {
    runCommandFn: stubRun({ status: 0, stdout: '{"response":"ok"}' }),
    detectEngineFn: () => ({ engine: "gemini", binary: "gemini", version: "0.54.4" })
  });

  assert.equal(status.state, "verified");
  assert.equal(status.loggedIn, true);
  assert.match(status.detail, /spent a turn/, "the cost must be visible where the result is read");
});

// The probe asks for --output-format json, and in that mode gemini can put the
// error in a stdout envelope instead of on stderr. classifyCliFailure only reads
// stdout when told the output is structured, so without that this answered
// `unknown` for the one failure the probe exists to detect. (Measured on 0.54.4
// the auth error arrives on stderr — this holds the envelope path open.)
test("the gemini probe reads an auth error out of the JSON envelope", () => {
  const envelope = {
    error: {
      message:
        '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}'
    }
  };
  const status = probeGeminiLogin(undefined, {
    runCommandFn: stubRun({ status: 1, stdout: `${JSON.stringify(envelope)}\n`, stderr: "" }),
    detectEngineFn: () => ({ engine: "gemini", binary: "gemini", version: "0.54.4" })
  });

  assert.equal(status.state, "logged-out");
  assert.equal(status.verifiable, true, "an envelope-carried refusal is the same proof");
});

test("a gemini probe that fails for another reason leaves the state unknown", () => {
  const status = probeGeminiLogin(undefined, {
    runCommandFn: stubRun({ status: 1, stderr: "socket hang up" }),
    detectEngineFn: () => ({ engine: "gemini", binary: "gemini", version: "0.54.4" })
  });

  assert.equal(status.state, "unknown");
  assert.equal(status.verifiable, false, "a network failure is not proof of a logout");
  // The auth branch can promise the request was free; this one cannot, and a
  // timeout in particular was killed in flight. Not saying so was the one place
  // this flag could hide a spend.
  assert.match(status.detail, /may have spent a turn/);
});

// The seam hands it a cwd (`geminiLoginStatusFn(cwd)`), which the options
// destructuring used to swallow — so the probe ran in the process cwd, a workspace
// `.gemini/settings.json` did not apply, and the probe could disagree with the
// very turn it is supposed to predict.
test("the gemini probe runs where the caller asked", () => {
  const runCommandFn = stubRun({ status: 0, stdout: '{"response":"ok"}' });
  probeGeminiLogin("/some/workspace", {
    runCommandFn,
    detectEngineFn: () => ({ engine: "gemini", binary: "gemini", version: "0.54.4" })
  });

  assert.equal(runCommandFn.calls[0].opts.cwd, "/some/workspace");
});

// A one-word prompt does not need long, but at 30s a healthy-but-slow credential
// was killed mid-request: billed, and still reported `unknown`.
test("the gemini probe timeout is not itself a reason to be inconclusive", () => {
  assert.ok(
    GEMINI_PROBE_TIMEOUT_MS >= 60_000,
    `a probe that pays for a turn must not give up in ${GEMINI_PROBE_TIMEOUT_MS}ms`
  );
});

test("the gemini probe does not spawn when the binary is absent", () => {
  const runCommandFn = stubRun({ status: 0 });
  const status = probeGeminiLogin(undefined, {
    runCommandFn,
    detectEngineFn: () => {
      throw new Error("Gemini engine requested but gemini binary is not available.");
    }
  });

  assert.equal(status.state, "unavailable");
  assert.equal(runCommandFn.calls.length, 0);
});
