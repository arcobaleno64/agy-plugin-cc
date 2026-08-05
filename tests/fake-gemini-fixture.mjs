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
  const sep = process.platform === "win32" ? ";" : ":";
  const home = path.join(binDir, "agy-home");
  fs.mkdirSync(path.join(home, ".gemini", "antigravity-cli", "brain"), { recursive: true });
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`,
    HOME: home,
    USERPROFILE: home,
    GEMINI_ENGINE: "agy",
    GEMINI_HOME: path.join(home, ".gemini")
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

export function buildEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`,
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
  const sep = process.platform === "win32" ? ";" : ":";
  const env = { ...process.env };
  // Must resolve to "auto" regardless of the calling shell's own engine
  // preference (e.g. a developer's GEMINI_ENGINE=agy), so delete it rather
  // than inherit it.
  delete env.GEMINI_ENGINE;
  return {
    ...env,
    PATH: `${binDir}${sep}${process.env.PATH}`,
    GEMINI_HOME: path.join(binDir, "gemini-home"),
    GEMINI_COMPANION_DISABLE_KEYCHAIN: "1"
  };
}

export function readFakeState(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-gemini-state.json"), "utf8"));
}
