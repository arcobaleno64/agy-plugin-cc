import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildEnv,
  buildFailingAgyEnv,
  buildEnvUnavailable,
  installCapturingAgyExecutable,
  installFakeAgy,
  installFakeGemini,
  installFailingAgyExecutable,
  installUnavailableAgy,
  installUnavailableEngines,
  installUnavailableGemini,
  readFakeState,
  removeGeminiCredentials,
  writeExpiredGeminiCredentials,
  writeGeminiSettings
} from "./fake-gemini-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  readJobFile,
  resolveJobFile,
  resolveStateDir,
  resolveStateFile,
  writeJobFile
} from "../plugins/gemini/scripts/lib/state.mjs";
import {
  buildReviewPrompt,
  dispatchAdversarialReview,
  dispatchBackgroundTask
} from "../plugins/gemini/scripts/gemini-companion.mjs";
import { classifyCliFailure } from "../plugins/gemini/scripts/lib/failures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "gemini", "scripts", "gemini-companion.mjs");
const STOP_GATE_HOOK = path.join(ROOT, "plugins", "gemini", "scripts", "stop-review-gate-hook.mjs");

function setupRepo(scenario = "task") {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeGemini(binDir, scenario);
  initGitRepo(repo);
  return { repo, binDir };
}

function commit(repo, file, contents) {
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
  run("git", ["add", file], { cwd: repo });
  run("git", ["commit", "-m", `add ${file}`], { cwd: repo });
}

