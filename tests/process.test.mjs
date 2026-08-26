import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import {
  terminateProcessTree,
  listChildProcesses,
  isPidAlive,
  binaryAvailable,
  formatCommandFailure,
  resolveBinaryPath,
  resolveNodeShimEntry,
  runCommand,
  quoteForWindowsShell,
  resetSpawnTargetCacheForTesting
} from "../plugins/gemini/scripts/lib/process.mjs";
import { makeTempDir } from "./helpers.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return { command, args, status: 0, signal: null, stdout: "", stderr: "", error: null };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, { command: "taskkill", args: ["/PID", "1234", "/T", "/F"] });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats a missing Windows process as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: 'ERROR: The process "1234" not found.',
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree skips a non-finite pid", () => {
  const outcome = terminateProcessTree(Number.NaN);
  assert.equal(outcome.attempted, false);
  assert.equal(outcome.delivered, false);
  assert.equal(outcome.method, null);
});

test("terminateProcessTree signals the process group on POSIX", () => {
  const signals = [];
  const outcome = terminateProcessTree(4321, {
    platform: "linux",
    killImpl(pid, signal) {
      signals.push({ pid, signal });
    }
  });
  assert.deepEqual(signals, [{ pid: -4321, signal: "SIGTERM" }]);
  assert.equal(outcome.method, "process-group");
  assert.equal(outcome.delivered, true);
});

test("binaryAvailable detects an available binary", () => {
  // Use a bare command resolved via PATH (how the plugin invokes gemini/agy);
  // an absolute path with spaces would break under runCommand's win32 shell:true.
  const result = binaryAvailable("git", ["--version"]);
  assert.equal(result.available, true);
  assert.match(result.detail, /\d+\.\d+/);
});

test("binaryAvailable reports an unavailable binary", () => {
  const result = binaryAvailable("definitely-not-a-real-binary-xyz-123", ["--version"]);
  assert.equal(result.available, false);
});

test("resolveBinaryPath finds a PATH command and passes absolute paths through", () => {
  const git = resolveBinaryPath("git");
  assert.equal(typeof git, "string");
  assert.match(git, /git/i);
  assert.equal(resolveBinaryPath("/already/absolute/tool"), "/already/absolute/tool");
});

