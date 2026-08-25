import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { writeExecutable } from "./helpers.mjs";

const FAKE_SOURCE = fileURLToPath(new URL("./fixtures/fake-gemini.cjs", import.meta.url));

// Install a fake gemini CLI into binDir and mark binDir as an authenticated
// gemini home. `scenario` selects the canned response (see fixtures/fake-gemini.cjs).
export function installFakeGemini(binDir, scenario = "task") {
  const target = path.join(binDir, "gemini");
  fs.copyFileSync(FAKE_SOURCE, target);
  if (process.platform === "win32") {
    // npm global bins resolve through a .cmd shim under shell:true on Windows.
    fs.writeFileSync(path.join(binDir, "gemini.cmd"), `@echo off\r\nnode "%~dp0gemini" %*\r\n`, "utf8");
  } else {
    fs.chmodSync(target, 0o755);
  }

  fs.writeFileSync(
    path.join(binDir, "fake-gemini-config.json"),
    JSON.stringify({ scenario }, null, 2),
    "utf8"
  );

  writeGeminiCredentials(binDir);
}

// Shadow any real gemini/agy on PATH with wrappers that fail their --version
// probe, so getGeminiAvailability/getAgyAvailability report "not available".
export function installUnavailableEngines(binDir) {
  for (const name of ["gemini", "agy"]) {
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(binDir, `${name}.cmd`), `@echo off\r\nexit /b 1\r\n`, "utf8");
    } else {
      writeExecutable(path.join(binDir, name), "#!/bin/sh\nexit 1\n");
    }
  }
}

export function writeGeminiCredentials(binDir) {
  const geminiHome = path.join(binDir, "gemini-home");
  fs.mkdirSync(geminiHome, { recursive: true });
  fs.writeFileSync(
    path.join(geminiHome, "oauth_creds.json"),
    JSON.stringify({ access_token: "fake", expiry_date: Date.now() + 86_400_000 }, null, 2),
    "utf8"
  );
  return geminiHome;
}

export function removeGeminiCredentials(binDir) {
  fs.rmSync(path.join(binDir, "gemini-home", "oauth_creds.json"), { force: true });
}

// Write ~/.gemini/settings.json with the given auth type so getGeminiPlanTier()
// can classify the plan (e.g. "oauth-personal" => personal, EOL 2026-06-18).
export function writeGeminiSettings(binDir, selectedType = "oauth-personal") {
  const geminiHome = path.join(binDir, "gemini-home");
  fs.mkdirSync(geminiHome, { recursive: true });
  fs.writeFileSync(
    path.join(geminiHome, "settings.json"),
    JSON.stringify({ security: { auth: { selectedType } } }, null, 2),
    "utf8"
  );
  return geminiHome;
}

// Write OAuth credentials whose expiry_date is already in the past so
// getGeminiLoginStatus() reports loggedIn:false (expired token).
export function writeExpiredGeminiCredentials(binDir) {
  const geminiHome = path.join(binDir, "gemini-home");
  fs.mkdirSync(geminiHome, { recursive: true });
  fs.writeFileSync(
    path.join(geminiHome, "oauth_creds.json"),
    JSON.stringify({ access_token: "fake", expiry_date: Date.now() - 3_600_000 }, null, 2),
    "utf8"
  );
  return geminiHome;
}

// Install a fake `agy` binary that succeeds on its --version probe so
// getAgyAvailability() reports available:true. Does not install gemini.
export function installFakeAgy(binDir) {
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "agy.cmd"), `@echo off\r\necho agy 1.0.0\r\nexit /b 0\r\n`, "utf8");
  } else {
    writeExecutable(path.join(binDir, "agy"), "#!/bin/sh\necho 'agy 1.0.0'\nexit 0\n");
  }
}