function seedState(workspace, jobs, config = {}) {
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify({ version: 1, config, jobs }, null, 2)}\n`, "utf8");
  return stateFile;
}

// The host Claude session exports GEMINI_COMPANION_SESSION_ID, which would make
// the session filter hide seeded jobs that carry no sessionId. Strip it so the
// companion treats the seeded state as session-agnostic.
function envWithoutSession(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.GEMINI_COMPANION_SESSION_ID;
  return env;
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

test("setup reports ready when fake gemini is installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "task");

  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: makeTempDir(), env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.gemini.available, true);
  assert.equal(payload.geminiAuth.loggedIn, true);
});

test("setup is not ready when gemini is installed but unauthenticated", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "task");
  removeGeminiCredentials(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: makeTempDir(), env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  // Core P0-3 contract: an unauthenticated gemini is never "ready". (readyState
  // may be "partial" when a real AGY engine happens to be on PATH, so it is
  // asserted deterministically in the AGY-available test instead.)
  assert.equal(payload.ready, false);
  assert.equal(payload.gemini.available, true);
  assert.equal(payload.geminiAuth.loggedIn, false);
  assert.ok(payload.nextSteps.some((step) => /authenticate/i.test(step)));
});

test("setup is not ready when the gemini OAuth token is expired", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "task");
  writeExpiredGeminiCredentials(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: makeTempDir(), env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.geminiAuth.loggedIn, false);
  assert.match(payload.geminiAuth.detail, /expired/i);
});

test("setup reports a partial supported AGY engine when gemini is unavailable but agy is present", () => {
  const binDir = makeTempDir();
  installUnavailableGemini(binDir);
  installFakeAgy(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: makeTempDir(), env: buildEnvUnavailable(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.gemini.available, false);
  assert.equal(payload.agy.available, true);
  assert.equal(payload.ready, false);
  assert.equal(payload.readyState, "partial");
  assert.equal(payload.agyAvailable, true);
  assert.equal(payload.agyFallbackAvailable, true);
  assert.equal(payload.agyAuth.loggedIn, false);
  assert.equal(payload.agyAuth.state, "unknown");
  assert.equal(payload.agyAuth.verifiable, false);
  assert.match(payload.agyAuth.detail, /cannot be verified non-interactively/i);
  assert.doesNotMatch(payload.agyAuth.detail, /shared Google OAuth|Run `gemini`/i);
  assert.ok(payload.nextSteps.some((step) => /--engine agy/.test(step)));
});

test("setup reports not ready when neither gemini nor agy is available", () => {
  const binDir = makeTempDir();
  installUnavailableEngines(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: makeTempDir(), env: buildEnvUnavailable(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.gemini.available, false);
  assert.equal(payload.agy.available, false);
});

test("setup warns personal-plan users about the 2026-06-18 gemini CLI EOL", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "task"); // valid creds + gemini home
  writeGeminiSettings(binDir, "oauth-personal");

  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: makeTempDir(), env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.geminiPlanTier.tier, "personal");
  assert.ok(payload.nextSteps.some((step) => /2026-06-18/.test(step)), "expected a 2026-06-18 EOL heads-up");
});

test("setup does not show the EOL warning for a non-personal (enterprise) plan", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "task");
  writeGeminiSettings(binDir, "oauth-enterprise");

  const result = run("node", [SCRIPT, "setup", "--json"], { cwd: makeTempDir(), env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.geminiPlanTier.tier, "other");
  assert.ok(!payload.nextSteps.some((step) => /2026-06-18/.test(step)), "enterprise plans must not get the EOL warning");
});

// Setup readiness must reflect the engine the user actually selected. With an
// explicit `--engine agy` the report must not inherit Gemini's ready state when
// AGY itself is unavailable; otherwise the next `--engine agy` command fails
// after setup said "ready".
test("setup --engine agy is not ready when agy is unavailable even if gemini is authenticated", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "task"); // gemini installed + authenticated
  installUnavailableAgy(binDir); // shadow any real agy as unavailable

  const result = run("node", [SCRIPT, "setup", "--json", "--engine", "agy"], {
    cwd: makeTempDir(),
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.requestedEngine, "agy");
  assert.equal(payload.agy.available, false);
  assert.equal(payload.ready, false);
  assert.ok(payload.nextSteps.some((step) => /agy/i.test(step)));
});

// Even when the AGY binary IS present, `--engine agy` must not report full
// readiness: AGY's auth cannot be verified non-interactively, so the verdict is
// "partial" (binary present, auth unknown) and `ready` stays false.
test("setup --engine agy is partial, never fully ready, when agy is present but unverifiable", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "task"); // gemini installed + authenticated
  installFakeAgy(binDir); // agy binary answers --version

  const result = run("node", [SCRIPT, "setup", "--json", "--engine", "agy"], {
    cwd: makeTempDir(),
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.requestedEngine, "agy");
  assert.equal(payload.agy.available, true);
  assert.equal(payload.ready, false);
  assert.equal(payload.readyState, "partial");
  assert.equal(payload.agyAvailable, true);
  assert.equal(payload.agyAuth.state, "unknown");
  assert.equal(payload.agyAuth.verifiable, false);
  assert.ok(payload.nextSteps.some((step) => /cannot be verified|authentication/i.test(step)));
});

// The human-readable (non-JSON) setup label must not claim "Gemini CLI not
// ready" for an `--engine agy` partial: there, partial means AGY auth is
// unverifiable, not that Gemini is missing.
test("non-JSON setup --engine agy does not claim Gemini is not ready when it is", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "task"); // gemini installed + authenticated
  installFakeAgy(binDir); // agy binary present

  const result = run("node", [SCRIPT, "setup", "--engine", "agy"], { cwd: makeTempDir(), env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Gemini CLI not ready/);
  assert.match(result.stdout, /AGY selected|auth not verifiable/i);
});

// The default-engine partial (Gemini genuinely unavailable, AGY present) must
// render AGY as an available supported engine.
test("non-JSON setup renders AGY as available when gemini is unavailable", () => {
  const binDir = makeTempDir();
  installUnavailableGemini(binDir);
  installFakeAgy(binDir);

  const result = run("node", [SCRIPT, "setup"], { cwd: makeTempDir(), env: buildEnvUnavailable(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /AGY available — Gemini CLI not ready/);
});

// Setup readiness must use the same engine allow-set as the runtime resolver
// (detectEngine accepts only auto/gemini/agy). An unknown engine value must
// fail the preflight instead of inheriting Gemini readiness — otherwise the
// next command resolves the same value and throws.
test("setup reports not ready for an unrecognized engine value", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "task"); // gemini installed + authenticated

  const result = run("node", [SCRIPT, "setup", "--json", "--engine", "bogus"], { cwd: makeTempDir(), env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.requestedEngine, "bogus");
  assert.equal(payload.ready, false);
  assert.equal(payload.readyState, "not-ready");
  assert.ok(payload.nextSteps.some((step) => /not recognized|auto.*gemini.*agy/i.test(step)));
});

test("setup toggles the stop-time review gate and persists the choice", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "task");
  const workspace = makeTempDir();

  const enabled = run("node", [SCRIPT, "setup", "--json", "--enable-review-gate"], {
    cwd: workspace,
    env: buildEnv(binDir)
  });
  assert.equal(enabled.status, 0, enabled.stderr);
  const enabledPayload = JSON.parse(enabled.stdout);
  assert.equal(enabledPayload.reviewGateEnabled, true);
  assert.ok(enabledPayload.actionsTaken.some((entry) => /enabled/i.test(entry)));

  const persisted = run("node", [SCRIPT, "setup", "--json"], { cwd: workspace, env: buildEnv(binDir) });
  assert.equal(JSON.parse(persisted.stdout).reviewGateEnabled, true);

  const disabled = run("node", [SCRIPT, "setup", "--json", "--disable-review-gate"], {
    cwd: workspace,
    env: buildEnv(binDir)
  });
  assert.equal(JSON.parse(disabled.stdout).reviewGateEnabled, false);
});

// ---------------------------------------------------------------------------
// review / adversarial-review
// ---------------------------------------------------------------------------

test("review renders a clean working-tree verdict from structured JSON", () => {
  const { repo, binDir } = setupRepo("review-clean");
  commit(repo, "src/app.js", "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Gemini Review/);
  assert.match(result.stdout, /Target: working tree/);
  assert.match(result.stdout, /Verdict: approve/);
  assert.match(result.stdout, /No material findings\./);
});

test("review honors --base over the dirty-tree auto default", () => {
  const { repo, binDir } = setupRepo("review-clean");
  commit(repo, "src/app.js", "export const value = 1;\n");
  run("git", ["checkout", "-b", "feature"], { cwd: repo });
  commit(repo, "src/feature.js", "export const f = 1;\n");
  // Dirty the working tree so the auto scope would resolve to working-tree.
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--base", "main"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  // The fix must route --base through to the diff target; the original bug
  // re-resolved with empty options and reported "working tree diff" instead.
  assert.match(result.stdout, /Target: branch diff against main/);
  assert.doesNotMatch(result.stdout, /Target: working tree/);
});

test("review honors --scope working-tree even when the tree is clean", () => {
  const { repo, binDir } = setupRepo("review-clean");
  commit(repo, "src/app.js", "export const value = 1;\n");
  // Clean tree: the auto scope would resolve to a branch diff, not working-tree.

  const result = run("node", [SCRIPT, "review", "--scope", "working-tree"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Target: working tree diff/);
});

test("review surfaces 'nothing to review' on an empty working tree without invoking Gemini", () => {
  const { repo, binDir } = setupRepo("review-clean");
  commit(repo, "src/app.js", "export const value = 1;\n");
  // Clean tree + explicit working-tree scope: there is no diff to review.

  const result = run("node", [SCRIPT, "review", "--scope", "working-tree"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Nothing to review/i);
  // The vacuous-approve bug: Gemini must NOT be asked to review an empty diff.
  assert.ok(
    !fs.existsSync(path.join(binDir, "fake-gemini-state.json")),
    "Gemini must not be invoked when there is nothing to review"
  );
});

test("empty-diff review --json marks empty:true with a null result so the gate does not block", () => {
  const { repo, binDir } = setupRepo("review-clean");
  commit(repo, "src/app.js", "export const value = 1;\n");

  const result = run("node", [SCRIPT, "adversarial-review", "--scope", "working-tree", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.empty, true);
  assert.equal(payload.result, null);
  // result.verdict is undefined (not "needs-attention"), so stop-review-gate proceeds.
  assert.notEqual(payload.result?.verdict, "needs-attention");
});

test("review honors --scope branch even when the tree is dirty", () => {
  const { repo, binDir } = setupRepo("review-clean");
  commit(repo, "src/app.js", "export const value = 1;\n");
  // Dirty the tree: the auto scope would resolve to working-tree, not branch.
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--scope", "branch"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Target: branch diff against main/);
  assert.doesNotMatch(result.stdout, /Target: working tree/);
});

test("standard review ignores trailing focus text", () => {
  const { repo, binDir } = setupRepo("review-clean");
  commit(repo, "src/app.js", "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "please", "focus", "on", "auth"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const state = readFakeState(binDir);
  assert.doesNotMatch(state.lastInvocation.prompt, /please focus on auth/);
});

test("adversarial review keeps focus text out of flag parsing and forwards it", () => {
  const { repo, binDir } = setupRepo("review-findings");
  commit(repo, "src/app.js", "export const value = items[0];\n");
  // Diverge from main so --base main resolves to a non-empty branch diff (an
  // empty diff would now short-circuit as "nothing to review" before the model).
  run("git", ["checkout", "-b", "feature"], { cwd: repo });
  commit(repo, "src/app.js", "export const value = items[0].id;\n");

  const result = run(
    "node",
    [SCRIPT, "adversarial-review", "--base", "main", "challenge", "the", "retry", "design"],
    { cwd: repo, env: buildEnv(binDir) }
  );

  assert.equal(result.status, 0, result.stderr);
  // --base must be parsed as a flag and the trailing words must become focus text.
  assert.match(result.stdout, /Target: branch diff against main/);
  const state = readFakeState(binDir);
  assert.match(state.lastInvocation.prompt, /challenge the retry design/);
});

test("review forwards the default gemini model and JSON output flags", () => {
  const { repo, binDir } = setupRepo("review-clean");
  commit(repo, "src/app.js", "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);

  const state = readFakeState(binDir);
  assert.ok(state.lastInvocation.args.includes("gemini-2.5-flash"));
  assert.ok(state.lastInvocation.args.includes("--output-format"));
});

test("review maps effort to a Gemini model when no model is given", () => {
  const { repo, binDir } = setupRepo("review-clean");
  commit(repo, "src/app.js", "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--effort", "high"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(readFakeState(binDir).lastInvocation.args.includes("gemini-3.1-pro-preview"));
});

test("review degrades gracefully to the GA model when the requested model is not found", () => {
  const { repo, binDir } = setupRepo("review-model-404");
  commit(repo, "src/app.js", "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  // gemini-3.5-flash is not served by the gemini CLI (404). The review must not
  // hard-fail: it retries once on the GA fallback and says so.
  const result = run("node", [SCRIPT, "review", "--model", "gemini-3.5-flash"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Gemini Review/);
  assert.match(result.stdout, /Reviewed on the GA fallback model|Fallback-path finding/);
  // Visible, honest substitution banner (no silent swap).
  assert.match(result.stdout, /unavailable on this gemini CLI/);
  assert.match(result.stdout, /gemini-2\.5-flash/);

  const state = readFakeState(binDir);
  assert.equal(state.invocations.length, 2, "one 404 attempt + one fallback");
  assert.ok(state.invocations[0].args.includes("gemini-3.5-flash"), "first tries the requested model");
  assert.ok(state.invocations[1].args.includes("gemini-2.5-flash"), "then retries the GA fallback");
});

test("rescue task degrades gracefully to the GA model on model-not-found", () => {
  const { repo, binDir } = setupRepo("review-model-404");
  commit(repo, "README.md", "hello\n");

  const result = run("node", [SCRIPT, "task", "--model", "gemini-3.5-flash", "do something"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /unavailable on this gemini CLI/);
  const state = readFakeState(binDir);
  assert.equal(state.invocations.length, 2);
  assert.ok(state.invocations[1].args.includes("gemini-2.5-flash"));
});

test("review --deep appends agentic exploration guidance to the prompt", () => {
  const { repo, binDir } = setupRepo("review-clean");
  commit(repo, "src/app.js", "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--deep"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  const state = readFakeState(binDir);
  assert.match(state.lastInvocation.prompt, /DEEP REVIEW MODE/);
});

test("standard review (no --deep) keeps the fast diff-scoped prompt", () => {
  const { repo, binDir } = setupRepo("review-clean");
  commit(repo, "src/app.js", "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  const state = readFakeState(binDir);
  assert.doesNotMatch(state.lastInvocation.prompt, /DEEP REVIEW MODE/);
});

test("adversarial review renders structured findings", () => {
  const { repo, binDir } = setupRepo("review-findings");
  commit(repo, "src/app.js", "export const value = items[0];\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Gemini Adversarial Review/);
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.match(result.stdout, /\[high\] Missing empty-state guard \(src\/app\.js:4-6\)/);
  assert.match(result.stdout, /Recommendation: Handle empty collections before indexing\./);
  assert.match(result.stdout, /Next steps:/);
});

test("review degrades gracefully when gemini returns invalid JSON", () => {
  const { repo, binDir } = setupRepo("review-invalid");
  commit(repo, "src/app.js", "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /did not return valid structured JSON/i);
  assert.match(result.stdout, /Parse error:/);
});

test("review retries a transient gemini failure (Invalid stream) and then succeeds", () => {
  const { repo, binDir } = setupRepo("review-transient-then-clean");
  commit(repo, "src/app.js", "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  // The 1st gemini invocation failed transiently; runGeminiReviewResilient retried.
  const state = readFakeState(binDir);
  assert.equal(state.invocations.length, 2, "expected exactly one retry (2 gemini invocations)");
  // The retried (2nd) call produced a clean, parseable review — the transient error did not leak.
  assert.match(result.stdout, /Verdict: approve/);
  assert.match(result.stdout, /No material findings\./);
  assert.doesNotMatch(result.stdout, /Invalid stream|Parse error|did not return valid/i);
});

test("review fails fast outside a git repository", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "review-clean");
  const notARepo = makeTempDir();

  const result = run("node", [SCRIPT, "review"], { cwd: notARepo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must run inside a Git repository/i);
});

// ---------------------------------------------------------------------------
// task
// ---------------------------------------------------------------------------

test("task returns the final gemini message", () => {
  const { repo, binDir } = setupRepo("task");
  commit(repo, "README.md", "hello\n");

  const result = run("node", [SCRIPT, "task", "do something useful"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task records the gemini session id as the resumable thread", () => {
  const { repo, binDir } = setupRepo("task");
  commit(repo, "README.md", "hello\n");

  const taskRun = run("node", [SCRIPT, "task", "investigate"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(taskRun.status, 0, taskRun.stderr);

  const result = run("node", [SCRIPT, "result", "--json"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).storedJob.threadId, "thr_1");
});

test("task maps a model alias to the resolved gemini model", () => {
  const { repo, binDir } = setupRepo("task");
  commit(repo, "README.md", "hello\n");

  const result = run("node", [SCRIPT, "task", "--model", "pro", "diagnose"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);

  const args = readFakeState(binDir).lastInvocation.args;
  assert.ok(args.includes("-m"));
  assert.ok(args.includes("gemini-3.1-pro-preview"));
});

test("task maps reasoning effort to a model when no model is given", () => {
  const { repo, binDir } = setupRepo("task");
  commit(repo, "README.md", "hello\n");

  const result = run("node", [SCRIPT, "task", "--effort", "high", "diagnose"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);

  assert.ok(readFakeState(binDir).lastInvocation.args.includes("gemini-3.1-pro-preview"));
});

test("task rejects an invalid effort level", () => {
  const { repo, binDir } = setupRepo("task");
  commit(repo, "README.md", "hello\n");

  const result = run("node", [SCRIPT, "task", "--effort", "turbo", "diagnose"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid --effort/i);
});

test("task --write enables the gemini write mode flag", () => {
  const { repo, binDir } = setupRepo("task");
  commit(repo, "README.md", "hello\n");

  const result = run("node", [SCRIPT, "task", "--write", "apply the fix"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);

  assert.ok(readFakeState(binDir).lastInvocation.args.includes("--yolo"));
});

test("task --resume-last continues the latest completed thread", () => {
  const { repo, binDir } = setupRepo("task");
  commit(repo, "README.md", "hello\n");

  const first = run("node", [SCRIPT, "task", "first task"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(first.status, 0, first.stderr);

  const resumed = run("node", [SCRIPT, "task", "--resume-last", "keep going"], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /Resumed the prior run\./);
  assert.ok(readFakeState(binDir).lastInvocation.args.includes("--resume"));
});

test("task --resume-last fails when there is no prior thread", () => {
  const { repo, binDir } = setupRepo("task");
  commit(repo, "README.md", "hello\n");

  const result = run("node", [SCRIPT, "task", "--resume-last", "keep going"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /No previous Gemini task thread found/i);
});

test("task surfaces a failed gemini turn as a non-zero exit", () => {
  const { repo, binDir } = setupRepo("task-fail");
  commit(repo, "README.md", "hello\n");

  const result = run("node", [SCRIPT, "task", "do something"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /simulated failure/i);

  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "failed");
  assert.equal(state.jobs[0].failure.category, "no-output");
  assert.equal(typeof state.jobs[0].failure.nextStep, "string");

  const status = JSON.parse(run("node", [SCRIPT, "status", "--json"], { cwd: repo, env: buildEnv(binDir) }).stdout);
  assert.equal(status.latestFinished.failure.category, "no-output");

  const stored = JSON.parse(run("node", [SCRIPT, "result", state.jobs[0].id, "--json"], { cwd: repo, env: buildEnv(binDir) }).stdout);
  assert.equal(stored.storedJob.failure.category, "no-output");
});

test("task rejects an unknown engine", () => {
  const { repo, binDir } = setupRepo("task");
  commit(repo, "README.md", "hello\n");

  const result = run("node", [SCRIPT, "task", "--engine", "bogus", "do something"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown engine/i);
});

test("AGY 1.1.2 task sends a long prompt only on stdin and keeps transcript authoritative", { skip: process.platform === "win32" }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const capturePath = path.join(binDir, "agy-capture.json");
  const marker = `AGY112_STDIN_${"x".repeat(24_001)}`;
  installCapturingAgyExecutable(binDir, { version: "1.1.2" });
  initGitRepo(repo);
  commit(repo, "README.md", "hello\n");

  const result = run("node", [SCRIPT, "task", "--engine", "agy", marker], {
    cwd: repo,
    env: {
      ...buildFailingAgyEnv(binDir),
      FAKE_AGY_CAPTURE: capturePath,
      FAKE_AGY_RESPONSE: "AGY112_TRANSCRIPT_OK",
      FAKE_AGY_STDOUT: "AGY112_STDOUT_DECOY\n"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /AGY112_TRANSCRIPT_OK/);
  assert.doesNotMatch(result.stdout, /AGY112_STDOUT_DECOY/);
  const capture = JSON.parse(fs.readFileSync(capturePath, "utf8"));
  assert.equal(capture.stdin, marker);
  assert.ok(!capture.args.includes("--print"));
  assert.ok(!capture.args.includes(marker));
  assert.deepEqual(capture.args.slice(-2), ["--print-timeout", "2m"]);
});

test("AGY 1.1.1 task retains positional prompt compatibility", { skip: process.platform === "win32" }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const capturePath = path.join(binDir, "agy-capture.json");
  const prompt = "AGY111_POSITIONAL_MARKER";
  installCapturingAgyExecutable(binDir, { version: "1.1.1" });
  initGitRepo(repo);
  commit(repo, "README.md", "hello\n");

  const result = run("node", [SCRIPT, "task", "--engine", "agy", prompt], {
    cwd: repo,
    env: {
      ...buildFailingAgyEnv(binDir),
      FAKE_AGY_CAPTURE: capturePath,
      FAKE_AGY_RESPONSE: "AGY111_TRANSCRIPT_OK"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /AGY111_TRANSCRIPT_OK/);
  const capture = JSON.parse(fs.readFileSync(capturePath, "utf8"));
  assert.equal(capture.stdin, "");
  assert.deepEqual(capture.args.slice(0, 2), ["--print", prompt]);
});

test("AGY 1.1.2 review sends the generated review prompt on stdin", { skip: process.platform === "win32" }, () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const capturePath = path.join(binDir, "agy-capture.json");
  installCapturingAgyExecutable(binDir, { version: "1.1.2" });
  initGitRepo(repo);
  commit(repo, "src/app.js", "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n", "utf8");

  const result = run("node", [SCRIPT, "review", "--engine", "agy", "--scope", "working-tree"], {
    cwd: repo,
    env: {
      ...buildFailingAgyEnv(binDir),
      FAKE_AGY_CAPTURE: capturePath,
      FAKE_AGY_RESPONSE: JSON.stringify({ verdict: "clean", summary: "AGY stdin review completed.", findings: [] })
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /AGY stdin review completed/);
  const capture = JSON.parse(fs.readFileSync(capturePath, "utf8"));
  assert.match(capture.stdin, /export const value = 2/);
  assert.ok(!capture.args.includes("--print"));
});

test("task preserves AGY stderr when no transcript response is recoverable", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const expectedStderr = installFailingAgyExecutable(binDir);
  initGitRepo(repo);
  commit(repo, "README.md", "hello\n");

  const result = run("node", [SCRIPT, "task", "--engine", "agy", "do something"], {
    cwd: repo,
    env: buildFailingAgyEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, expectedStderr);

  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "failed");
  assert.equal(state.jobs[0].failure.category, "transcript-missing");
});

test("AGY failure classification prefers actionable stderr over transcript recovery failure", () => {
  const failure = classifyCliFailure({
    engine: "agy",
    status: 1,
    stderr: "authentication failed or timed out",
    transcriptReason: "no new conversation dir appeared"
  });

  assert.equal(failure.category, "auth");
});

test("review preserves AGY stderr when no transcript response is recoverable", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const expectedStderr = installFailingAgyExecutable(binDir);
  initGitRepo(repo);
  commit(repo, "src/app.js", "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n", "utf8");

  const result = run("node", [SCRIPT, "review", "--engine", "agy", "--scope", "working-tree"], {
    cwd: repo,
    env: buildFailingAgyEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, expectedStderr);

  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "failed");
  assert.equal(state.jobs[0].failure.category, "transcript-missing");
});

test("dispatchAdversarialReview queues prompt-identical blind jobs with a shared groupId", () => {
  const { repo } = setupRepo("review-findings");
  const dataDir = makeTempDir();
  commit(repo, "src/app.js", "export const value = items[0];\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");
  const previousData = process.env.GEMINI_COMPANION_DATA;
  process.env.GEMINI_COMPANION_DATA = dataDir;
  const spawns = [];
  const spawnFn = (...args) => {
    spawns.push(args);
    return { pid: 2000 + spawns.length, unref() {} };
  };

  try {
    const dispatched = dispatchAdversarialReview({
      cwd: repo,
      scope: "working-tree",
      engines: ["gemini", "agy"],
      focusText: "challenge the retry design"
    }, {
      spawnFn,
      detectEngineFn: (engine) => ({ engine })
    });

    assert.match(dispatched.groupId, /^review-group-/);
    assert.equal(dispatched.jobIds.length, 2);
    assert.equal(spawns.length, 2);
    const jobs = dispatched.jobIds.map((jobId) => readJobFile(resolveJobFile(repo, jobId)));
    assert.deepEqual(new Set(jobs.map((job) => job.groupId)), new Set([dispatched.groupId]));
    assert.deepEqual(new Set(jobs.map((job) => job.engine)), new Set(["gemini", "agy"]));
    const prompts = jobs.map((job) => job.request.preparedReview.prompt);
    assert.equal(new Set(prompts).size, 1);
    assert.equal(prompts[0], buildReviewPrompt(jobs[0].request).prompt);
    assert.ok(!prompts[0].includes(dispatched.groupId), "blind prompts must not expose orchestration metadata");
  } finally {
    if (previousData === undefined) delete process.env.GEMINI_COMPANION_DATA;
    else process.env.GEMINI_COMPANION_DATA = previousData;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("dispatchAdversarialReview degrades to one available engine with a stderr warning", () => {
  const { repo } = setupRepo("review-findings");
  const dataDir = makeTempDir();
  commit(repo, "src/app.js", "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");
  const previousData = process.env.GEMINI_COMPANION_DATA;
  process.env.GEMINI_COMPANION_DATA = dataDir;
  let stderr = "";

  try {
    const dispatched = dispatchAdversarialReview({
      cwd: repo,
      scope: "working-tree",
      engines: ["gemini", "agy"]
    }, {
      spawnFn: () => ({ pid: 3001, unref() {} }),
      detectEngineFn(engine) {
        if (engine === "agy") throw new Error("agy is unavailable");
        return { engine };
      },
      stderr: { write(chunk) { stderr += chunk; } }
    });

    assert.equal(dispatched.groupId, null);
    assert.deepEqual(dispatched.engines, ["gemini"]);
    assert.deepEqual(dispatched.unavailableEngines, ["agy"]);
    assert.equal(dispatched.jobIds.length, 1);
    assert.match(stderr, /degraded to gemini.*unavailable: agy/i);
    const job = readJobFile(resolveJobFile(repo, dispatched.jobIds[0]));
    assert.equal(job.engine, "gemini");
    assert.equal(job.groupId, undefined);
  } finally {
    if (previousData === undefined) delete process.env.GEMINI_COMPANION_DATA;
    else process.env.GEMINI_COMPANION_DATA = previousData;
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("dispatchAdversarialReview rejects a single model override for heterogeneous engines before spawning", () => {
  const { repo } = setupRepo("review-findings");
  commit(repo, "src/app.js", "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");
  let spawned = false;

  assert.throws(
    () => dispatchAdversarialReview({ cwd: repo, scope: "working-tree", engines: ["gemini", "agy"], model: "flash" }, {
      spawnFn() { spawned = true; return { pid: 1, unref() {} }; },
      detectEngineFn(engine) { return { engine, version: "1.1.5" }; }
    }),
    /--model cannot be used with --engines gemini,agy/
  );
  assert.equal(spawned, false);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("dispatchAdversarialReview validates every engine before spawning a group worker", () => {
  const { repo } = setupRepo("review-findings");
  commit(repo, "src/app.js", "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");
  let spawnCount = 0;

  assert.throws(
    () => dispatchAdversarialReview({ cwd: repo, scope: "working-tree", engines: ["gemini", "agy"], effort: "xhigh" }, {
      spawnFn() { spawnCount += 1; return { pid: spawnCount, unref() {} }; },
      detectEngineFn(engine) { return { engine, version: "1.1.5" }; }
    }),
    /AGY supports --effort values/
  );
  assert.equal(spawnCount, 0);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("background AGY task validates model and effort before spawning", () => {
  const { repo } = setupRepo("task");
  let spawned = false;

  assert.throws(
    () => dispatchBackgroundTask({ cwd: repo, engine: "agy", model: "gemini-3.6-flash-low", effort: "high", prompt: "diagnose" }, {
      spawnFn() { spawned = true; return { pid: 1, unref() {} }; },
      detectEngineFn() { return { engine: "agy", version: "1.1.5" }; }
    }),
    /cannot combine --model with --effort/
  );
  assert.equal(spawned, false);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("task --background enqueues a detached worker and reports completion", async () => {
  const { repo, binDir } = setupRepo("task");
  commit(repo, "README.md", "hello\n");

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const waited = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    { cwd: repo, env: buildEnv(binDir) }
  );
  assert.equal(waited.status, 0, waited.stderr);
  const waitedPayload = JSON.parse(waited.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const result = run("node", [SCRIPT, "result", launchPayload.jobId], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("review --background enqueues a detached review-worker and persists the result", async () => {
  const { repo, binDir } = setupRepo("review-clean");
  commit(repo, "src/app.js", "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const launched = run("node", [SCRIPT, "review", "--background", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^review-/);

  const waited = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    { cwd: repo, env: buildEnv(binDir) }
  );
  assert.equal(waited.status, 0, waited.stderr);
  const waitedPayload = JSON.parse(waited.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  // The persisted result is retrievable after the worker exits — the whole point
  // of having a review-worker instead of Claude-layer run_in_background.
  const result = run("node", [SCRIPT, "result", launchPayload.jobId], { cwd: repo, env: buildEnv(binDir) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Gemini Review/);
});

test("adversarial-review --background serializes focus text through the worker", async () => {
  const { repo, binDir } = setupRepo("review-findings");
  commit(repo, "src/app.js", "export const value = items[0];\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const launched = run(
    "node",
    [SCRIPT, "adversarial-review", "--background", "--json", "challenge the retry design"],
    { cwd: repo, env: buildEnv(binDir) }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.match(launchPayload.jobId, /^review-/);

  const waited = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    { cwd: repo, env: buildEnv(binDir) }
  );
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");

  // Focus text survives the JSON write/read cycle and reaches the model prompt.
  const state = readFakeState(binDir);
  assert.match(state.lastInvocation.prompt, /challenge the retry design/);
});

test("adversarial-review --background preserves multi-line focus text through the worker", async () => {
  const { repo, binDir } = setupRepo("review-findings");
  commit(repo, "src/app.js", "export const value = items[0];\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const focus = "challenge the retry design\nand the backoff jitter";
  // Launch node by absolute path so the test's own shell (shell:true for a bare
  // "node" on Windows) cannot split the newline before it reaches the companion;
  // we are asserting the companion's JSON round-trip, not the OS shell.
  const launched = run(
    process.execPath,
    [SCRIPT, "adversarial-review", "--background", "--json", focus],
    { cwd: repo, env: buildEnv(binDir) }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.match(launchPayload.jobId, /^review-/);

  const waited = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    { cwd: repo, env: buildEnv(binDir) }
  );
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");

  // The embedded newline must survive JSON serialization through the stored job.
  const state = readFakeState(binDir);
  assert.ok(
    state.lastInvocation.prompt.includes("challenge the retry design\nand the backoff jitter"),
    "multi-line focus text must reach the model prompt intact"
  );
});

// ---------------------------------------------------------------------------
// status / result / cancel / task-resume-candidate (seeded state)
// ---------------------------------------------------------------------------

test("status lists running and finished jobs for the current session", () => {
  const workspace = makeTempDir();
  seedState(workspace, [
    {
      id: "task-live",
      status: "running",
      jobClass: "task",
      kindLabel: "rescue",
      title: "Gemini Task",
      summary: "Investigate flaky test",
      createdAt: "2026-03-18T15:30:00.000Z",
      updatedAt: "2026-03-18T15:30:02.000Z"
    },
    {
      id: "review-done",
      status: "completed",
      jobClass: "review",
      kindLabel: "review",
      title: "Gemini Review",
      summary: "Review working tree",
      threadId: "thr_done",
      createdAt: "2026-03-18T15:10:00.000Z",
      startedAt: "2026-03-18T15:10:05.000Z",
      completedAt: "2026-03-18T15:11:10.000Z",
      updatedAt: "2026-03-18T15:11:10.000Z"
    }
  ]);

  const result = run("node", [SCRIPT, "status", "--json"], { cwd: workspace, env: envWithoutSession() });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.running.map((job) => job.id), ["task-live"]);
  assert.equal(payload.latestFinished.id, "review-done");
});

test("status without a job id only shows jobs from the current Claude session", () => {
  const workspace = makeTempDir();
  seedState(workspace, [
    {
      id: "task-current",
      status: "running",
      jobClass: "task",
      kindLabel: "rescue",
      title: "Gemini Task",
      sessionId: "sess-current",
      summary: "Current session task",
      createdAt: "2026-03-18T15:30:00.000Z",
      updatedAt: "2026-03-18T15:30:00.000Z"
    },
    {
      id: "task-other",
      status: "running",
      jobClass: "task",
      kindLabel: "rescue",
      title: "Gemini Task",
      sessionId: "sess-other",
      summary: "Other session task",
      createdAt: "2026-03-18T15:31:00.000Z",
      updatedAt: "2026-03-18T15:31:00.000Z"
    }
  ]);

  const result = run("node", [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env: { ...process.env, GEMINI_COMPANION_SESSION_ID: "sess-current" }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).running.map((job) => job.id), ["task-current"]);
});

test("status --wait requires a job id", () => {
  const workspace = makeTempDir();
  seedState(workspace, []);

  const result = run("node", [SCRIPT, "status", "--wait"], { cwd: workspace });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires a job id/i);
});

test("status --wait times out cleanly when a job stays active", () => {
  const workspace = makeTempDir();
  seedState(workspace, [
    {
      id: "task-live",
      status: "running",
      jobClass: "task",
      kindLabel: "rescue",
      title: "Gemini Task",
      summary: "Investigate flaky test",
      createdAt: "2026-03-18T15:30:00.000Z",
      startedAt: "2026-03-18T15:30:01.000Z",
      updatedAt: "2026-03-18T15:30:02.000Z"
    }
  ]);

  const result = run("node", [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, "task-live");
  assert.equal(payload.job.status, "running");
  assert.equal(payload.waitTimedOut, true);
});

test("result returns the stored output and resume hint for the latest finished job", () => {
  const workspace = makeTempDir();
  seedState(workspace, [
    {
      id: "task-finished",
      status: "completed",
      jobClass: "task",
      kindLabel: "rescue",
      title: "Gemini Task",
      threadId: "thr_finished",
      summary: "Investigate flaky test",
      createdAt: "2026-03-18T15:00:00.000Z",
      updatedAt: "2026-03-18T15:01:00.000Z"
    }
  ]);
  writeJobFile(workspace, "task-finished", {
    id: "task-finished",
    status: "completed",
    title: "Gemini Task",
    threadId: "thr_finished",
    result: { rawOutput: "Handled the requested task." }
  });

  const result = run("node", [SCRIPT, "result"], { cwd: workspace, env: envWithoutSession() });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task\./);
  assert.match(result.stdout, /Gemini session ID: thr_finished/);
  assert.match(result.stdout, /Resume in Gemini: gemini --resume thr_finished/);
});

test("status and result aggregate adversarial-review jobs by groupId", () => {
  const workspace = makeTempDir();
  const groupId = "review-group-shared";
  const jobs = [
    { id: "review-gemini", engine: "gemini", verdict: "approve", summary: "Gemini approves." },
    { id: "review-agy", engine: "agy", verdict: "needs-attention", summary: "AGY found a blocker." }
  ];
  seedState(workspace, jobs.map((job, index) => ({
    id: job.id,
    groupId,
    engine: job.engine,
    kind: "adversarial-review",
    jobClass: "review",
    title: "Gemini Adversarial Review",
    status: "completed",
    summary: job.summary,
    createdAt: `2026-07-14T00:00:0${index}.000Z`,
    updatedAt: `2026-07-14T00:00:0${index}.000Z`
  })));
  for (const job of jobs) {
    writeJobFile(workspace, job.id, {
      id: job.id,
      groupId,
      engine: job.engine,
      status: "completed",
      result: { result: { verdict: job.verdict, summary: job.summary, findings: [], next_steps: [] } },
      rendered: `# Gemini Adversarial Review\n\nVerdict: ${job.verdict}\n\n${job.summary}\n`
    });
  }

  const status = run("node", [SCRIPT, "status", groupId, "--json"], { cwd: workspace, env: envWithoutSession() });
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.groupId, groupId);
  assert.equal(statusPayload.jobs.length, 2);

  const result = run("node", [SCRIPT, "result", groupId, "--json"], { cwd: workspace, env: envWithoutSession() });
  assert.equal(result.status, 0, result.stderr);
  const resultPayload = JSON.parse(result.stdout);
  assert.equal(resultPayload.groupId, groupId);
  assert.equal(resultPayload.results.length, 2);

  const rendered = run("node", [SCRIPT, "result", groupId], { cwd: workspace, env: envWithoutSession() });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /\| gemini \| review-gemini \| completed \| approve \|/i);
  assert.match(rendered.stdout, /\| agy \| review-agy \| completed \| needs-attention \|/i);
});