test("runCommand preserves a spaced argv element when shell is enabled", () => {
  const result = runCommand(process.execPath, ["-p", "JSON.stringify(process.argv.slice(1))", "argument with spaces"], {
    shell: true
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '["argument with spaces"]');
});

test("runCommand leaves argv unchanged when shell is disabled", () => {
  const result = runCommand(process.execPath, ["-p", "JSON.stringify(process.argv.slice(1))", "argument with spaces"], {
    shell: false
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '["argument with spaces"]');
});

// Values with no shell-unsafe character are passed through untouched, which is
// why the trailing-backslash cases below all carry a space: a bare `a\` never
// reaches the quoting branch at all.
test("quoteForWindowsShell leaves values without shell-unsafe characters alone", () => {
  assert.equal(quoteForWindowsShell("plain"), "plain");
  assert.equal(quoteForWindowsShell("a\\b"), "a\\b");
  assert.equal(quoteForWindowsShell("trailing\\"), "trailing\\");
  assert.equal(quoteForWindowsShell(42), 42);
});

// MSVCRT rules: backslashes are literal except before a quote (double them) and
// at the end of the value (double them so they do not escape the closing quote).
// Escaping only `"` shipped `a b\` as `"a b\"`, which the child read as `a b"`.
test("quoteForWindowsShell doubles backslashes before a quote and at the end", () => {
  assert.equal(quoteForWindowsShell("a b\\"), '"a b\\\\"');
  assert.equal(quoteForWindowsShell("a b\\\\"), '"a b\\\\\\\\"');
  assert.equal(quoteForWindowsShell('b"c'), '"b\\"c"');
  assert.equal(quoteForWindowsShell('a\\"b'), '"a\\\\\\"b"');
  assert.equal(quoteForWindowsShell("x y"), '"x y"');
  // Interior backslashes not adjacent to a quote stay literal and single.
  assert.equal(quoteForWindowsShell("a\\b c"), '"a\\b c"');
});

// The string rules above only matter if they match what MSVCRT actually parses,
// and that can only be observed on Windows — POSIX sh reads these escapes
// differently, so this leg is skipped rather than asserted cross-platform.
test("runCommand round-trips awkward argv through the Windows shell path", { skip: process.platform !== "win32" }, () => {
  for (const value of ["a b\\", "a b\\\\", 'a\\"b', 'b"c', "x y", "p&q", "(x) y", "a|b"]) {
    // shell:true explicitly. A bare name no longer reaches the shell on its own
    // — it is resolved to an absolute path first — so this leg has to ask for
    // the shell to keep testing the quoting that path still depends on.
    const result = runCommand("node", ["-p", "JSON.stringify(process.argv.slice(1))", value], { shell: true });
    assert.equal(result.status, 0, `${JSON.stringify(value)}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout.trim()), [value]);
  }
});

// The shell path is the fallback now, not the default. Argv must survive the
// resolved path too — and there it is passed literally rather than quoted, so a
// regression would show up as a *changed* value rather than a failure to spawn.
test("runCommand passes argv literally when it resolves the command itself", { skip: process.platform !== "win32" }, () => {
  for (const value of ["a b\\", 'a\\"b', 'b"c', "p&q", "(x) y", "a|b", "%PATH%", "^caret"]) {
    const result = runCommand("node", ["-p", "JSON.stringify(process.argv.slice(1))", value]);
    assert.equal(result.status, 0, `${JSON.stringify(value)}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout.trim()), [value]);
  }
});

// %PATH% would be expanded by cmd.exe and is left alone without it. This is the
// observable difference between the two paths, and the reason the resolved one
// is preferable: nothing re-parses the arguments.
test("a resolved command does not let cmd.exe expand an argument", { skip: process.platform !== "win32" }, () => {
  const resolved = runCommand("node", ["-p", "process.argv[1]", "%PATH%"]);
  assert.equal(resolved.stdout.trim(), "%PATH%");
});

// --- npm shim resolution ---
// A global npm "binary" on Windows is a shim that needs a shell. Reading the
// package's `bin` field lets it be spawned directly instead. Both rules below
// came from a misresolution observed on this machine, not from theory.

function installShimPackage(binDir, { pkg, bin, entry = "bundle/cli.js", shimBody } = {}) {
  const pkgDir = path.join(binDir, "node_modules", ...pkg.split("/"));
  fs.mkdirSync(path.join(pkgDir, path.dirname(entry)), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, entry), "// entry\n", "utf8");
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: pkg, version: "1.0.0", bin }, null, 2),
    "utf8"
  );
  const shim = path.join(binDir, "thing.cmd");
  fs.writeFileSync(shim, shimBody ?? `@echo off\r\nnode "%~dp0\\node_modules\\${pkg.replace(/\//g, "\\")}\\${entry.replace(/\//g, "\\")}" %*\r\n`, "utf8");
  return { shim, entry: path.join(pkgDir, entry) };
}

test("a shim resolves to the entry its package's bin field names", () => {
  const binDir = makeTempDir("gemini-shim-");
  const { shim, entry } = installShimPackage(binDir, {
    pkg: "@scope/thing-cli",
    bin: { thing: "bundle/cli.js" }
  });
  assert.equal(resolveNodeShimEntry(shim, "thing"), fs.realpathSync.native(entry));
});

