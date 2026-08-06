import fs from "node:fs";

// Two helpers, both with a caller. This file also held ensureAbsolutePath,
// createTempDir, readJsonFile, writeJsonFile and safeReadFile — none of which
// anything imported, in the plugin, the tests, the bench harness or the docs.
// They were removed in v0.16.7 rather than covered: an untested export with no
// caller is not a coverage gap, and keeping thin wrappers around one-line `fs`
// calls invites a future reader to route through them instead of the module
// that already does the job (state.mjs owns atomic JSON writes, for one).

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

export function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  return fs.readFileSync(0, "utf8");
}
