#!/usr/bin/env node
// reviewer-demo.mjs — exercise every user-facing command with no Google account,
// no OAuth, and no API key.
//
// WHY THIS EXISTS
// ---------------
// The Anthropic Software Directory Policy (3.D) asks a developer to "provide a
// standard testing account with sample data for Anthropic to verify full
// Software functionality". This plugin issues no accounts: it is a bridge to a
// Gemini CLI or AGY binary that the user installs and authenticates themselves,
// with credentials Google issues, and consumer CLI access ended on 2026-06-18.
// There is no account to hand over.
//
// What can be handed over is this: a run of every command against a stand-in
// engine, on a disposable repository, producing real plugin output. It verifies
// everything the plugin itself does — argv construction, engine detection,
// stdin transport, JSON envelope parsing, job lifecycle, secret redaction,
// rendering. It cannot verify what only Google can answer, and it says so at
// every step rather than letting a canned reply pass for model output.
//
// SCOPE
// -----
// This script is a repository tool. It is not part of the installed plugin, it
// is not on any command path a user reaches, and nothing under plugins/gemini/
// imports it. The stand-in engine is the same fixture the test suite uses
// (tests/fixtures/fake-gemini.cjs), reused rather than reimplemented so it
// cannot drift into describing behavior the tests do not check.
//
// USAGE
// -----
//   node scripts/reviewer-demo.mjs            run every step, then clean up
//   node scripts/reviewer-demo.mjs --keep     leave the workspace in place
//   node scripts/reviewer-demo.mjs --list     print the steps without running

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveJobsDir } from "../plugins/gemini/scripts/lib/state.mjs";
import { installFakeGemini } from "../tests/fake-gemini-fixture.mjs";
import { initGitRepo } from "../tests/helpers.mjs";

// Git and the engine probes reach bare command names, which spawn through the
// shell on Windows and emit Node 24's DEP0190. That warning is about this
// repository's own code (see issue #49) and has nothing to teach a reviewer
// reading a functional walkthrough, so it is silenced here and in every child.
process.noDeprecation = true;

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMPANION = path.join(REPO_ROOT, "plugins", "gemini", "scripts", "gemini-companion.mjs");
const TRANSFER = path.join(REPO_ROOT, "plugins", "gemini", "scripts", "transfer.mjs");

const BOLD = "[1m";
const DIM = "[2m";
const CYAN = "[36m";
const YELLOW = "[33m";
const RESET = "[0m";
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, text) => (color ? `${code}${text}${RESET}` : text);

let stepNumber = 0;

function heading(title, explanation) {
  stepNumber += 1;
  process.stdout.write(`\n${c(BOLD, `── ${stepNumber}. ${title} `.padEnd(72, "─"))}\n`);
  process.stdout.write(`${c(DIM, explanation)}\n\n`);
}

function note(text) {
  process.stdout.write(`${c(YELLOW, "   note: ")}${c(DIM, text)}\n`);
}

// Job ids are `<kind>-<base36 time>-<hex>` (lib/state.mjs generateJobId).
const JOB_ID = /\b((?:task|review)-[a-z0-9]+-[0-9a-f]+)\b/;

// Print the command the way a reviewer would type it, then run it verbatim.
function show(args, options = {}) {
  const display = ["node", path.relative(REPO_ROOT, options.script ?? COMPANION), ...args]
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
  process.stdout.write(`${c(CYAN, "$ ")}${display}\n`);

  const result = spawnSync(process.execPath, ["--no-deprecation", options.script ?? COMPANION, ...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    windowsHide: true
  });

  const body = stripAnsi(`${result.stdout ?? ""}${result.stderr ?? ""}`).trimEnd();
  if (body) process.stdout.write(indent(body) + "\n");
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`step ${stepNumber} exited ${result.status}`);
  }
  return { ...result, body };
}

// The commands colorize their own output; NO_COLOR is not honored on every
// path, and nested escapes make a captured transcript hard to read.
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/\[[0-9;]*m/g, "");
}

function indent(text) {
  return text.split(/\r?\n/).map((line) => (line ? `  ${line}` : line)).join("\n");
}