// npm's own shim names both bin/npm-cli.js and bin/npm-prefix.js. Taking the
// first .js in the file ran npm-prefix.js, which exits 0 and prints a path — a
// wrong program reporting success, which is worse than a failure.
test("a shim naming several scripts still resolves through bin, not first match", () => {
  const binDir = makeTempDir("gemini-shim-");
  const pkgDir = path.join(binDir, "node_modules", "thing");
  fs.mkdirSync(path.join(pkgDir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "bin", "thing-prefix.js"), "// decoy\n", "utf8");
  fs.writeFileSync(path.join(pkgDir, "bin", "thing-cli.js"), "// real\n", "utf8");
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "thing", version: "1.0.0", bin: { thing: "bin/thing-cli.js" } }, null, 2),
    "utf8"
  );
  const shim = path.join(binDir, "thing.cmd");
  fs.writeFileSync(
    shim,
    '@echo off\r\nSET PREFIX_JS="%~dp0\\node_modules\\thing\\bin\\thing-prefix.js"\r\n' +
    'node "%~dp0\\node_modules\\thing\\bin\\thing-cli.js" %*\r\n',
    "utf8"
  );

  assert.equal(
    resolveNodeShimEntry(shim, "thing"),
    fs.realpathSync.native(path.join(pkgDir, "bin", "thing-cli.js")),
    "resolved the decoy that appears first in the shim text"
  );
});

test("a shim whose package does not claim this command name is not followed", () => {
  const binDir = makeTempDir("gemini-shim-");
  const { shim } = installShimPackage(binDir, {
    pkg: "thing",
    bin: { somethingelse: "bundle/cli.js" }
  });
  assert.equal(resolveNodeShimEntry(shim, "thing"), null);
});

test("a shim pointing outside its own directory is not followed", () => {
  const binDir = makeTempDir("gemini-shim-");
  const outside = makeTempDir("gemini-outside-");
  fs.writeFileSync(path.join(outside, "evil.js"), "// elsewhere\n", "utf8");

  const pkgDir = path.join(binDir, "node_modules", "thing");
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({ name: "thing", version: "1.0.0", bin: { thing: path.relative(pkgDir, path.join(outside, "evil.js")).replace(/\\/g, "/") } }, null, 2),
    "utf8"
  );
  const shim = path.join(binDir, "thing.cmd");
  fs.writeFileSync(shim, '@echo off\r\nnode "%~dp0\\node_modules\\thing\\whatever.js" %*\r\n', "utf8");

  assert.equal(resolveNodeShimEntry(shim, "thing"), null);
});

test("a shim with no package to read resolves to nothing rather than a guess", () => {
  const binDir = makeTempDir("gemini-shim-");
  const shim = path.join(binDir, "thing.cmd");
  fs.writeFileSync(shim, '@echo off\r\nnode "%~dp0\\thing" %*\r\n', "utf8");
  assert.equal(resolveNodeShimEntry(shim, "thing"), null);
});

// The fixtures shadow a real CLI by putting a stand-in earlier on PATH. If
// resolution searched past the first PATH directory it would find the real
// installation and run that instead — which it did, until it didn't.
test("a shadowing stand-in earlier on PATH wins over a real install behind it", { skip: process.platform !== "win32" }, () => {
  const shadowDir = makeTempDir("gemini-shadow-");
  fs.writeFileSync(
    path.join(shadowDir, "node.cmd"),
    "@echo off\r\necho SHADOWED\r\n",
    "utf8"
  );

  const result = runCommand("node", ["--version"], {
    env: { ...process.env, PATH: `${shadowDir};${process.env.PATH}` }
  });
  assert.match(result.stdout, /SHADOWED/, "resolution walked past the shadowing directory");
});

// The mirror image of the test above, and the one that was missing: a stand-in
// the USER put on PATH must win, but a stand-in merely sitting in the directory
// being worked on must not. Opening a repository is not consent to run what is
// inside it.
//
// Two separate mechanisms searched the current directory, and each hid the
// other. They need separate tests because they are reached under opposite
// conditions -- resolution succeeding, and resolution failing.

