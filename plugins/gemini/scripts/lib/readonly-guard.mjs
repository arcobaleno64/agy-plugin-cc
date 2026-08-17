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

import { getWorkingTreeState } from "./git.mjs";

/**
 * @returns {{ comparable: boolean, entries: string[], reason: string | null }}
 */
export function snapshotWorkspace(cwd) {
  try {
    const state = getWorkingTreeState(cwd);
    return {
      comparable: true,
      entries: [...state.staged, ...state.unstaged, ...state.untracked].sort(),
      reason: null
    };
  } catch (error) {
    return {
      comparable: false,
      entries: [],
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Compare a later state against a snapshot.
 *
 * Only additions count. A file that stopped being dirty (the user committed
 * mid-run, or a build removed a stray artifact) is not evidence that the
 * delegated turn wrote anything.
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
  const seen = new Set(before.entries);
  return { checked: true, written: after.entries.filter((entry) => !seen.has(entry)), reason: null };
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