// POSIX integration fixture for AGY transport tests. It records argv/stdin,
// emits a decoy stdout response, and writes a completed transcript so tests can
// prove that transport changes do not weaken transcript-authoritative recovery.
export function installCapturingAgyExecutable(binDir, { version = "1.1.2" } = {}) {
  if (process.platform === "win32") {
    throw new Error("The capturing AGY fixture uses a POSIX shebang; Windows is covered by live AGY smoke tests.");
  }

  const source = [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const version = ${JSON.stringify(version)};`,
    "const args = process.argv.slice(2);",
    'if (args.length === 1 && args[0] === "--version") { process.stdout.write(version + "\\n"); process.exit(0); }',
    'const stdin = fs.readFileSync(0, "utf8");',
    "const capturePath = process.env.FAKE_AGY_CAPTURE;",
    'if (!capturePath) { process.stderr.write("FAKE_AGY_CAPTURE is required\\n"); process.exit(2); }',
    "fs.mkdirSync(path.dirname(capturePath), { recursive: true });",
    'fs.writeFileSync(capturePath, JSON.stringify({ args, stdin }, null, 2) + "\\n", "utf8");',
    'const home = process.env.HOME || process.env.USERPROFILE || ".";',
    'const conv = "fake-" + Date.now() + "-" + process.pid;',
    'const logDir = path.join(home, ".gemini", "antigravity-cli", "brain", conv, ".system_generated", "logs");',
    "fs.mkdirSync(logDir, { recursive: true });",
    'const row = { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: process.env.FAKE_AGY_RESPONSE || "FAKE_AGY_TRANSCRIPT_OK", thinking: "fixture reasoning" };',
    'fs.writeFileSync(path.join(logDir, "transcript_full.jsonl"), JSON.stringify(row) + "\\n", "utf8");',
    'process.stdout.write(process.env.FAKE_AGY_STDOUT || "FAKE_AGY_STDOUT_DECOY\\n");',
    // AGY >=1.1.8 exits non-zero alongside its ERROR envelope; let callers say so.
    "process.exit(Number(process.env.FAKE_AGY_EXIT || 0));"
  ].join("\n");

  writeExecutable(path.join(binDir, "agy"), source);
}

// Install an executable AGY stand-in that passes the --version probe, then
// fails the real print invocation without creating a transcript. Windows AGY
// must resolve to an absolute .exe, so a copied Node executable provides a
// safe, deterministic non-zero unknown-option response there.
//
// Windows caveat: that copied node.exe answers --version with Node's own
// version, which parses as a very new AGY, so the run takes the >=1.1.8
// structured path rather than transcript recovery. The stand-in cannot report a
// chosen version — an absolute .exe is required, and a .cmd shim is refused on
// purpose (CVE-2024-27980). Match on the generic rejection rather than a
// specific flag name, since which flag node rejects first tracks argv order.
export function installFailingAgyExecutable(binDir) {
  if (process.platform === "win32") {
    fs.copyFileSync(process.execPath, path.join(binDir, "agy.exe"));
    return /bad option:/i;
  }

  writeExecutable(
    path.join(binDir, "agy"),
    "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'agy 1.1.2'; exit 0; fi\necho 'AGY fixture failed server-side' >&2\nexit 23\n"
  );
  return /AGY fixture failed server-side/i;
}

export function buildFailingAgyEnv(binDir) {
  const home = path.join(binDir, "agy-home");
  fs.mkdirSync(path.join(home, ".gemini", "antigravity-cli", "brain"), { recursive: true });
  return {
    // This builder was the one the three isolation fixes above never reached. It
    // prepended to PATH rather than closing it, which is the exact defect
    // 4b39509 was written to fix -- and the `--engine agy` tests below it run a
    // stand-in that a developer machine with a real agy installed can resolve
    // past, spending a real turn on a test asserting a fixture's stderr.
    ...inheritedEnvWithoutCredentials(),
    PATH: pathWithoutRealEngines(binDir),
    HOME: home,
    USERPROFILE: home,
    GEMINI_ENGINE: "agy",
    GEMINI_HOME: path.join(home, ".gemini"),
    GEMINI_COMPANION_DISABLE_KEYCHAIN: "1"
  };
}

// Shadow only gemini with a wrapper that fails its --version probe, leaving any
// installed agy untouched. Pair with installFakeAgy for AGY-availability assertions.
export function installUnavailableGemini(binDir) {
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "gemini.cmd"), `@echo off\r\nexit /b 1\r\n`, "utf8");
  } else {
    writeExecutable(path.join(binDir, "gemini"), "#!/bin/sh\nexit 1\n");
  }
}

// Shadow only agy with a wrapper that fails its --version probe, leaving any
// fake gemini untouched. Pair with installFakeGemini to assert that explicit
// `--engine agy` readiness does not inherit Gemini's ready state.
export function installUnavailableAgy(binDir) {
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "agy.cmd"), `@echo off\r\nexit /b 1\r\n`, "utf8");
  } else {
    writeExecutable(path.join(binDir, "agy"), "#!/bin/sh\nexit 1\n");
  }
}

const PATH_SEP = process.platform === "win32" ? ";" : ":";

// Every entry PATHEXT would try for a bare command name on Windows, plus the
// bare name itself for POSIX.
const EXECUTABLE_SUFFIXES = process.platform === "win32"
  ? ["", ".com", ".exe", ".bat", ".cmd"]
  : [""];

function directoryHoldsCommand(dir, command) {
  return EXECUTABLE_SUFFIXES.some((suffix) => {
    try {
      return fs.statSync(path.join(dir, `${command}${suffix}`)).isFile();
    } catch {
      return false;
    }
  });
}

// Prepending binDir is not enough to make a stand-in the only gemini/agy a child
// process can reach. It relies on every layer below — `where.exe`, cmd.exe's own
// PATHEXT walk, and each caller's resolution — agreeing to stop at the first
// match, and a full-suite run has produced `agy.available: true` against a stub
// that does nothing but `exit 1`. The developer machine that reproduced it has a
// real agy installed; CI does not, which is why the suite was green there and
// intermittently red here.
//
// So close the door instead of racing for the front of the queue: drop any PATH
// directory that holds a real gemini or agy. Nothing else is removed, so the
// child still finds node, git and the system tools it needs.
export function pathWithoutRealEngines(binDir, inherited = process.env.PATH) {
  const kept = String(inherited ?? "")
    .split(PATH_SEP)
    .filter(Boolean)
    .filter((dir) => !["gemini", "agy"].some((command) => directoryHoldsCommand(dir, command)));
  return [binDir, ...kept].join(PATH_SEP);
}

// GEMINI_API_KEY / GOOGLE_API_KEY outrank every stored credential -- that is the
// CLI's real precedence, and `hasGeminiCredentials` reproduces it deliberately.
// So a fixture that inherits one has already answered the question it was built
// to ask: an "unauthenticated" stand-in reports ready, and the setup fixtures
// fail on any machine that exports a key while staying green on CI, which has
// none. This is the same leak already closed for PATH, the keychain and
// GEMINI_ENGINE; the key was the one left open.
function inheritedEnvWithoutCredentials() {
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  return env;
}

export function buildEnv(binDir) {
  return {
    ...inheritedEnvWithoutCredentials(),
    PATH: pathWithoutRealEngines(binDir),
    GEMINI_ENGINE: "gemini",
    GEMINI_HOME: path.join(binDir, "gemini-home"),
    // These fixtures control credentials through GEMINI_HOME. Without this the
    // credential check would also probe the OS keychain of whatever machine is
    // running the suite, so a developer with a real gemini API key stored would
    // see "unauthenticated" fixtures report as ready.
    GEMINI_COMPANION_DISABLE_KEYCHAIN: "1"
  };
}

// Like buildEnv but does not force an engine and points GEMINI_HOME at an empty
// directory; pair with installUnavailableEngines for "not ready" assertions.
export function buildEnvUnavailable(binDir) {
  const env = inheritedEnvWithoutCredentials();
  // Must resolve to "auto" regardless of the calling shell's own engine
  // preference (e.g. a developer's GEMINI_ENGINE=agy), so delete it rather
  // than inherit it.
  delete env.GEMINI_ENGINE;
  return {
    ...env,
    PATH: pathWithoutRealEngines(binDir),
    GEMINI_HOME: path.join(binDir, "gemini-home"),
    GEMINI_COMPANION_DISABLE_KEYCHAIN: "1"
  };
}

export function readFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-gemini-state.json"), "utf8"));
}