// Mechanism 1: `where.exe` searches the current directory before PATH, and keeps
// doing so even when NoDefaultCurrentDirectoryInExePath is set. Resolution
// trusted its first hit, so a tree holding `git.exe` got that file spawned.
//
// The lookup runs from `process.cwd()`, not from the `cwd` passed to
// runCommand -- which is the whole reason this needs a child process. In
// deployment the two are the same thing: the companion script's process cwd IS
// the workspace. An in-process version of this test asserts against a directory
// the lookup never consults, and passes whether or not the fix is present.
test("a planted executable in the process's own directory never wins", { skip: process.platform !== "win32" }, () => {
  const workspace = makeTempDir("gemini-cwd-shadow-");
  // Deliberately not a real executable: if resolution picks it, the spawn fails
  // outright instead of quietly succeeding, so `error` catches what stdout cannot.
  fs.writeFileSync(path.join(workspace, "git.exe"), "not a real executable", "utf8");

  const moduleUrl = new URL("../plugins/gemini/scripts/lib/process.mjs", import.meta.url).href;
  const probe = path.join(workspace, "probe.mjs");
  fs.writeFileSync(
    probe,
    `import { runCommand } from ${JSON.stringify(moduleUrl)};\n` +
      `const r = runCommand("git", ["--version"], { cwd: process.cwd() });\n` +
      `process.stdout.write(JSON.stringify({ stdout: r.stdout, error: r.error?.message ?? null }));\n`,
    "utf8"
  );

  const run = spawnSync(process.execPath, [probe], { cwd: workspace, encoding: "utf8" });
  const seen = JSON.parse(run.stdout);
  assert.equal(seen.error, null, "the planted git.exe was spawned");
  assert.match(seen.stdout, /git version/, "expected the real git");
});

// Mechanism 2: the fallback shell is cmd.exe, which searches the current
// directory too -- but only when NoDefaultCurrentDirectoryInExePath is unset.
// Git Bash sets it, so a suite run from Git Bash cannot see this branch at all;
// a plain PowerShell, cmd, or service environment does not set it. The env below
// strips it, which is what those look like.
//
// Reaching the fallback at all takes a command resolution cannot identify: a
// PATH entry that is a `.cmd` but not an npm node shim. That is the only way
// computeSpawnTarget returns null and the shell runs.
test("the fallback shell does not prefer the working directory", { skip: process.platform !== "win32" }, () => {
  const pathDir = makeTempDir("gemini-fallback-path-");
  const workspace = makeTempDir("gemini-fallback-ws-");
  fs.writeFileSync(path.join(pathDir, "thing.cmd"), "@echo off\r\necho REAL-FROM-PATH\r\n", "utf8");
  fs.writeFileSync(path.join(workspace, "thing.cmd"), "@echo off\r\necho HIJACKED-FROM-CWD\r\n", "utf8");

  const env = { ...process.env, PATH: `${pathDir};${process.env.PATH}` };
  delete env.NoDefaultCurrentDirectoryInExePath;

  // The resolution cache is keyed by command and PATH, not by cwd -- correct
  // only because the lookup no longer depends on cwd. Cleared anyway so a hit
  // cached by an earlier test cannot stand in for the answer under test.
  resetSpawnTargetCacheForTesting();
  const result = runCommand("thing", [], { cwd: workspace, env });
  assert.doesNotMatch(result.stdout, /HIJACKED/, "the working tree's stand-in answered");
  assert.match(result.stdout, /REAL-FROM-PATH/, "expected the copy the user put on PATH");
});

test("formatCommandFailure formats exit-code and signal failures", () => {
  assert.equal(
    formatCommandFailure({ command: "git", args: ["status"], status: 1, signal: null, stderr: "boom", stdout: "" }),
    "git status: exit=1: boom"
  );
  assert.equal(
    formatCommandFailure({ command: "node", args: [], status: null, signal: "SIGKILL", stderr: "", stdout: "" }),
    "node: signal=SIGKILL"
  );
});

