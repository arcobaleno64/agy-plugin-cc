// Preloaded by `npm test` via --import, before any test file is evaluated.
//
// Job state lives under CLAUDE_PLUGIN_DATA, which Claude Code sets — so a suite
// run from inside a Claude Code session inherited the real one, and every temp
// workspace a test created got a permanent state directory in the user's own
// plugin data. Measured on the machine this was found on: 9651 directories under
// .../plugins/data/gemini-gemini-plugin-cc/state, 9626 of them named
// `gemini-plugin-test*`, holding 40088 job files. They are never reclaimed —
// pruneJobStore bounds jobs within a workspace, and nothing bounds the number of
// workspaces.
//
// Both names are set here, not just one: GEMINI_COMPANION_DATA takes priority in
// state.mjs, so leaving a developer's own override in place would defeat this.
//
// Individual tests still override these (state.test.mjs pins the precedence
// rules, and several suites point at their own data dir); they save and restore
// around their cases, which now restores to this directory rather than the real
// one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-plugin-state-"));
process.env.CLAUDE_PLUGIN_DATA = dir;
process.env.GEMINI_COMPANION_DATA = dir;

// The test runner passes its own execArgv down, so this module is evaluated once
// per test-file process, and each gets its own directory to clean up. That is why
// the cleanup can be unconditional: nothing here is shared between files.
//
// Best effort. A detached worker a test spawned may still hold a handle, which
// on Windows makes the directory undeletable; the OS reclaims temp either way,
// and failing here would fail an otherwise passing run.
process.on("exit", () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // left for the OS
  }
});
