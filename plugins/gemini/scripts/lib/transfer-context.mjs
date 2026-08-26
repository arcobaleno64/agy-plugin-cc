import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

// Moved to lib/secrets.mjs so the review path shares one definition. Imported
// (not just re-exported) because this module calls it too, and re-exported
// because this is the existing public name.
import { isSecretFile } from "./secrets.mjs";
export { isSecretFile };

export function checkGitConflict(cwd = process.cwd()) {
  const gitDir = path.join(cwd, '.git');
  if (!fs.existsSync(gitDir)) return null;

  const conflictHeads = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD'];
  for (const head of conflictHeads) {
    if (fs.existsSync(path.join(gitDir, head))) {
      return head;
    }
  }
  return null;
}

// A snapshot's `gitDiff` field holds the entire uncommitted diff, so a snapshot
// that reaches version control publishes more than its author was looking at.
// Both READMEs claimed `.omc/` was excluded from version control; that exclusion
// lived only in this repository's own .gitignore, so in every other repository
// the file was merely *untracked* — visible in `git status` and swept up by
// `git add -A`.
//
// `*` inside `.omc/.gitignore` ignores the directory's contents and the ignore
// file itself, which is why nothing has to be added to the host repository's
// .gitignore. An existing file is left alone: it may say something deliberate,
// and this is not the place to decide it was wrong.
// `.omc` is created inside the workspace, but "inside" is a claim about names,
// not about where the bytes land. A junction or symlink named `.omc` sends every
// write and every delete somewhere else, and on Windows an unprivileged user can
// create one -- so a repository can ship its own. A snapshot carries the entire
// uncommitted diff, which makes that a way to publish the author's working tree
// to a location the repository chose, while the path reported back still reads
// as a directory inside the repository. Measured before this guard existed: the
// snapshot landed outside the repo and `snapshotPath` still said `.omc/transfers`.
//
// realpath resolves links on both sides, so containment is decided by where the
// write actually goes rather than by what it is called. Two things this is
// deliberately NOT:
//
//   * It is not a check that survives a live racer. This is check-then-use, and
//     a process that swaps a directory for a link between the check and the
//     write still wins. The threat it answers is a link committed into a
//     repository, which is present before the check and stays put.
//   * It is not a resolution of the target. A link is refused whether or not it
//     resolves, because a DANGLING link fails realpath with ENOENT -- and
//     reading "cannot resolve" as "not there yet" is exactly how `.gitignore`
//     slipped past the first version of this guard: `existsSync` follows the
//     link, finds nothing, and `writeFileSync` then creates the far-side file.
// Exported for tests only. The link check above preempts every fixture a test
// can build with symlinkSync, which left the containment predicate below with
// no case exercising it -- a mutation that made it always return survived the
// whole suite. It is still the invariant this function is named for, and it
// backstops anything lstat does not classify as a link but realpath relocates,
// so it is asserted directly rather than deleted for being hard to reach.
// The `lstatImpl` seam mirrors runCommandImpl/spawnImpl elsewhere in this repo.
// It exists for one branch: an lstat that fails with something other than ENOENT.
// EACCES, EPERM and ELOOP are the cases that decide whether this guard fails open
// or closed, and none of them can be constructed portably from a test -- a
// mutation that swallowed them survived the entire suite until this seam existed.
export function assertContained(root, target, label, { lstatImpl = fs.lstatSync } = {}) {
  let realRoot;
  try {
    realRoot = fs.realpathSync.native(root);
  } catch (error) {
    throw new Error(`Refusing to write ${label}: the workspace ${root} cannot be resolved (${error?.code ?? error}).`);
  }

  // lstat, not stat: the question is what the entry IS, not what it points at.
  // Only ENOENT is benign here. EACCES, EPERM and ELOOP all mean the guard could
  // not answer, and a guard that cannot answer must not say "contained" -- on
  // Windows a junction the process may traverse but not open reports exactly
  // that way, which would have let the original bug through unmitigated.
  let entry = null;
  try {
    entry = lstatImpl(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new Error(`Refusing to write ${label}: ${target} cannot be inspected (${error.code}).`);
    }
  }

  if (entry?.isSymbolicLink()) {
    throw new Error(
      `Refusing to write ${label}: ${target} is a link, so the write would land wherever it points. ` +
        `Remove it if you did not put it there.`
    );
  }

  // Nothing there yet: what has to be contained is the directory the create will
  // happen inside, which is the parent.
  const probe = entry ? target : path.dirname(target);
  let real;
  try {
    real = fs.realpathSync.native(probe);
  } catch (error) {
    if (error?.code === 'ENOENT') return; // The parent is absent too; mkdir will build it under root.
    throw new Error(`Refusing to write ${label}: ${probe} cannot be resolved (${error.code}).`);
  }

  const relative = path.relative(realRoot, real);
  // An empty relative path means `real` IS the workspace root, which is contained.
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return;
  throw new Error(
    `Refusing to write ${label}: it resolves to ${real}, outside the workspace ${realRoot}. ` +
      `Remove the link at ${target} if you did not put it there.`
  );
}