// ---------------------------------------------------------------------------
// Windows never clears a process's parent link when the parent exits, so a
// reused pid inherits whatever still names it as parent. `taskkill /T` then
// tries to kill those too, and exits 128 when it may not — observed on this
// repository's own reviewer demo, where two system processes were reported as
// descendants of a job worker. The worker died; the exit code said failure;
// /gemini:cancel threw, the user's cancellation was never recorded, and the job
// was later reconciled as stale. Intermittent, because it needs a pid collision.
//
// The exit code cannot answer the only question that matters. These pin that the
// answer comes from measuring the process rather than reading a status code or a
// localized message.
// ---------------------------------------------------------------------------

function taskkillPartialFailure() {
  return {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: "",
        // Deliberately not English: the real message is localized, which is why
        // nothing here may depend on reading it.
        stderr: "錯誤: PID 為 2428 的處理程序無法終止。原因: 不支援所嘗試的操作。",
        error: null
      };
    }
  };
}

test("a taskkill that could not kill every claimed descendant still counts as delivered when the target is gone", () => {
  const outcome = terminateProcessTree(1234, {
    ...taskkillPartialFailure(),
    isPidAlive: () => false
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, true, "the process this cancel was aimed at is gone");
  assert.equal(outcome.treeIncomplete, true, "and the caller is told something it claimed survived");
});

test("a taskkill failure with the target still running is still an error", () => {
  assert.throws(
    () => terminateProcessTree(1234, { ...taskkillPartialFailure(), isPidAlive: () => true }),
    /taskkill/,
    "a cancel that did not cancel must not report success"
  );
});

test("a target that exits a moment after taskkill returns is not called a failure", () => {
  // `taskkill /F` returns before the kernel has finished the teardown, so an
  // immediate single check can still see the process. Without the settle window
  // this run is indistinguishable from the one above.
  let looks = 0;
  const outcome = terminateProcessTree(1234, {
    ...taskkillPartialFailure(),
    isPidAlive: () => {
      looks += 1;
      return looks < 3;
    }
  });

  assert.equal(outcome.delivered, true);
  assert.ok(looks >= 3, "it gave up before the process had a chance to exit");
});

// ---------------------------------------------------------------------------
// An engine does not normally outlive its worker, and the tree walk is not why:
// killing a worker with /F alone, no /T, takes its engine with it. What performs
// that collection was never identified — the engines are in no job object, and it
// is not the stand-in holding stdin — but about 3% of cancels under load escape
// it, and taskkill reported every one of those as a clean kill.
//
// So the tree is measured after the kill, not inferred from an exit code. These
// pin what that measurement may and may not do.
// ---------------------------------------------------------------------------

const FAKE_POWERSHELL = "C:\\fake\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function sweepScenario({ children = [], childSurvives = false, listingFails = false } = {}) {
  const calls = [];
  return {
    calls,
    platform: "win32",
    powerShellPath: FAKE_POWERSHELL,
    runCommandImpl(command, args) {
      calls.push({ command, args });
      if (command === FAKE_POWERSHELL) {
        return listingFails
          ? { command, args, status: 1, signal: null, stdout: "", stderr: "denied", error: null }
          : {
            command,
            args,
            status: 0,
            signal: null,
            stdout: children.map((child) => `${child.pid}|${child.createdAt}`).join("\n"),
            stderr: "",
            error: null
          };
      }
      return { command, args, status: 0, signal: null, stdout: "", stderr: "", error: null };
    },
    isPidAlive(pid) {
      return pid === 1234 ? false : childSurvives;
    }
  };
}

const JOB_STARTED = "2026-08-18T15:26:54.950Z";
const AFTER_START = "2026-08-18T15:27:00.304Z";   // the engine, spawned by this job
const BEFORE_START = "2026-08-18T09:00:00.000Z";  // a stranger on a reused pid