test("cancel stops an active job and marks it cancelled", async (t) => {
  const workspace = makeTempDir();

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(sleeper.pid);
    } catch {
      // already gone
    }
  });

  seedState(workspace, [
    {
      id: "task-live",
      status: "running",
      jobClass: "task",
      kindLabel: "rescue",
      title: "Gemini Task",
      summary: "Investigate flaky test",
      pid: sleeper.pid,
      createdAt: "2026-03-18T15:30:00.000Z",
      startedAt: "2026-03-18T15:30:01.000Z",
      updatedAt: "2026-03-18T15:30:02.000Z"
    }
  ]);
  writeJobFile(workspace, "task-live", {
    id: "task-live",
    status: "running",
    title: "Gemini Task",
    pid: sleeper.pid
  });

  const result = run("node", [SCRIPT, "cancel", "task-live", "--json"], { cwd: workspace, env: envWithoutSession() });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "cancelled");

  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(workspace), "state.json"), "utf8"));
  assert.equal(state.jobs.find((job) => job.id === "task-live").status, "cancelled");
});

test("cancel is honest when there is no live process to terminate", () => {
  const workspace = makeTempDir();
  // A detached worker is unref()-ed, so by cancel time its PID is often gone.
  // Seed a job with no pid: terminateProcessTree never attempts a kill.
  seedState(workspace, [
    {
      id: "task-stale",
      status: "running",
      jobClass: "task",
      kindLabel: "rescue",
      title: "Gemini Task",
      pid: null,
      createdAt: "2026-03-18T15:30:00.000Z"
    }
  ]);
  writeJobFile(workspace, "task-stale", { id: "task-stale", status: "running", pid: null });

  const result = run("node", [SCRIPT, "cancel", "task-stale", "--json"], { cwd: workspace, env: envWithoutSession() });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  // The job is still marked cancelled (intent recorded), but the result must not
  // claim a process was killed.
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.processTerminated, false);

  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(workspace), "state.json"), "utf8"));
  assert.equal(state.jobs.find((job) => job.id === "task-stale").status, "cancelled");
});