// A workspace with a planted defect for review to find, a secret file to prove
// redaction, and one commit so a diff exists.
function buildWorkspace(root) {
  const repo = path.join(root, "sample-repo");
  fs.mkdirSync(repo, { recursive: true });
  initGitRepo(repo);

  fs.writeFileSync(path.join(repo, "README.md"), "# sample\n\nDisposable repository for the reviewer demo.\n", "utf8");
  fs.writeFileSync(
    path.join(repo, "src.js"),
    "export function firstItem(items) {\n  return items[0].name;\n}\n",
    "utf8"
  );
  spawnSync("git", ["add", "-A"], { cwd: repo, windowsHide: true });
  spawnSync("git", ["commit", "-m", "initial"], { cwd: repo, windowsHide: true });

  // Uncommitted change: this is what review and transfer will pick up.
  fs.writeFileSync(
    path.join(repo, "src.js"),
    "export function firstItem(items) {\n  // no empty-collection guard\n  return items[0].name;\n}\n",
    "utf8"
  );
  // A credential-looking file. Its contents must never appear in what is sent.
  fs.writeFileSync(path.join(repo, ".env"), "API_TOKEN=demo-secret-value-do-not-send\n", "utf8");

  return repo;
}

function buildEnv(binDir, dataDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`,
    GEMINI_ENGINE: "gemini",
    GEMINI_HOME: path.join(binDir, "gemini-home"),
    // Job state goes to the disposable directory, never the reviewer's own.
    GEMINI_COMPANION_DATA: dataDir,
    // The credential check would otherwise probe the reviewer's real keychain.
    GEMINI_COMPANION_DISABLE_KEYCHAIN: "1",
    NO_COLOR: "1"
  };
}

// Switch the stand-in engine's canned reply. Written by installFakeGemini and
// read on each invocation, so it can change between steps.
function setScenario(binDir, scenario) {
  fs.writeFileSync(
    path.join(binDir, "fake-gemini-config.json"),
    JSON.stringify({ scenario }, null, 2),
    "utf8"
  );
}

// The shared fixture answers instantly, so a job started for the cancel step
// finishes before the cancel arrives and taskkill reports a process that no
// longer exists — a race, not a defect, but it demonstrates nothing. Swap in a
// stand-in that blocks until killed so cancellation has something to cancel.
// Restored by reinstalling the fixture afterwards.
function installSlowGemini(binDir, seconds = 120) {
  const source = [
    "#!/usr/bin/env node",
    '"use strict";',
    'if (process.argv.slice(2).includes("--version")) {',
    '  process.stdout.write("gemini-cli test 0.0.0-fake-slow\\n");',
    "  process.exit(0);",
    "}",
    "process.stdin.resume();",
    `setTimeout(() => process.exit(0), ${seconds * 1000});`
  ].join("\n");

  fs.writeFileSync(path.join(binDir, "gemini"), source, "utf8");
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "gemini.cmd"), `@echo off\r\nnode "%~dp0gemini" %*\r\n`, "utf8");
  } else {
    fs.chmodSync(path.join(binDir, "gemini"), 0o755);
  }
}

// Both waits below read the job file directly instead of spawning `status` on
// every poll. That spawn was part of what they were waiting out: a whole Node
// process per iteration, on a machine already running the rest of the suite, so
// the loop competed with the worker it was waiting for. A file read costs
// nothing, which is what lets the interval drop and the budget mean what it
// says. The polls were never shown to the reviewer -- only the `show()` calls
// are -- so nothing about the walkthrough's evidence changes.
//
// resolveStateDir reads GEMINI_COMPANION_DATA from process.env, and the demo
// sets that only on the CHILD env. Borrow it for this one pure call rather than
// rebuilding the slug/hash layout here, which would break silently the day
// resolveStateDir changes.
function resolveDemoJobsDir(dataDir, cwd) {
  const previous = process.env.GEMINI_COMPANION_DATA;
  process.env.GEMINI_COMPANION_DATA = dataDir;
  try {
    return resolveJobsDir(cwd);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_COMPANION_DATA;
    else process.env.GEMINI_COMPANION_DATA = previous;
  }
}

// Deliberately NOT state.mjs's readJobFile: that one turns an unreadable file
// into a synthetic `failed` job, which a poller would read as a terminal state
// and stop on. A half-written file means "not yet", so this returns null and
// the caller keeps waiting.
function readDemoJob(jobsDir, jobId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(jobsDir, `${jobId}.json`), "utf8"));
  } catch {
    return null;
  }
}

function waitForJob(jobsDir, jobId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = readDemoJob(jobsDir, jobId);
    if (job && ["completed", "failed", "cancelled", "canceled"].includes(String(job.status))) return job.status;
    sleep(100);
  }
  return "timed-out";
}

// The cancel step needs a job whose engine is up, because the point of the step
// is terminating a live process tree. `task --background` returns as soon as the
// worker is *spawned*, not when it has started, so the step used to wait a fixed
// two seconds and hope. On a loaded machine two seconds is not enough: the
// walkthrough then cancelled a job the state directory could not yet describe,
// and the step produced no output at all -- a failure of the demo's timing,
// reported as if the plugin could not cancel a job.
//
// So wait for the state the step actually needs. That state is not `pid`: the
// worker records `running` with its pid *before* it starts the engine, so at
// that instant the only thing to kill is the worker itself. Measured on this
// machine, the engine turn begins about 900ms after that record appears, and
// the plugin announces it by moving the job to phase `running` (`reviewing` for
// a review) on the same event that logs "Starting <engine> turn...".
//
// Waiting for the phase instead means the step demonstrates what it claims,
// rather than cancelling during engine detection whenever the machine is slow.
// It also stops the demo aiming at the narrowest possible window: an engine
// killed in the moment it is being created can outlive the cancel that reported
// it terminated, which is a real defect (v0.22.1) but not what this step is for.
// "engine" — the turn has started, which is what the step wants to cancel.
// "worker" — a worker is up but its engine never reported in; cancel still has
// something to terminate, and the step says so rather than pretending.
// "none"   — nothing to go on.
function waitForRunningJob(jobsDir, jobId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let sawWorker = false;
  while (Date.now() < deadline) {
    const job = readDemoJob(jobsDir, jobId);
    const status = String(job?.status ?? "");
    const phase = String(job?.phase ?? "");
    if (status === "running" && job.pid) {
      sawWorker = true;
      if (phase === "running" || phase === "reviewing") return "engine";
    }
    // Anything neither queued nor running has finished, and will never reach
    // running. Phrased as the complement of "still active" rather than as a
    // list of terminal states, which would need updating every time the
    // runtime gains one.
    if (status && status !== "queued" && status !== "running") return sawWorker ? "worker" : "none";
    sleep(100);
  }
  return sawWorker ? "worker" : "none";
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A cancelled worker can still hold its log file open for a moment, and Windows
// refuses to delete a directory containing an open handle. Retry briefly rather
// than ending a successful walkthrough on a cleanup error.
function removeWorkspace(root) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      process.stdout.write(`\n${c(DIM, "workspace removed (pass --keep to inspect it)")}\n`);
      return;
    } catch (error) {
      if (!["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"].includes(error?.code)) throw error;
      sleep(500);
    }
  }
  process.stdout.write(
    `\n${c(YELLOW, "could not remove the workspace — a worker may still hold a file open.")}\n` +
    `${c(DIM, `delete it manually: ${root}`)}\n`
  );
}

const STEPS = [
  "setup — engine detection and readiness",
  "task — foreground delegation",
  "task --background, status, result — the job lifecycle",
  "review — structured findings over a real diff",
  "adversarial-review — the same diff, adversarial prompt",
  "cancel — terminating a job",
  "transfer — context export with secret redaction"
];

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("Usage: node scripts/reviewer-demo.mjs [--keep] [--list]\n");
    return;
  }
  if (argv.includes("--list")) {
    STEPS.forEach((s, i) => process.stdout.write(`${i + 1}. ${s}\n`));
    return;
  }
  const keep = argv.includes("--keep");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-reviewer-demo-"));
  const binDir = path.join(root, "bin");
  const dataDir = path.join(root, "plugin-data");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  installFakeGemini(binDir, "task");
  const repo = buildWorkspace(root);
  const env = buildEnv(binDir, dataDir);
  const jobsDir = resolveDemoJobsDir(dataDir, repo);

  process.stdout.write(`${c(BOLD, "agy-plugin-cc — credential-free functional walkthrough")}\n`);
  process.stdout.write(`${c(DIM, `workspace: ${root}`)}\n`);
  process.stdout.write(
    `${c(YELLOW, "Every model reply below comes from tests/fixtures/fake-gemini.cjs, a stand-in engine.")}\n` +
    `${c(YELLOW, "The plugin's own behavior is real; the text the engine returns is canned.")}\n`
  );

  try {
    heading(STEPS[0], "Detects the engine on PATH, reads its version, and reports whether it has a usable credential.");
    show(["setup"], { cwd: repo, env });
    note("The stand-in answers --version like the real CLI, so this is the real detection path.");

    heading(STEPS[1], "Delegates a task and renders the reply. The prompt travels on stdin, never argv.");
    setScenario(binDir, "task");
    show(["task", "explain what firstItem does and whether it is safe"], { cwd: repo, env });
    note("Read-only by default since v0.16.0 — no --write, so the engine is not bound to this repository.");

    heading(STEPS[2], "Runs the same delegation detached, then polls and collects it.");
    const started = show(["task", "--background", "add a regression test for the empty case"], { cwd: repo, env });
    const jobId = (started.body.match(JOB_ID) ?? [])[1];
    if (jobId) {
      const status = waitForJob(jobsDir, jobId);
      process.stdout.write(`${c(DIM, `  (waited for ${jobId} → ${status})`)}\n`);
      show(["status", "--all"], { cwd: repo, env });
      show(["result", jobId], { cwd: repo, env, allowFailure: true });
    } else {
      note("No job id was printed; skipping status/result for this run.");
    }

    heading(STEPS[3], "Sends the working-tree diff and parses the structured findings back out of the JSON envelope.");
    setScenario(binDir, "review-findings");
    show(["review", "--wait"], { cwd: repo, env });
    note("Severity, file, line range and confidence are parsed from the envelope, not printed verbatim.");

    heading(STEPS[4], "Same diff, adversarial prompt, optional focus text.");
    show(["adversarial-review", "--wait", "focus on error handling"], { cwd: repo, env });

    heading(STEPS[5], "Terminates a running job's process tree, then shows the job recorded as cancelled.");
    installSlowGemini(binDir);
    note("The stand-in is swapped for one that blocks, so there is a live process to cancel.");
    const toCancel = show(["task", "--background", "a job that will be cancelled"], { cwd: repo, env });
    const cancelId = (toCancel.body.match(JOB_ID) ?? [])[1];
    if (cancelId) {
      const ready = waitForRunningJob(jobsDir, cancelId);
      if (ready === "worker") {
        note("The engine never reported its turn; cancelling the worker anyway.");
      } else if (ready === "none") {
        note("The worker never reported a running process; cancelling anyway.");
      }
      show(["cancel", cancelId], { cwd: repo, env, allowFailure: true });
      show(["status", cancelId], { cwd: repo, env, allowFailure: true });
    } else {
      note("No job id was printed; skipping cancel for this run.");
    }
    installFakeGemini(binDir, "task");

    heading(STEPS[6], "Exports the workspace context for a hand-off, with credential-looking files withheld.");
    show(["--engine", "gemini", "review this change"], { cwd: repo, env, script: TRANSFER });
    note("`.env` was included in the snapshot as a changed file, but its contents were replaced. Grep the snapshot under .omc/transfers/ for 'demo-secret-value' — it is not there.");

    const snapshotDir = path.join(repo, ".omc", "transfers");
    if (fs.existsSync(snapshotDir)) {
      const leaked = fs.readdirSync(snapshotDir)
        .filter((f) => f.endsWith(".json"))
        .some((f) => fs.readFileSync(path.join(snapshotDir, f), "utf8").includes("demo-secret-value"));
      process.stdout.write(
        leaked
          ? `${c(YELLOW, "  CHECKED: secret value FOUND in the snapshot — this is a defect, please report it.")}\n`
          : `${c(DIM, "  checked: the secret value is absent from every snapshot on disk.")}\n`
      );
    }

    process.stdout.write(`\n${c(BOLD, "── Done ".padEnd(72, "─"))}\n`);
    process.stdout.write(
      `${c(DIM, "Verified here: engine detection, stdin transport, envelope parsing, job\n" +
      "lifecycle, review rendering, secret redaction, and the read-only default.\n" +
      "Not verified here: anything only Google can answer — model quality, real\n" +
      "auth, quota, and the agentic behavior of a live engine inside a workspace.\n" +
      "See docs/verifying-without-credentials.md for what a credentialed run adds.")}\n`
    );
  } finally {
    if (keep) {
      process.stdout.write(`\n${c(DIM, `kept: ${root}`)}\n`);
    } else {
      removeWorkspace(root);
    }
  }
}

main();