test("a cancel kills the engine that outlived its worker", () => {
  const scenario = sweepScenario({ children: [{ pid: 5678, createdAt: AFTER_START }] });
  const outcome = terminateProcessTree(1234, { ...scenario, notBefore: JOB_STARTED });

  assert.deepEqual(outcome.orphansKilled, [5678]);
  assert.ok(!outcome.treeIncomplete, "nothing of this job's was left running");
  assert.deepEqual(
    scenario.calls.map((call) => call.command === FAKE_POWERSHELL ? "list" : call.args.join(" ")),
    ["/PID 1234 /T /F", "list", "/PID 5678 /T /F"],
    "the worker is killed, its children measured, and the survivor killed"
  );
});

test("a cancel asks what the worker left only once the worker is gone", () => {
  // A worker that is still being torn down can still start an engine, so a
  // listing taken before it goes can be out of date by the time it is read.
  const events = [];
  let looks = 0;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    powerShellPath: FAKE_POWERSHELL,
    notBefore: JOB_STARTED,
    runCommandImpl(command, args) {
      events.push(command === FAKE_POWERSHELL ? "list" : `kill ${args[1]}`);
      return command === FAKE_POWERSHELL
        ? { command, args, status: 0, signal: null, stdout: "", stderr: "", error: null }
        : { command, args, status: 0, signal: null, stdout: "", stderr: "", error: null };
    },
    isPidAlive() {
      looks += 1;
      const stillThere = looks < 3;
      events.push(stillThere ? "worker still there" : "worker gone");
      return stillThere;
    }
  });

  assert.deepEqual(events, [
    "kill 1234",
    "worker still there",
    "worker still there",
    "worker gone",
    "list"
  ]);
  assert.ok(!outcome.treeIncomplete, "the worker did go, so the listing is final");
});

test("a worker that outlives its own kill is not reported as a finished tree", () => {
  // taskkill exited 0 and the process is still there: whatever the listing says,
  // it can still change, so the report may not claim the tree is done.
  const scenario = sweepScenario();
  const outcome = terminateProcessTree(1234, {
    ...scenario,
    notBefore: JOB_STARTED,
    isPidAlive: () => true
  });

  assert.equal(outcome.delivered, true, "taskkill said it killed it");
  assert.equal(outcome.treeIncomplete, true, "but nothing here can say the tree is finished");
});

test("a cancel does not kill a process that predates the job it is cancelling", () => {
  // Windows never clears a parent link, so a reused pid inherits processes that
  // belonged to an earlier owner of that number. They are older than this job,
  // and killing them would be killing a stranger.
  const scenario = sweepScenario({ children: [{ pid: 4242, createdAt: BEFORE_START }] });
  const outcome = terminateProcessTree(1234, { ...scenario, notBefore: JOB_STARTED });

  assert.equal(outcome.orphansKilled, undefined, "nothing of this job's was found");
  assert.deepEqual(
    scenario.calls.filter((call) => call.command === "taskkill").map((call) => call.args[1]),
    ["1234"],
    "only the worker was killed"
  );
});

test("a cancel reports a tree it could not finish killing even when taskkill exited 0", () => {
  const scenario = sweepScenario({ children: [{ pid: 5678, createdAt: AFTER_START }], childSurvives: true });
  const outcome = terminateProcessTree(1234, { ...scenario, notBefore: JOB_STARTED });

  assert.equal(outcome.delivered, true, "the job's own worker is gone");
  assert.equal(outcome.treeIncomplete, true, "but something it started is not");
  assert.deepEqual(outcome.orphansRemaining, [5678]);
});