test("task-resume-candidate returns the latest completed task thread", () => {
  const workspace = makeTempDir();
  seedState(workspace, [
    {
      id: "task-recent",
      status: "completed",
      jobClass: "task",
      kindLabel: "rescue",
      title: "Gemini Task",
      threadId: "thr_recent",
      summary: "Investigate flaky test",
      createdAt: "2026-03-18T15:30:00.000Z",
      updatedAt: "2026-03-18T15:31:00.000Z"
    }
  ]);

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], { cwd: workspace, env: envWithoutSession() });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.threadId, "thr_recent");
});

test("task-resume-candidate reports nothing to resume on an empty workspace", () => {
  const workspace = makeTempDir();
  seedState(workspace, []);

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], { cwd: workspace });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).available, false);
});

test("task-resume-candidate is blocked while a task is still running", () => {
  const workspace = makeTempDir();
  seedState(workspace, [
    {
      id: "task-running",
      status: "running",
      jobClass: "task",
      kindLabel: "rescue",
      title: "Gemini Task",
      summary: "Investigate flaky test",
      createdAt: "2026-03-18T15:30:00.000Z",
      updatedAt: "2026-03-18T15:30:00.000Z"
    }
  ]);

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], { cwd: workspace, env: envWithoutSession() });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, false);
  assert.equal(payload.blocked, true);
});

