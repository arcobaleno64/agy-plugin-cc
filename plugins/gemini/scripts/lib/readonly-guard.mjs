// Detect writes made by a turn the user asked to be read-only.
//
// WHY THIS CANNOT BE A PERMISSION CHECK
// ------------------------------------
// AGY has no read-only mode. `--write` here selects how the workspace is
// oriented (`--new-project` versus `--add-dir`), not what the model may do:
// headless print mode auto-approves file edits and shell commands either way,
// and an unoriented run can still write anywhere by absolute path. Both facts
// are measured and recorded in engine.mjs and docs/THREAT-MODEL.md 7.2.
//
// So this does not prevent a write. It makes one impossible to miss. A rescue
// dispatched without `--write` is documented as read-only, and a user reading
// that word is entitled to know when it turned out not to be true — whether the
// cause was a prompt injection in the reviewed repository or the model simply
// deciding to be helpful.
//
// Scope is the workspace's git working tree, which is also the only place a
// write can be reliably identified and undone. A workspace that is not a git
// repository cannot be compared, and that is reported rather than passed over:
// "not checked" and "checked, nothing changed" must never look alike.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getWorkingTreeState } from "./git.mjs";
import { runCommandChecked } from "./process.mjs";

function readIndex(cwd) {
  const output = runCommandChecked("git", ["ls-files", "--stage", "-z"], { cwd, shell: false, maxBuffer: 64 * 1024 * 1024 }).stdout;
  return new Map(output.split("\0").filter(Boolean).map((record) => {
    const separator = record.indexOf("\t");
    return [record.slice(separator + 1), record.slice(0, separator)];
  }));
}

function fingerprintWorktreePath(cwd, entry) {
  const absolute = path.join(cwd, entry);
  let descriptor;
  try {
    descriptor = fs.openSync(absolute, "r");
  } catch (error) {
    if (error?.code === "ENOENT") {
      try {
        const current = fs.lstatSync(absolute);
        if (current.isSymbolicLink()) return `link:${current.mode}:${fs.readlinkSync(absolute)}`;
      } catch (inspectError) {
        if (inspectError?.code !== "ENOENT") throw inspectError;
      }
      return "missing";
    }
    if (error?.code === "EISDIR") {
      const current = fs.lstatSync(absolute);
      if (!current.isDirectory()) throw error;
      return fingerprintSubmodule(absolute);
    }
    throw error;
  }
  try {
    const opened = fs.fstatSync(descriptor);
    const current = fs.lstatSync(absolute);
    if (current.isSymbolicLink()) return `link:${current.mode}:${fs.readlinkSync(absolute)}`;
    if (opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error(`Workspace path changed while it was being inspected: ${entry}`);
    }
    if (opened.isDirectory()) return fingerprintSubmodule(absolute);
    if (!opened.isFile()) return `other:${opened.mode}:${opened.size}`;

    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (let bytesRead; (bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0;) {
      hash.update(buffer.subarray(0, bytesRead));
    }
    return `file:${opened.mode}:${hash.digest("hex")}`;
  } finally {
    fs.closeSync(descriptor);
  }
}

function fingerprintSubmodule(cwd) {
  const head = runCommandChecked("git", ["rev-parse", "HEAD"], { cwd, shell: false }).stdout.trim();
  const state = snapshotWorkspace(cwd);
  if (!state.comparable) throw new Error(state.reason);
  return `directory:${crypto.createHash("sha256").update(JSON.stringify({ head, entries: state.entries, fingerprints: state.fingerprints })).digest("hex")}`;
}

function fingerprintEntry(cwd, entry, state, index) {
  const categories = [state.staged.includes(entry), state.unstaged.includes(entry), state.untracked.includes(entry)];
  return crypto.createHash("sha256")
    .update(JSON.stringify(categories)).update("\0")
    .update(index.get(entry) ?? "untracked").update("\0")
    .update(fingerprintWorktreePath(cwd, entry))
    .digest("hex");
}

/**
 * @returns {{ comparable: boolean, entries: string[], fingerprints: Record<string, string>, reason: string | null }}
 */
export function snapshotWorkspace(cwd) {
  try {
    const state = getWorkingTreeState(cwd);
    const entries = [...new Set([...state.staged, ...state.unstaged, ...state.untracked])].sort();
    const index = readIndex(cwd);
    return {
      comparable: true,
      entries,
      fingerprints: Object.fromEntries(entries.map((entry) => [entry, fingerprintEntry(cwd, entry, state, index)])),
      reason: null
    };
  } catch (error) {
    return {
      comparable: false,
      entries: [],
      fingerprints: {},
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Compare a later state against a snapshot.
 *
 * New dirty paths, changed fingerprints, and paths that disappeared from the
 * dirty set count. The comparison cannot attribute concurrent user actions, so
 * it reports every final-state change while the delegated turn was running.
 *
 * @returns {{ checked: boolean, written: string[], reason: string | null }}
 */
export function detectWrites(before, cwd) {
  if (!before?.comparable) {
    return { checked: false, written: [], reason: before?.reason ?? "no snapshot was taken" };
  }
  const after = snapshotWorkspace(cwd);
  if (!after.comparable) {
    return { checked: false, written: [], reason: after.reason };
  }
  const entries = new Set([...before.entries, ...after.entries]);
  return {
    checked: true,
    written: [...entries].filter((entry) => before.fingerprints?.[entry] !== after.fingerprints?.[entry]).sort(),
    reason: null
  };
}

/**
 * The sentence a user needs to see, or null when there is nothing to say.
 */
export function describeReadOnlyWrites(detection) {
  if (!detection) return null;
  if (!detection.checked) {
    return `Read-only turn: the workspace could not be compared before and after (${detection.reason}), so whether the delegated engine wrote anything is unknown. AGY has no enforced read-only mode; treat the workspace as possibly modified.`;
  }
  if (detection.written.length === 0) return null;
  const names = detection.written.slice(0, 10).join(", ");
  const rest = detection.written.length > 10 ? `, and ${detection.written.length - 10} more` : "";
  return `Read-only turn wrote to the workspace: ${names}${rest}. This run was dispatched without --write, but AGY has no enforced read-only mode — review these changes before keeping them (\`git status\`, \`git diff\`).`;
}