test("a cancel that cannot measure the tree keeps the caveat it used to give", () => {
  const scenario = sweepScenario({ listingFails: true });
  const outcome = terminateProcessTree(1234, {
    ...taskkillPartialFailure(),
    powerShellPath: FAKE_POWERSHELL,
    runCommandImpl(command, args) {
      return command === FAKE_POWERSHELL
        ? scenario.runCommandImpl(command, args)
        : taskkillPartialFailure().runCommandImpl(command, args);
    },
    isPidAlive: () => false,
    notBefore: JOB_STARTED
  });

  assert.equal(outcome.delivered, true);
  assert.equal(outcome.treeIncomplete, true, "unmeasured is reported as incomplete, not as clean");
});

test("a cancel with no job start time does not go looking for children at all", () => {
  // Without a start time there is nothing to tell this job's processes apart
  // from a stranger's, so the sweep must not run — not even to look.
  const scenario = sweepScenario({ children: [{ pid: 5678, createdAt: AFTER_START }] });
  terminateProcessTree(1234, scenario);

  assert.deepEqual(scenario.calls.map((call) => call.command), ["taskkill"]);
});

// The two below use real processes. Both are spawned detached: undetached, the
// probe joins the test runner’s own job object and Windows collects the child
// along with its parent, leaving nothing to measure.

function spawnProbeTree() {
  const parent = spawn(process.execPath, ["-e", [
    'const { spawn } = require("node:child_process");',
    'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore", detached: true });',
    "child.unref();",
    "console.log(child.pid);",
    "setTimeout(() => {}, 30000);"
  ].join("\n")], { stdio: ["ignore", "pipe", "ignore"], detached: true });

  return new Promise((resolve, reject) => {
    parent.stdout.on("data", (chunk) => resolve({ parentPid: parent.pid, childPid: Number(String(chunk).trim()) }));
    parent.on("error", reject);
    setTimeout(() => reject(new Error("the probe never reported its child")), 10_000).unref();
  });
}

test("a child is still findable through the pid of a parent that is already dead", {
  skip: process.platform !== "win32" && "windows-only"
}, async (t) => {
  // The whole design rests on this: Windows keeps the parent link, so a cancel
  // can ask what its worker started after killing that worker. If a future
  // Windows or Node stops answering, everything below silently finds nothing —
  // so it is pinned here rather than assumed.
  const { parentPid, childPid } = await spawnProbeTree();
  t.after(() => {
    for (const pid of [parentPid, childPid]) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
  });

  // No /T: the child must outlive its parent for there to be anything to find.
  runCommand("taskkill", ["/PID", String(parentPid), "/F"]);
  await delay(800);
  assert.equal(isPidAlive(parentPid), false, "the parent is gone");
  assert.equal(isPidAlive(childPid), true, "the child outlived it");

  const listing = listChildProcesses(parentPid);
  assert.equal(listing.available, true, "the query ran");
  assert.deepEqual(listing.children.map((child) => child.pid), [childPid]);
  assert.ok(Number.isFinite(listing.children[0].createdAt), "with a creation time to judge it by");
});

test("a cancel kills a real engine the tree walk never saw", {
  skip: process.platform !== "win32" && "windows-only"
}, async (t) => {
  // The leak is an engine the cancel did not reach. Waiting for the real one
  // would make this test a 3% coin flip, so the escape is staged instead:
  // everything is a real process and a real kill, with /T dropped from the
  // worker's taskkill so the child is exactly as unreachable as a leaked engine.
  const { parentPid, childPid } = await spawnProbeTree();
  t.after(() => {
    for (const pid of [parentPid, childPid]) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
  });

  const outcome = terminateProcessTree(parentPid, {
    notBefore: new Date(Date.now() - 60_000).toISOString(),
    runCommandImpl: (command, args, options) => runCommand(command, args.filter((arg) => arg !== "/T"), options)
  });

  assert.equal(outcome.delivered, true, "the worker is gone");
  assert.deepEqual(outcome.orphansKilled, [childPid], "and so is what it left behind");
  assert.ok(!outcome.treeIncomplete, "with nothing left to warn about");
  assert.equal(isPidAlive(childPid), false);
});