// Contract guard: commands/rescue.md keys the resume prompt off `available`.
// The payload must expose `available` (not the legacy `found`) so the documented
// contract and the companion output cannot drift apart again.
test("task-resume-candidate exposes `available` and not the legacy `found` field", () => {
  const workspace = makeTempDir();
  seedState(workspace, [
    {
      id: "task-recent",
      status: "completed",
      jobClass: "task",
      kindLabel: "rescue",
      title: "Gemini Task",
      threadId: "thr_recent",
      summary: "Investigate flaky test",
      createdAt: "2026-03-18T15:30:00.000Z",
      updatedAt: "2026-03-18T15:31:00.000Z"
    }
  ]);

  const payload = JSON.parse(
    run("node", [SCRIPT, "task-resume-candidate", "--json"], { cwd: workspace, env: envWithoutSession() }).stdout
  );
  assert.equal(payload.available, true, "rescue.md reads `available`");
  assert.ok(!Object.prototype.hasOwnProperty.call(payload, "found"), "legacy `found` field must be gone");
});

// ---------------------------------------------------------------------------
// P1-1: Claude session job filtering (--all + resume-candidate scoping)
// ---------------------------------------------------------------------------

function sessionJob(id, sessionId, updatedAt) {
  return {
    id,
    status: "completed",
    jobClass: "task",
    kindLabel: "rescue",
    title: "Gemini Task",
    sessionId,
    threadId: `thr_${id}`,
    summary: `${sessionId} work`,
    createdAt: updatedAt,
    completedAt: updatedAt,
    updatedAt
  };
}