// `root` is optional so the existing exported signature still works for callers
// that only want the file created. buildTransferSnapshot passes it, because
// `.gitignore` is reached by name inside a directory this module just checked --
// and a name is what the whole guard exists to distrust.
export function ensureOmcIgnored(omcDir, root = null) {
  const ignoreFile = path.join(omcDir, '.gitignore');
  if (root) assertContained(root, ignoreFile, '.omc/.gitignore');
  if (fs.existsSync(ignoreFile)) return ignoreFile;
  fs.mkdirSync(omcDir, { recursive: true });
  fs.writeFileSync(ignoreFile, '*\n', 'utf8');
  return ignoreFile;
}

export function pruneOldTransfers(transfersDir, maxKeep = 20) {
  if (!fs.existsSync(transfersDir)) return;
  try {
    const files = fs.readdirSync(transfersDir)
      .filter((f) => f.startsWith('transfer-') && f.endsWith('.json'))
      .map((f) => {
        const fullPath = path.join(transfersDir, f);
        const stat = fs.statSync(fullPath);
        return { fullPath, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > maxKeep) {
      const toRemove = files.slice(maxKeep);
      for (const item of toRemove) {
        try {
          fs.unlinkSync(item.fullPath);
        } catch {
          // Ignore individual deletion error
        }
      }
    }
  } catch {
    // Ignore pruning errors
  }
}

export function collectGitContext(cwd = process.cwd()) {
  const conflict = checkGitConflict(cwd);
  if (conflict) {
    throw new Error(`Cannot export transfer snapshot: Git repository is in conflict state (${conflict}). Resolve conflicts first.`);
  }

  // Force shell: false for Git process boundary hardening
  const execOpts = {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
    maxBuffer: 5 * 1024 * 1024,
  };

  let statusOutput = '';
  try {
    statusOutput = execFileSync('git', ['status', '-s'], execOpts).trim();
  } catch {
    statusOutput = '';
  }

  let diffFiles = [];
  try {
    const rawFileList = execFileSync('git', ['diff', '--name-only'], execOpts).trim();
    if (rawFileList) {
      diffFiles = rawFileList.split('\n').map((f) => f.trim()).filter(Boolean);
    }
  } catch {
    diffFiles = [];
  }

  let diffSummary = [];
  let totalChars = 0;
  const MAX_FILE_CHARS = 5000;
  const MAX_TOTAL_CHARS = 25000;

  for (const file of diffFiles) {
    if (isSecretFile(file)) {
      diffSummary.push(`--- a/${file}\n+++ b/${file}\n[REDACTED SECRET FILE CONTENT]`);
      continue;
    }

    if (totalChars >= MAX_TOTAL_CHARS) {
      diffSummary.push(`[TRUNCATED: Remaining files omitted due to size limit]`);
      break;
    }

    try {
      const fileDiff = execFileSync('git', ['diff', '--', file], execOpts).trim();
      if (!fileDiff) continue;

      if (fileDiff.length > MAX_FILE_CHARS) {
        const truncated = fileDiff.slice(0, MAX_FILE_CHARS) + '\n[TRUNCATED: Single file diff exceeded 5000 characters]';
        diffSummary.push(truncated);
        totalChars += truncated.length;
      } else {
        diffSummary.push(fileDiff);
        totalChars += fileDiff.length;
      }
    } catch {
      // Ignore single file diff error
    }
  }

  return {
    status: statusOutput,
    diff: diffSummary.join('\n\n'),
    hasChanges: Boolean(statusOutput || diffSummary.length),
  };
}

export function buildTransferSnapshot({ engine = 'auto', model = null, effort = null, instructions = '', cwd = process.cwd() }) {
  if (model && effort) {
    throw new Error('Model selection and reasoning effort are mutually exclusive; specify either --model or --effort, not both.');
  }

  const gitContext = collectGitContext(cwd);

  if (!gitContext.hasChanges && !instructions.trim()) {
    throw new Error('Working tree is clean and no instructions were provided. Please specify instructions to transfer.');
  }

  const transferId = 'transfer-' + crypto.randomBytes(4).toString('hex');
  const timestamp = new Date().toISOString();

  const snapshot = {
    transferId,
    timestamp,
    engine,
    model: model || null,
    effort: effort || null,
    cwd,
    instructions: instructions.trim() || 'Hand off current workspace state and continue work.',
    gitStatus: gitContext.status,
    gitDiff: gitContext.diff,
  };

  const omcDir = path.join(cwd, '.omc');
  // Before anything is created -- a pre-existing `.omc` link has to be caught
  // while it is still the only thing that has been touched.
  assertContained(cwd, omcDir, '.omc');
  const transfersDir = path.join(omcDir, 'transfers');
  fs.mkdirSync(transfersDir, { recursive: true });
  // And again once it exists: `transfers` can be the link instead of `.omc`, and
  // mkdirSync with recursive:true walks through an existing one without complaint.
  assertContained(cwd, transfersDir, '.omc/transfers');
  ensureOmcIgnored(omcDir, cwd);

  // LRU Pruning of old snapshots
  pruneOldTransfers(transfersDir, 20);

  const snapshotPath = path.join(transfersDir, `${transferId}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');

  return { snapshot, snapshotPath };
}
