import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "reviewer-demo.mjs");

// This script is what a directory reviewer runs instead of the testing account
// this plugin cannot issue (Anthropic Software Directory Policy 3.D). If it
// breaks, the only evidence of full functionality that does not need a Google
// credential breaks with it — and nothing else in the suite would notice,
// because it drives the commands from outside rather than importing them.

// Cleanup is best effort, like the demo’s own removeWorkspace() and
// isolate-state.mjs. The cancel step leaves a stand-in engine whose cwd is the
// workspace; if it outlives the retries, Windows refuses the delete. The OS
// reclaims temp either way, and throwing from an after hook fails a test whose
// assertions all passed — which is how this surfaced, as a red "redaction
// claim" that had nothing to do with redaction.
const BUSY = ["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"];

function discardWorkspace(kept) {
  if (!kept) return;
  try {
    fs.rmSync(kept, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (error) {
    if (!BUSY.includes(error?.code)) throw error;
    process.stderr.write(`left ${kept} for the OS: ${error.code} (a demo process still holds it)\n`);
  }
}

// The plugin writes one log per job under the workspace it was given; --keep
// leaves them, which is how the walkthrough can be checked against what the
// plugin recorded rather than only against what it printed.
function findJobLog(kept, marker) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".log")) found.push(full);
    }
  };
  const state = path.join(kept, "plugin-data");
  if (!fs.existsSync(state)) return null;
  walk(state);
  for (const file of found) {
    const body = fs.readFileSync(file, "utf8");
    if (body.includes(marker)) return body;
  }
  return null;}

test("reviewer-demo lists its steps without running anything", () => {
  const result = run("node", [SCRIPT, "--list"], { cwd: ROOT });
  assert.equal(result.status, 0, result.stderr);
  for (const command of ["setup", "task", "review", "adversarial-review", "cancel", "transfer"]) {
    assert.match(result.stdout, new RegExp(command), `step list omits ${command}`);
  }
});

test("reviewer-demo runs every command end to end", (t) => {
  // --keep so the redaction claim can be checked against the files on disk
  // rather than taken from the demo's own summary line.
  const result = run("node", [SCRIPT, "--keep"], { cwd: ROOT });
  const kept = (result.stdout.match(/^kept: (.+)$/m) ?? [])[1];
  t.after(() => discardWorkspace(kept));

  assert.equal(result.status, 0, result.stderr);

  // Each step must have produced plugin output, not just printed a heading — a
  // silently skipped step would still exit 0.
  const expected = [
    /# Gemini Setup/,
    /Status: ready/,
    /Handled the requested task\./,          // foreground delegation
    /started in the background as/,          // detached job
    /# Gemini Status/,
    /# Gemini Review/,
    /# Gemini Adversarial Review/,
    /Missing empty-state guard/,             // structured finding parsed from the envelope
    /# Gemini Cancel/,
    /\| cancelled \|/,                       // recorded cancelled, not merely killed
    /transfer snapshot created/
  ];
  for (const pattern of expected) {
    assert.match(result.stdout, pattern, `walkthrough never reached ${pattern}`);
  }

  // A reviewer must not be left believing canned text came from a model.
  assert.match(result.stdout, /stand-in engine/);
  assert.match(result.stdout, /Not verified here/);
  // Both fallback notes mean the step cancelled a worker that had not started its
  // turn yet, which is not what it claims to demonstrate.
  assert.doesNotMatch(result.stdout, /never reported/, "the cancel step did not wait for a running engine");
  // The step claims to terminate a running job’s process tree, and the job log is
  // where that can be checked rather than assumed: the worker records `running`
  // with its pid a beat before it starts the engine, so a cancel that arrives in
  // that gap kills a worker with nothing under it yet. The turn must have begun
  // first.
  const cancelLog = findJobLog(kept, "Cancelled by user");
  assert.ok(cancelLog, "the cancel step left no job log to check");
  // Checked for presence before order: indexOf returns -1 for a line that never
  // arrived, and -1 is less than everything, so the comparison alone would pass
  // most loudly in exactly the case it is meant to catch.
  assert.ok(cancelLog.includes("turn..."), `the engine turn never started before the cancel:\n${cancelLog}`);
  assert.ok(
    cancelLog.indexOf("turn...") < cancelLog.indexOf("Cancelled by user"),
    `the cancel arrived before the engine turn started:\n${cancelLog}`
  );

  assert.doesNotMatch(result.stderr, /DeprecationWarning/, "reviewer-facing output must be free of Node warnings");
});

test("reviewer-demo's redaction claim holds against the files it leaves behind", (t) => {
  const result = run("node", [SCRIPT, "--keep"], { cwd: ROOT });
  const kept = (result.stdout.match(/^kept: (.+)$/m) ?? [])[1];
  t.after(() => discardWorkspace(kept));

  assert.equal(result.status, 0, result.stderr);
  assert.ok(kept, "--keep did not report the workspace path");

  const secret = "demo-secret-value-do-not-send";
  const envFile = path.join(kept, "sample-repo", ".env");
  assert.ok(fs.existsSync(envFile), "the demo did not plant a credential file to withhold");
  assert.match(fs.readFileSync(envFile, "utf8"), new RegExp(secret), "the planted secret is not what the check looks for");

  const transfers = path.join(kept, "sample-repo", ".omc", "transfers");
  const snapshots = fs.readdirSync(transfers).filter((name) => name.endsWith(".json"));
  assert.ok(snapshots.length > 0, "the transfer step produced no snapshot");

  for (const name of snapshots) {
    const body = fs.readFileSync(path.join(transfers, name), "utf8");
    assert.ok(body.includes(".env"), `${name} should record that .env changed`);
    assert.ok(!body.includes(secret), `${name} leaked the credential it claims to withhold`);
  }

  // The job log is written by the plugin and kept on disk; nothing in the
  // walkthrough should have put the credential there either.
  const stateDir = path.join(kept, "plugin-data");
  const leaks = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (fs.readFileSync(full, "utf8").includes(secret)) leaks.push(full);
    }
  };
  if (fs.existsSync(stateDir)) walk(stateDir);
  assert.deepEqual(leaks, [], "the credential reached plugin job state");
});