test("status scopes to the current session but --all crosses sessions", () => {
  const workspace = makeTempDir();
  seedState(workspace, [
    sessionJob("task-current", "sess-current", "2026-03-18T15:31:00.000Z"),
    sessionJob("task-other", "sess-other", "2026-03-18T15:21:00.000Z")
  ]);
  const env = { ...process.env, GEMINI_COMPANION_SESSION_ID: "sess-current" };

  const scoped = JSON.parse(run("node", [SCRIPT, "status", "--json"], { cwd: workspace, env }).stdout);
  const scopedIds = [scoped.latestFinished?.id, ...scoped.recent.map((job) => job.id)].filter(Boolean).sort();
  assert.deepEqual(scopedIds, ["task-current"]);

  const all = JSON.parse(run("node", [SCRIPT, "status", "--all", "--json"], { cwd: workspace, env }).stdout);
  const allIds = [all.latestFinished?.id, ...all.recent.map((job) => job.id)].filter(Boolean).sort();
  assert.deepEqual(allIds, ["task-current", "task-other"]);
});

test("task-resume-candidate prefers the current session over a newer other-session thread", () => {
  const workspace = makeTempDir();
  seedState(workspace, [
    // Other-session job is newer; without scoping it would win the candidate.
    sessionJob("task-other", "sess-other", "2026-03-18T15:35:00.000Z"),
    sessionJob("task-current", "sess-current", "2026-03-18T15:30:00.000Z")
  ]);
  const env = { ...process.env, GEMINI_COMPANION_SESSION_ID: "sess-current" };

  const payload = JSON.parse(run("node", [SCRIPT, "task-resume-candidate", "--json"], { cwd: workspace, env }).stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.threadId, "thr_task-current");
});

