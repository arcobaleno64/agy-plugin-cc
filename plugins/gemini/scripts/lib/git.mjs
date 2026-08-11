import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { runCommand, runCommandChecked } from "./process.mjs";
import { isSecretFile, redactSecretsFromDiff, splitDiffByFile, SECRET_DIFF_PLACEHOLDER } from "./secrets.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;

// Total review payload sent to the model. Far larger than transfer's 25,000,
// because a truncated review is a worse failure than an expensive one: a review
// that silently loses half its diff can return "looks good" about code it never
// saw. (docs/THREAT-MODEL.md 7.4)
const MAX_REVIEW_CONTENT_CHARS = 400_000;

// The budget is shared out per file rather than spent front-to-back. Spending it
// positionally meant one large file could evict every file after it: measured on
// a 5,200-line `data/questions.json` edit alongside one tracked source change and
// three untracked new files, the payload hit the cap inside the data file and the
// entire `## Untracked Files` section — plus the tracked `src/quiz.ts` change,
// which sorts after `data/` — never reached the model at all. The review came
// back `approve` having seen one file, and the only signal was a notice at
// character 400,000 that the model was asked to relay.
//
// A file allocated less than this is not worth sending: a few hundred characters
// of a diff cannot be reviewed, and pretending otherwise is the same silent
// failure in miniature. Such files are dropped and named instead.
const MIN_REVIEWABLE_FILE_CHARS = 400;

// Reserved for the always-included sections (status, commit log, diff stat) and
// for the truncation notice. Both are prepended or emitted whole, so without a
// reservation they are unbounded additions on top of a cap that only ever
// governed the diff. Unspent reservation returns to the files.
const MAX_REVIEW_OVERHEAD_CHARS = 100_000;
const TRUNCATION_NOTICE_RESERVE_CHARS = 20_000;

// spawnSync defaults to a 1 MiB buffer, and git output above it comes back as a
// raw ENOBUFS error — so a diff large enough to need budgeting used to kill the
// review before any of this ran, surfacing as an unclassified `spawnSync git
// ENOBUFS` crash. Sized well above the review cap: the raw diff is read in full
// and then budgeted down.
const MAX_GIT_BUFFER = 64 * 1024 * 1024;

function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, maxBuffer: MAX_GIT_BUFFER, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, maxBuffer: MAX_GIT_BUFFER, ...options, shell: false });
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

// Give every file a fair share of `budget`, letting files that need less than
// their share release the remainder to the ones that need more. Walking the
// files smallest-first makes one pass equivalent to repeated redistribution, and
// funds whole small files ahead of fragments of large ones.
//
// Returns one allocation per input size, in the input's order.
function allocateBudget(sizes, budget) {
  const allocation = new Array(sizes.length).fill(0);
  const ascending = sizes.map((size, index) => ({ index, size })).sort((left, right) => left.size - right.size);

  let remaining = Math.max(0, budget);
  let unfunded = ascending.length;
  for (const entry of ascending) {
    const share = Math.floor(remaining / unfunded);
    unfunded -= 1;
    if (entry.size <= share) {
      allocation[entry.index] = entry.size;
      remaining -= entry.size;
    } else if (share >= MIN_REVIEWABLE_FILE_CHARS) {
      allocation[entry.index] = share;
      remaining -= share;
    }
  }
  return allocation;
}

function fileLabel(unit, position) {
  return unit.path ?? `(file ${position + 1})`;
}

// `sections` are `{ title, units, separator }`; a unit is `{ path, text }`. The
// units of one section are rejoined with its separator, so a section whose files
// all fit is byte-identical to the unbudgeted text.
function budgetReviewSections(sections, overheadChars) {
  const units = sections.flatMap((section) => section.units);
  const allocation = allocateBudget(
    units.map((unit) => unit.text.length),
    MAX_REVIEW_CONTENT_CHARS - overheadChars
  );

  const truncatedFiles = [];
  const omittedFiles = [];
  const budgeted = units.map((unit, position) => {
    const allowed = allocation[position];
    if (allowed >= unit.text.length) return unit.text;

    const label = fileLabel(unit, position);
    if (allowed === 0) {
      omittedFiles.push(label);
      return null;
    }
    truncatedFiles.push(label);
    // The marker comes out of the file's own allocation. Charging it separately
    // would let a change spread over many truncated files overrun the cap by the
    // marker size times the file count.
    const marker = (kept) =>
      `\n[TRUNCATED: ${label} — only the first ${kept} of ${unit.text.length} characters are shown. The rest was NOT reviewed.]\n`;
    const kept = Math.max(0, allowed - marker(allowed).length);
    return unit.text.slice(0, kept) + marker(kept);
  });

  let cursor = 0;
  const rendered = sections.map((section) => {
    const parts = section.units.map(() => budgeted[cursor++]).filter((part) => part !== null);
    return { ...section, body: parts.join(section.separator) };
  });

  return { sections: rendered, truncatedFiles, omittedFiles };
}

// Stated at the top of the payload rather than once per omitted file: with
// enough omitted files the per-file stubs would themselves overrun the budget
// this exists to enforce.
function nameList(files, limit = 50) {
  const named = files.slice(0, limit);
  const rest = files.length - named.length;
  return `${named.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`;
}

