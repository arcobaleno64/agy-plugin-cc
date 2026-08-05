import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  terminateProcessTree,
  binaryAvailable,
  formatCommandFailure,
  resolveBinaryPath,
  resolveNodeShimEntry,
  runCommand,
  quoteForWindowsShell
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