test("task-resume-candidate hides other-session threads by default", () => {
  const workspace = makeTempDir();
  seedState(workspace, [sessionJob("task-other", "sess-other", "2026-03-18T15:35:00.000Z")]);
  const env = { ...process.env, GEMINI_COMPANION_SESSION_ID: "sess-current" };

  const payload = JSON.parse(run("node", [SCRIPT, "task-resume-candidate", "--json"], { cwd: workspace, env }).stdout);
  assert.equal(payload.available, false);
});

// Fail closed: when no current session id is known (lifecycle hook never ran),
// session-tagged jobs from other Claude sessions must NOT leak into the default
// scope. Otherwise --resume-last could silently continue another session's
// Gemini thread, and status/result could expose unrelated job output.
test("task-resume-candidate fails closed when the session id is unset and jobs are session-tagged", () => {
  const workspace = makeTempDir();
  seedState(workspace, [
    sessionJob("task-a", "sess-a", "2026-03-18T15:30:00.000Z"),
    sessionJob("task-b", "sess-b", "2026-03-18T15:35:00.000Z")
  ]);

  const payload = JSON.parse(run("node", [SCRIPT, "task-resume-candidate", "--json"], { cwd: workspace, env: envWithoutSession() }).stdout);
  assert.equal(payload.available, false);
});

test("status hides other-session jobs when the session id is unset (but --all still surfaces them)", () => {
  const workspace = makeTempDir();
  seedState(workspace, [
    sessionJob("task-a", "sess-a", "2026-03-18T15:30:00.000Z"),
    sessionJob("task-b", "sess-b", "2026-03-18T15:35:00.000Z")
  ]);

  const scoped = JSON.parse(run("node", [SCRIPT, "status", "--json"], { cwd: workspace, env: envWithoutSession() }).stdout);
  const scopedIds = [scoped.latestFinished?.id, ...scoped.recent.map((job) => job.id)].filter(Boolean);
  assert.deepEqual(scopedIds, []);

  const all = JSON.parse(run("node", [SCRIPT, "status", "--all", "--json"], { cwd: workspace, env: envWithoutSession() }).stdout);
  const allIds = [all.latestFinished?.id, ...all.recent.map((job) => job.id)].filter(Boolean).sort();
  assert.deepEqual(allIds, ["task-a", "task-b"]);
});

// result/cancel must honor the same default session scope as status, so an
// explicit id can never reach — or act on — another Claude session's job
// without an explicit --all.
test("result is scoped to the current session and needs --all to read another session's job", () => {
  const workspace = makeTempDir();
  seedState(workspace, [sessionJob("task-other", "sess-other", "2026-03-18T15:35:00.000Z")]);
  writeJobFile(workspace, "task-other", {
    id: "task-other",
    status: "completed",
    title: "Gemini Task",
    threadId: "thr_task-other",
    result: { rawOutput: "Other session output." }
  });
  const env = { ...process.env, GEMINI_COMPANION_SESSION_ID: "sess-current" };

  const blocked = run("node", [SCRIPT, "result", "task-other"], { cwd: workspace, env });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /No job found/i);

  const crossed = run("node", [SCRIPT, "result", "task-other", "--all"], { cwd: workspace, env });
  assert.equal(crossed.status, 0, crossed.stderr);
  assert.match(crossed.stdout, /Other session output\./);
});