function truncationNotice(truncatedFiles, omittedFiles) {
  if (truncatedFiles.length === 0 && omittedFiles.length === 0) return null;

  return [
    "[REVIEW INPUT TRUNCATED — this is NOT the whole change.]",
    // Both lists are capped. At the 400-char minimum allocation a single review
    // can carry ~1000 truncated paths, and an uncapped join here would put the
    // notice itself well past the budget it exists to announce.
    truncatedFiles.length > 0
      ? `Cut short (partially reviewable): ${nameList(truncatedFiles)}.`
      : null,
    omittedFiles.length > 0
      ? `Not included at all: ${nameList(omittedFiles)}.`
      : null,
    "Say so in your summary, and do not describe the change as a whole — the files above were NOT reviewed."
  ]
    .filter(Boolean)
    .join("\n");
}

// A plain-body section is normally tiny, but "normally" is not a bound: in a
// repository with a large unignored tree `git status --untracked-files=all` alone
// runs to megabytes. Charging such a body as overhead while still emitting it
// whole drove the file budget negative, which allocateBudget clamps to zero — so
// every file was dropped and the oversized status was sent anyway, the exact
// inversion of what the cap is for. Cap the bodies themselves.
function capSectionBody(title, body, allowed) {
  if (body.length <= allowed) return { body, truncated: false };
  const marker = (kept) =>
    `\n[TRUNCATED: ${title} — only the first ${kept} of ${body.length} characters are shown.]\n`;
  const kept = Math.max(0, allowed - marker(allowed).length);
  return { body: body.slice(0, kept) + marker(kept), truncated: true };
}

// `sections` are rendered in order. A section either carries a plain `body`
// (status, commit log, diff stat) or `units` to be budgeted per file. The plain
// bodies share a reserved slice of the cap; whatever they leave unspent returns
// to the files, so the common case where all three are a few hundred characters
// behaves exactly as before.
export function assembleReviewContent(sections) {
  const plainSections = sections.filter((section) => !section.units);
  const plainAllocation = allocateBudget(
    plainSections.map((section) => section.body.length),
    MAX_REVIEW_OVERHEAD_CHARS
  );
  const cappedBody = new Map();
  let overheadTruncated = false;
  plainSections.forEach((section, index) => {
    const capped = capSectionBody(section.title, section.body, plainAllocation[index]);
    cappedBody.set(section, capped.body);
    overheadTruncated ||= capped.truncated;
  });

  const overheadChars = sections.reduce(
    (total, section) => total + formatSection(section.title, section.units ? "" : cappedBody.get(section)).length,
    // The notice is prepended outside the file budget, so reserve room for it
    // rather than letting it push the total past the cap.
    TRUNCATION_NOTICE_RESERVE_CHARS
  );

  const fileSections = sections.filter((section) => section.units);
  const budgeted = budgetReviewSections(fileSections, overheadChars);
  const bodyBySection = new Map(budgeted.sections.map((section, index) => [fileSections[index], section.body]));

  const parts = sections.map((section) =>
    formatSection(section.title, section.units ? bodyBySection.get(section) : cappedBody.get(section))
  );

  const notice = truncationNotice(budgeted.truncatedFiles, budgeted.omittedFiles);
  return {
    content: notice ? `${notice}\n\n${parts.join("\n")}` : parts.join("\n"),
    // A cut-down status/commit log is incomplete input too, so it must set the
    // same flag even when every file fitted — that flag is what downgrades an
    // `approve` verdict.
    truncated: Boolean(notice) || overheadTruncated,
    truncatedFiles: budgeted.truncatedFiles,
    omittedFiles: budgeted.omittedFiles
  };
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
  const assembled = assembleReviewContent([
    { title: "Git Status", body: status },
    { title: "Staged Diff", units: splitDiffByFile(staged.text), separator: "" },
    { title: "Unstaged Diff", units: splitDiffByFile(unstaged.text), separator: "" },
    {
      title: "Untracked Files",
      units: state.untracked.map((file) => ({ path: file, text: formatUntrackedFile(cwd, file) })),
      separator: "\n\n"
    }
  ]);

  return {
    mode: "working-tree",
    isEmpty:
      state.staged.length === 0 && state.unstaged.length === 0 && state.untracked.length === 0,
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    redactedFiles: [...staged.redactedFiles, ...unstaged.redactedFiles],
    ...assembled
  };
}

function collectBranchContext(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  const commitRange = `${mergeBase}..HEAD`;
  const currentBranch = getCurrentBranch(cwd);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", commitRange]).stdout.trim();
  const branch = redactSecretsFromDiff(gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", commitRange]).stdout);

  const assembled = assembleReviewContent([
    { title: "Commit Log", body: logOutput },
    { title: "Diff Stat", body: diffStat },
    { title: "Branch Diff", units: splitDiffByFile(branch.text), separator: "" }
  ]);

  return {
    mode: "branch",
    isEmpty: branch.text.trim() === "" && logOutput === "",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${mergeBase}.`,
    redactedFiles: branch.redactedFiles,
    ...assembled
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
