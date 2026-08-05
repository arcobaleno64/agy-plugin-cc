import test from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

import {
  terminateProcessTree,
  binaryAvailable,
  formatCommandFailure,
  resolveBinaryPath,
  runCommand,
  quoteForWindowsShell
} from "../plugins/gemini/scripts/lib/process.mjs";

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
    // Bare command name, so runCommand takes the shell:true branch on Windows.
    const result = runCommand("node", ["-p", "JSON.stringify(process.argv.slice(1))", value]);
    assert.equal(result.status, 0, `${JSON.stringify(value)}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout.trim()), [value]);
  }
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