test("cancel is scoped to the current session and will not target another session's job", () => {
  const workspace = makeTempDir();
  seedState(workspace, [
    {
      id: "task-other",
      status: "running",
      jobClass: "task",
      kindLabel: "rescue",
      title: "Gemini Task",
      sessionId: "sess-other",
      summary: "Other session task",
      createdAt: "2026-03-18T15:30:00.000Z",
      updatedAt: "2026-03-18T15:30:00.000Z"
    }
  ]);
  const env = { ...process.env, GEMINI_COMPANION_SESSION_ID: "sess-current" };

  // By id: the job belongs to another session, so it is not a candidate.
  const byId = run("node", [SCRIPT, "cancel", "task-other"], { cwd: workspace, env });
  assert.notEqual(byId.status, 0);
  assert.match(byId.stderr, /No job found/i);

  // No id: the only active job belongs to another session, so there is nothing
  // in scope to cancel (it must NOT silently grab the other session's job).
  const noId = run("node", [SCRIPT, "cancel"], { cwd: workspace, env });
  assert.notEqual(noId.status, 0);
  assert.match(noId.stderr, /No active Gemini jobs to cancel/i);
});

// ---------------------------------------------------------------------------
// P1-4: stdin prompt safety (gemini engine never puts the prompt in argv)
// ---------------------------------------------------------------------------

test("gemini engine delivers a metacharacter-laden prompt via stdin, never argv", () => {
  const { repo, binDir } = setupRepo("task");
  commit(repo, "README.md", "hello\n");

  // Deliver the prompt over stdin so the OUTER test shell cannot reinterpret the
  // metacharacters; this exercises the same companion -> gemini stdin path used
  // in production (readStdinIfPiped -> runGeminiTurn input).
  const nastyPrompt = `fix 'a' "b" \`c\` x;y|z&w $(id) %PATH% && rm -rf / \n line2`;
  const result = run("node", [SCRIPT, "task"], { cwd: repo, env: buildEnv(binDir), input: nastyPrompt });

  assert.equal(result.status, 0, result.stderr);
  const { lastInvocation } = readFakeState(binDir);
  // The full prompt arrives verbatim on stdin...
  assert.equal(lastInvocation.prompt, nastyPrompt);
  // ...and never leaks into argv.
  assert.ok(!lastInvocation.args.includes(nastyPrompt));
  for (const fragment of ["rm -rf /", "$(id)", "|z&w", "`c`", "%PATH%"]) {
    assert.ok(
      !lastInvocation.args.some((arg) => String(arg).includes(fragment)),
      `argv must not contain prompt fragment: ${fragment}`
    );
  }
});

// Unlike the prompt, --model rides in argv, and the gemini `.cmd` shim runs
// under shell:true on Windows. A metacharacter-laden model id must be rejected
// before any spawn so it can never be reinterpreted by cmd.exe.
test("gemini engine rejects a shell-metacharacter --model and never reaches argv", () => {
  const { repo, binDir } = setupRepo("task");
  commit(repo, "README.md", "hello\n");

  // Spawn node by absolute path so the OUTER test shell (shell:true on Windows
  // for a bare "node") cannot itself split the payload before it reaches the
  // companion; we are asserting the companion's own argv hygiene.
  const payload = "flash & echo PWNED > %TEMP%\\gemini-pwned.txt & rem";
  const result = run(process.execPath, [SCRIPT, "task", "--model", payload, "diagnose"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid model id/i);

  // The fake gemini may answer a --version probe, but the injection payload must
  // never appear in any argv handed to the CLI.
  const statePath = path.join(binDir, "fake-gemini-state.json");
  if (fs.existsSync(statePath)) {
    const args = readFakeState(binDir).lastInvocation?.args ?? [];
    assert.ok(!args.some((arg) => String(arg).includes("PWNED")), "payload must never reach gemini argv");
  }
});

// A flag-like model id (leading hyphen) must also be rejected: passed as the
// value of `-m`, a string like `--yolo` could otherwise be re-parsed by the
// gemini binary as a separate flag (e.g. enabling write mode).
test("gemini engine rejects a flag-like --model that could inject a CLI flag", () => {
  const { repo, binDir } = setupRepo("task");
  commit(repo, "README.md", "hello\n");

  const result = run(process.execPath, [SCRIPT, "task", "--model", "--yolo", "diagnose"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid model id/i);
});

// ---------------------------------------------------------------------------
// P1-3: reasoning noise on stderr must not pollute the stdout JSON parse
// ---------------------------------------------------------------------------

test("review parses cleanly even when gemini writes reasoning noise to stderr", () => {
  const { repo, binDir } = setupRepo("review-noisy");
  commit(repo, "src/app.js", "export const value = items[0];\n");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  // The structured verdict/finding parsed despite the stderr reasoning lines...
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.match(result.stdout, /Missing empty-state guard/);
  // ...and the reasoning is surfaced separately, not mixed into the JSON.
  assert.match(result.stdout, /Reasoning:/);
  // ...genuine reasoning survives the noise filter...
  assert.match(result.stdout, /Considering empty-state/);
  // ...including a real reasoning line that merely contains a bracketed [DEPnn]
  // token (the narrowed noise regex must not strip it)...
  assert.match(result.stdout, /Cross-checking \[DEP12\] handling/);
  // ...but the terminal-capability (true-color) warning and the genuine Node
  // deprecation preamble are filtered out of it.
  assert.doesNotMatch(result.stdout, /True color/i);
  assert.doesNotMatch(result.stdout, /DEP0190/);
});

// ---------------------------------------------------------------------------
// stop-review-gate hook
// ---------------------------------------------------------------------------

function runStopGate(cwd, env) {
  return run("node", [STOP_GATE_HOOK], { cwd, env, input: JSON.stringify({ cwd }) });
}

test("stop-gate stays silent and exits 0 when the gate is disabled", () => {
  const workspace = makeTempDir();
  seedState(workspace, [], { stopReviewGateEnabled: false });

  const result = runStopGate(workspace, envWithoutSession());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
});

test("stop-gate proceeds without a warning when enabled but no write task completed", () => {
  const workspace = makeTempDir();
  seedState(
    workspace,
    [{ id: "review-1", status: "completed", jobClass: "review", kindLabel: "review", title: "Gemini Review" }],
    { stopReviewGateEnabled: true }
  );

  const result = runStopGate(workspace, envWithoutSession());
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, "proceed");
  assert.ok(!decision.systemMessage, "no skip warning when there is nothing to review");
});

test("stop-gate fails OPEN with a visible warning when the review cannot run", () => {
  // A completed --write task arms the gate, but the review is forced to fail:
  // unavailable engines + a non-git workspace guarantee the companion errors,
  // so the hook must proceed (never trap the user) AND surface why.
  const workspace = makeTempDir();
  const binDir = makeTempDir();
  installUnavailableEngines(binDir);
  seedState(
    workspace,
    [{ id: "task-1", status: "completed", jobClass: "task", write: true, kindLabel: "rescue", title: "Gemini Task" }],
    { stopReviewGateEnabled: true }
  );

  const result = runStopGate(workspace, buildEnvUnavailable(binDir));
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, "proceed", "fail-open: never block on review failure");
  assert.match(decision.systemMessage ?? "", /skipped/i);
  // The same warning is written to stderr as a belt-and-suspenders fallback.
  assert.match(result.stderr, /review gate skipped/i);
});
