import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { runCommand, runCommandChecked } from "./process.mjs";
import { isSecretFile, redactSecretsFromDiff, SECRET_DIFF_PLACEHOLDER } from "./secrets.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;

// Total review payload sent to the model. Far larger than transfer's 25,000,
// because a truncated review is a worse failure than an expensive one: a review
// that silently loses half its diff can return "looks good" about code it never
// saw. Truncation is therefore marked in the content itself so the model reports
// it and the user sees it. (docs/THREAT-MODEL.md 7.4)
const MAX_REVIEW_CONTENT_CHARS = 400_000;
const REVIEW_TRUNCATION_NOTICE =
  "\n\n[TRUNCATED: the diff exceeded the review size limit and was cut here. Say so in your summary — the remainder was NOT reviewed.]\n";

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options, shell: false });
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

function isSafeGitRef(ref) {
  // Reject a leading dash (git option injection) and shell metacharacters.
  return /^[A-Za-z0-9_][A-Za-z0-9._/~^@{}+-]*$/.test(String(ref));
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  if (baseRef != null && !isSafeGitRef(baseRef)) {
    throw new Error(`Invalid --base ref "${baseRef}". Use a plain git ref (no leading dash or shell metacharacters).`);
  }
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function capReviewContent(content) {
  if (content.length <= MAX_REVIEW_CONTENT_CHARS) return content;
  return content.slice(0, MAX_REVIEW_CONTENT_CHARS) + REVIEW_TRUNCATION_NOTICE;
}

// Whether following `absolutePath` stays inside `cwd`. Both sides are resolved
// first: `cwd` itself is routinely a symlinked path (macOS /tmp -> /private/tmp,
// and every test that runs under one), so comparing an unresolved cwd against a
// resolved target reports every file as an escape.
function resolvesInsideWorkspace(cwd, absolutePath) {
  let workspace;
  let target;
  try {
    workspace = fs.realpathSync.native(cwd);
    target = fs.realpathSync.native(absolutePath);
  } catch {
    return false;
  }
  const relative = path.relative(workspace, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);

  // An untracked secret file would otherwise be sent whole — worse than the diff
  // case, which at least only carries the changed lines.
  if (isSecretFile(relativePath)) {
    return `### ${relativePath}\n${SECRET_DIFF_PLACEHOLDER}`;
  }

  let stat;
  try {
    const linkStat = fs.lstatSync(absolutePath);
    if (linkStat.isSymbolicLink()) {
      if (!fs.existsSync(absolutePath)) {
        return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
      }
      // isSecretFile matched the link name, which the planter chooses. A symlink
      // called `notes.txt` pointing at ~/.ssh/id_rsa passed that check and was
      // then read through with readFileSync, sending the target's contents to
      // the model. Content only ever leaves the workspace being reviewed.
      if (!resolvesInsideWorkspace(cwd, absolutePath)) {
        return `### ${relativePath}\n(skipped: symlink resolves outside the workspace)`;
      }
    }
    stat = fs.statSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }

  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }

  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }

  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectWorkingTreeContext(cwd, state) {
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const staged = redactSecretsFromDiff(gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout);
  const unstaged = redactSecretsFromDiff(gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout);
  const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");

  const parts = [
    formatSection("Git Status", status),
    formatSection("Staged Diff", staged.text),
    formatSection("Unstaged Diff", unstaged.text),
    formatSection("Untracked Files", untrackedBody)
  ];

  return {
    mode: "working-tree",
    isEmpty:
      state.staged.length === 0 && state.unstaged.length === 0 && state.untracked.length === 0,
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    redactedFiles: [...staged.redactedFiles, ...unstaged.redactedFiles],
    content: capReviewContent(parts.join("\n"))
  };
}

function collectBranchContext(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  const commitRange = `${mergeBase}..HEAD`;
  const currentBranch = getCurrentBranch(cwd);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", commitRange]).stdout.trim();
  const branch = redactSecretsFromDiff(gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", commitRange]).stdout);

  return {
    mode: "branch",
    isEmpty: branch.text.trim() === "" && logOutput === "",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${mergeBase}.`,
    redactedFiles: branch.redactedFiles,
    content: capReviewContent([
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      formatSection("Branch Diff", branch.text)
    ].join("\n"))
  };
}

export function collectReviewContext(cwd, target) {
  const repoRoot = getRepoRoot(cwd);
  const state = getWorkingTreeState(cwd);
  const currentBranch = getCurrentBranch(cwd);
  let details;

  if (target.mode === "working-tree") {
    details = collectWorkingTreeContext(repoRoot, state);
  } else {
    details = collectBranchContext(repoRoot, target.baseRef);
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    ...details
  };
}
